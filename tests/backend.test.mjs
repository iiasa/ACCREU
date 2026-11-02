import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

test("CPU backend streams grounded prompts and rejects invalid requests", async () => {
  let received;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"Mortality is a health topic [1]."}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.INFERENCE_URL = `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`;
  const { server } = await import("../backend/server.mjs");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/chat`;
  const request = (body, origin = "http://127.0.0.1:8000") => fetch(url, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body,
  });
  try {
    const response = await request(JSON.stringify({
      question: "Which health data?",
      sources: [{ title: "Excess mortality", kind: "Dataset", meta: "D2.7 Health risks", text: "Deaths from pollution. ".repeat(300) }],
    }));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Mortality is a health topic \[1\]/);
    assert.equal(received.model, "accreu-assistant");
    assert.equal(received.max_tokens, 240);
    assert.match(received.messages.at(-1).content, /D2\.7 Health risks/);
    assert(received.messages.at(-1).content.length < 1200);
    assert.equal((await request("{}", "https://untrusted.example")).status, 403);
    assert.equal((await request("not json")).status, 400);
    assert.equal((await request("null")).status, 400);
    assert.equal((await request('{"question":"health","sources":[null]}')).status, 400);
    assert.equal((await request("{}")).status, 400);
    assert.equal((await request("x".repeat(65537))).status, 413);
  } finally {
    server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]);
    delete process.env.INFERENCE_URL;
  }
});
