import http from "node:http";
import handler from "./api/index.js";

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 64 * 1024;

function wrapResponse(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = value => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(value));
    return res;
  };
  return res;
}

http.createServer((req, res) => {
  wrapResponse(res);
  let size = 0;
  const chunks = [];
  req.on("data", chunk => {
    size += chunk.length;
    if (size > MAX_BODY) { res.status(413).json({ error: "Payload too large" }); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on("end", async () => {
    if (res.writableEnded) return;
    try {
      req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }
    try {
      await handler(req, res);
    } catch (error) {
      console.error("Unhandled error:", error?.message);
      if (!res.writableEnded) res.status(500).json({ error: "Internal error" });
    }
  });
}).listen(PORT, HOST, () => console.log(`alice webhook on ${HOST}:${PORT}`));
