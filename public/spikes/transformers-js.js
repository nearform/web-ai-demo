// Spike: Transformers.js
//
// TODO(research): fill in from the Transformers.js research block before running.
// Every call below needs a documented signature behind it — no guessing.
// The import map entry in transformers-js.html also needs the real CDN specifier.

import { runSpike } from "./lib/harness.js";

runSpike({
  name: "Transformers.js",
  docs: "TODO_RESEARCH_DOCS_URL",
  notes:
    "ONNX Runtime Web over WebGPU. Widest model choice, and the chat template is ours to apply.",
  // TODO(research): real model ids and real download sizes, read off the source
  // of truth rather than remembered — and selected per ../../MODELS.md (Gemma 4
  // yes, Gemma 3 and earlier never, latest Qwen, one entry inside the iPhone
  // budget, language models only).
  models: [],
  defaultPrompt: "In one sentence, what is WebGPU?",

  check: async ({ log }) => {
    // TODO(research): feature-detect what this runtime needs — WebGPU, wasm
    // features, and (for the threaded builds) SharedArrayBuffer / cross-origin
    // isolation. Report what is missing rather than failing opaquely.
    log.warn("check() not implemented yet — awaiting API research");
    return { ok: false, detail: "not implemented" };
  },

  load: async ({ log }) => {
    // TODO(research): load the selected model, reporting download progress
    // through progress(fraction, text).
    log.warn("load() not implemented yet");
    throw new Error("not implemented");
  },

  generate: async ({ log }) => {
    // TODO(research): stream a reply. Two things to establish for the article:
    // how multi-turn history is carried, and whether the KV cache is reused
    // across turns or the whole history is re-prefilled each time.
    log.warn("generate() not implemented yet");
    throw new Error("not implemented");
  },

  unload: async ({ log }) => {
    // TODO(research): free the engine and the GPU memory. Separately: is there
    // an API to check and delete the on-disk cache?
    log.info("unload() not implemented yet");
  },
});
