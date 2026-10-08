// Shared loader for the assistant's language model, used by the page
// (assets/agent.js) and by the knowledge builder (tools/embed.html), so both
// produce identical vectors.
//
// Everything is served from this site: the transformers.js runtime in
// assets/vendor/transformers/ and the model (BAAI bge-small-en-v1.5, MIT
// licence, 8-bit ONNX) in assets/models/. Nothing is fetched from a CDN or
// from Hugging Face, and the browser caches the files after the first visit.
// The model runs in a Web Worker (ai-worker.js), so the page stays responsive
// while it loads and works.

export const MODEL_ID = "Xenova/bge-small-en-v1.5";
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

let embedderPromise = null;
const progressListeners = new Set();

// Resolves to embed(texts) -> array of normalized 384-d vectors.
export function loadEmbedder(onProgress) {
  if (onProgress) progressListeners.add(onProgress);
  if (!embedderPromise) {
    embedderPromise = new Promise((resolve, reject) => {
      const worker = new Worker(new URL("ai-worker.js", import.meta.url), { type: "module" });
      const pending = new Map();
      let nextId = 0;

      const embed = (texts) =>
        new Promise((done, fail) => {
          const id = nextId++;
          pending.set(id, { done, fail });
          worker.postMessage({ id, texts });
        });

      const failAll = (error) => {
        reject(error);
        for (const p of pending.values()) p.fail(error);
        pending.clear();
        embedderPromise = null; // allow a retry
        worker.terminate();
      };

      worker.onmessage = ({ data }) => {
        if (data.type === "progress") progressListeners.forEach((fn) => fn(data.progress));
        else if (data.type === "ready") resolve(embed);
        else if (data.type === "failed") failAll(new Error(data.error));
        else if (pending.has(data.id)) {
          const p = pending.get(data.id);
          pending.delete(data.id);
          if (data.error) p.fail(new Error(data.error));
          else p.done(data.vectors);
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        failAll(new Error(event.message || "The AI model could not start."));
      };
    });
  }
  return embedderPromise;
}
