import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import worker from "../worker/src/index.js";

// Reuse the catalogue's CORS, limits, source prompt and streaming protocol.
const env = {
  INFERENCE_URL: process.env.INFERENCE_URL || "http://127.0.0.1:11434/v1/chat/completions",
  INFERENCE_API_KEY: process.env.INFERENCE_API_KEY,
  MODELS: process.env.MODEL || "accreu-assistant",
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || "https://iiasa.github.io,http://127.0.0.1:8000,http://localhost:8000",
};

export const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 65536) {
        outgoing.writeHead(413).end("Request too large");
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    // Do not trust a caller-supplied Cloudflare IP header on a native server.
    const proxyIP = process.env.TRUST_PROXY === "1" ? incoming.headers["x-forwarded-for"]?.split(",")[0].trim() : null;
    headers.set("CF-Connecting-IP", proxyIP || incoming.socket.remoteAddress || "local");
    const request = new Request(`http://127.0.0.1${incoming.url}`, {
      method: incoming.method,
      headers,
      ...(!["GET", "HEAD"].includes(incoming.method) ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await worker.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const stream = Readable.fromWeb(response.body);
      outgoing.on("close", () => stream.destroy());
      stream.on("error", () => outgoing.destroy());
      stream.pipe(outgoing);
    } else outgoing.end();
  } catch (error) {
    if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ error: "The assistant could not handle this request." }));
    console.error(error.message);
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () => console.log(`ACCREU CPU backend listening on http://${host}:${port}`));
}
