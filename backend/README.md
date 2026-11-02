# CPU assistant backend

This service reuses the catalogue's source prompt, request limits, origin checks
and streaming response format. It calls a native, CPU-only Liquid LFM2.5-1.2B
model through Ollama. Visitors download no generation model. Their question,
recent chat turns and retrieved source excerpts are sent to this server.

The model weights occupy about 730 MB. Allow at least 4 GB RAM for the service
and runtime. A local CPU test on an Intel Core Ultra 7 255U took 7.3 seconds,
including model loading, for a 31-token health answer. This is one measured
example, not a throughput guarantee. A request through the full source-aware
backend produced its first token in 5.9 seconds and finished in 12.6 seconds in
a second local test.

Install Node.js 22 or newer and [Ollama](https://ollama.com/). From the repository
root, run:

    ollama pull hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:latest
    ollama create accreu-assistant -f backend/Modelfile
    node backend/server.mjs

`backend/Modelfile` explicitly disables GPU use and sets six CPU threads, a
4,096-token context and a 240-token answer limit. Keep Ollama on its default
loopback interface; expose only this catalogue service through HTTPS.

For local testing, serve the catalogue on port 8000 and open:

    http://127.0.0.1:8000/?assistant=http://127.0.0.1:8787

The service listens on `127.0.0.1:8787` by default. `HOST` and `PORT` change that
address. Put a reverse proxy in front of it for a public deployment, with TLS,
request limits and a service manager. If `TRUST_PROXY=1`, the proxy must overwrite
`X-Forwarded-For` with the client address; otherwise the backend uses the socket
address for its rate limit. Do not expose the backend port around that proxy.

Set `window.ACCREU_ASSISTANT_URL` in `assets/agent-config.js` to the public HTTPS
address after deploying the service. GitHub Pages cannot run this backend. The
public catalogue retains source quotations until an endpoint is configured.

The upstream protocol is OpenAI-compatible. To use a LiteRT-LM server instead,
set `INFERENCE_URL` to its `/v1/chat/completions` URL and `MODEL` to its registered
model name. This adapter is tested with Ollama; LiteRT-LM has not been benchmarked
in this package. `INFERENCE_API_KEY` supplies an upstream token if required.

Run the checks with:

    node --test tests/*.test.mjs
