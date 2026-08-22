// Spike: Chrome Prompt API
//
// The one runtime with no download step in our page — the browser already has
// the model, or it doesn't. That makes it the control case for the harness.
//
// TODO(research): fill in from the Chrome Prompt API research block before
// running. Do not guess the API surface; every call below needs a documented
// signature behind it.
//
// No model picker here, deliberately: the model is built into the browser, so
// ../../MODELS.md does not apply — no format, no download, no choice. That
// absence is itself one of the article's points.

import { runSpike } from "./lib/harness.js";

runSpike({
  name: "Chrome Prompt API",
  docs: "https://developer.chrome.com/docs/ai/prompt-api",
  notes:
    "Built-in model. Nothing to download from us, but availability depends on the browser, the OS, and free disk.",
  defaultPrompt: "In one sentence, what is WebGPU?",

  check: async ({ log }) => {
    // TODO(research): confirm the current global and the availability call.
    log.warn("check() not implemented yet — awaiting API research");
    return { ok: false, detail: "not implemented" };
  },

  load: async ({ log }) => {
    // TODO(research): create a session with system instructions, wiring the
    // download monitor to progress() if the model is not yet present.
    log.warn("load() not implemented yet");
    throw new Error("not implemented");
  },

  generate: async ({ log }) => {
    // TODO(research): streaming prompt call. Note for the article: does the
    // session hold its own history (making `messages` redundant), and what does
    // it do when the input exceeds the session ceiling?
    log.warn("generate() not implemented yet");
    throw new Error("not implemented");
  },

  unload: async ({ log }) => {
    // TODO(research): destroy the session. Note whether this frees anything the
    // page can observe — the weights belong to the browser, not to us.
    log.info("unload() not implemented yet");
  },
});
