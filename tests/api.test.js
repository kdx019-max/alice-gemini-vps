import test from "node:test";
import assert from "node:assert/strict";
import { aliceResponse, fitAliceText, isSearchIntent, safeHistory } from "../api/index.js";

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].text, "4");
  assert.equal(result[7].text, "11");
});

test("GET health check returns an ok response", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "GET" }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-gemini-serper");
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command: "" }, state: { session: { history: [] } } } }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.match(payload.response.text, /Привет/);
  assert.equal(payload.response.end_session, false);
});

function mockRes() {
  const res = {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return value; },
    setHeader() {}
  };
  return res;
}

test("Yandex ping health check is answered without calling Gemini", async () => {
  const handler = (await import("../api/index.js")).default;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("fetch must not be called"); };
  try {
    const res = mockRes();
    await handler({ method: "POST", body: { request: { command: "ping", original_utterance: "ping" } } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.response.text, "pong");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requests from another skill are rejected when ALICE_SKILL_ID is set", async () => {
  const handler = (await import("../api/index.js")).default;
  process.env.ALICE_SKILL_ID = "expected-skill";
  try {
    const res = mockRes();
    await handler({ method: "POST", body: { session: { skill_id: "other-skill" }, request: { command: "привет" } } }, res);
    assert.equal(res.statusCode, 403);

    const ok = mockRes();
    await handler({ method: "POST", body: { session: { skill_id: "expected-skill" }, request: { command: "" } } }, ok);
    assert.equal(ok.statusCode, 200);
    assert.match(ok.payload.response.text, /Привет/);
  } finally {
    delete process.env.ALICE_SKILL_ID;
  }
});

test("Gemini timeout returns the time-budget message", async () => {
  const handler = (await import("../api/index.js")).default;
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = async () => { throw new DOMException("This operation was aborted", "AbortError"); };
  try {
    const res = mockRes();
    await handler({ method: "POST", body: { request: { command: "Расскажи сказку" } } }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.payload.response.text, /Не успела подготовить ответ/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

test("goodbye phrases close the session, follow-up questions do not", async () => {
  const { isGoodbye } = await import("../api/index.js");
  for (const phrase of ["спасибо", "Спасибо, пока!", "пока", "всё", "всё, спасибо", "до свидания"]) {
    assert.equal(isGoodbye(phrase), true, phrase);
  }
  for (const phrase of ["спасибо а расскажи еще", "пока не знаю", "все планеты солнечной системы"]) {
    assert.equal(isGoodbye(phrase), false, phrase);
  }
  const handler = (await import("../api/index.js")).default;
  const res = mockRes();
  await handler({ method: "POST", body: { request: { command: "спасибо пока", original_utterance: "Спасибо, пока" } } }, res);
  assert.equal(res.payload.response.end_session, true);
});

test("thinking budget is sent only when configured", async () => {
  const { geminiGenerationConfig } = await import("../api/index.js");
  assert.equal(geminiGenerationConfig().thinkingConfig, undefined);
  assert.equal(geminiGenerationConfig().maxOutputTokens, 400);
  process.env.GEMINI_THINKING_BUDGET = "0";
  try {
    assert.deepEqual(geminiGenerationConfig().thinkingConfig, { thinkingBudget: 0 });
  } finally {
    delete process.env.GEMINI_THINKING_BUDGET;
  }
});

test("fallback model answer is used when the primary model fails", async () => {
  const { askGeminiWithFallback } = await import("../api/index.js");
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, { GEMINI_API_KEY: "test-key", GEMINI_MODEL: "primary-model", GEMINI_FALLBACK_MODEL: "fallback-model", GEMINI_THINKING_BUDGET: "0" });
  const bodies = {};
  globalThis.fetch = async (url, options) => {
    const model = url.includes("primary-model") ? "primary" : "fallback";
    bodies[model] = JSON.parse(options.body);
    if (model === "primary") throw new DOMException("This operation was aborted", "AbortError");
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Ответ запасной модели." }] } }] }), { status: 200 });
  };
  try {
    assert.equal(await askGeminiWithFallback("вопрос", [], "", 1000), "Ответ запасной модели.");
    assert.deepEqual(bodies.primary.generationConfig.thinkingConfig, { thinkingBudget: 0 });
    assert.equal(bodies.fallback.generationConfig.thinkingConfig, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of ["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_FALLBACK_MODEL", "GEMINI_THINKING_BUDGET"]) delete process.env[k];
  }
});
