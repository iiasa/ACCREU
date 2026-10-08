// Runs the assistant's language model (BAAI bge-small-en-v1.5) off the page's
// main thread, so loading the runtime and embedding text never freezes the
// page. Started by ai-model.js.
//
// in:  {id, texts}            out: {id, vectors} or {id, error}
// out: {type: "progress", progress}, {type: "ready"}, {type: "failed", error}

import { pipeline, env } from "./vendor/transformers/transformers.min.js";

const base = new URL("./", import.meta.url); // .../assets/
const MODEL_ID = "Xenova/bge-small-en-v1.5";

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL("models/", base).href;
env.backends.onnx.wasm.wasmPaths = new URL("vendor/transformers/", base).href;

const ready = pipeline("feature-extraction", MODEL_ID, {
  dtype: "q8",
  device: "wasm",
  progress_callback: ({ status, file, loaded, total }) =>
    self.postMessage({ type: "progress", progress: { status, file: file || "", loaded, total } }),
});
ready.then(
  () => self.postMessage({ type: "ready" }),
  (error) => self.postMessage({ type: "failed", error: String((error && error.message) || error) })
);

// One request at a time: the model session runs one batch at a time.
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      const extractor = await ready;
      const vectors = (await extractor(data.texts, { pooling: "cls", normalize: true })).tolist();
      self.postMessage({ id: data.id, vectors });
    } catch (error) {
      self.postMessage({ id: data.id, error: String((error && error.message) || error) });
    }
  });
};
