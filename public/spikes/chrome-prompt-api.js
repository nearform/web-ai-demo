/* global LanguageModel:false */

// Spike: Chrome Prompt API (built-in Gemini Nano)
//
// The one runtime with no download step in our page — the browser already has
// the model, or it doesn't. That makes it the control case for the harness.
//
// No model picker, deliberately: the model is built into the browser, so
// ../../MODELS.md does not apply. No format, no download, no choice. That absence
// is itself one of the article's points.
//
// Verified against the Chrome docs and the spec rather than remembered:
//   - LanguageModel.availability(opts) -> "unavailable" | "downloadable"
//                                        | "downloading" | "available"
//   - LanguageModel.create({ initialPrompts, monitor, signal })
//   - LanguageModel.params() -> { defaultTopK, maxTopK, defaultTemperature, ... }
//   - session.promptStreaming(input, { signal })  — NO await before it; returns a
//     ReadableStream whose chunks are deltas
//   - session.contextUsage / session.contextWindow  (the old inputUsage /
//     inputQuota names are gone from web contexts)
//   - session.measureContextUsage(text), session.destroy()
//   - the "contextoverflow" event
//
// There is no `systemPrompt` option — the still-published debug-gemini-nano page
// showing one is dated 2025-02-28 and is stale. A system prompt is a `system`
// role entry in `initialPrompts`, which means it is fixed at create() time.
//
// Three things this spike exists to establish:
//   1. The real `session.contextWindow` on this machine. Chrome benchmarks the GPU
//      at first create() and hands you either a ~2B or a ~4B Gemini Nano variant,
//      so this is a per-device number and there is no documented value to cite.
//      The named finding for the article is this number, read at runtime.
//   2. Whether output tokens are charged against the same budget as input —
//      contextUsage is sampled before and after each turn.
//   3. What overflow actually does. It is documented as a three-stage escalation:
//      silent eviction of the oldest turn pairs, then a `contextoverflow` event,
//      then QuotaExceededError only if eviction cannot free enough. Stage one is
//      invisible without a listener, so there is a listener.

import { runSpike } from "./lib/harness.js";

// The session owns the conversation, so it is the handle. Kept at module scope
// only so the contextoverflow listener can be attached once at create() time.
let overflowCount = 0;

// Chrome bakes initialPrompts in at create(). The harness re-reads the system
// prompt textarea on every turn, so an edit mid-conversation silently does
// nothing here — unlike every other runtime, where the system message is resent.
// Tracked so the log can say so out loud.
let systemAtCreate = null;

runSpike({
  name: "Chrome Prompt API",
  docs: "https://developer.chrome.com/docs/ai/prompt-api",
  notes:
    "Gemini Nano, built into Chrome. No download in our page and no model choice — and the session keeps its own history, so we do not resend it.",

  check: async ({ log }) => {
    if (typeof LanguageModel === "undefined") {
      return {
        ok: false,
        detail:
          "LanguageModel is undefined — needs Chrome 148+ on a supported OS, and it is unavailable in Web Workers",
      };
    }

    // Docs are emphatic that availability() must be called with the same options
    // you will later pass to create(), so this asks the bare question only.
    const availability = await LanguageModel.availability();
    log.info(`LanguageModel.availability() = "${availability}"`, {
      note: '"downloadable" may need a user gesture before create() succeeds',
    });

    // params() is where the sampling story shows: in a web page temperature and
    // topK are origin-trial-only, ignored at runtime with a deprecation warning,
    // and the session properties read undefined.
    let params = null;
    try {
      params = await LanguageModel.params();
    } catch (err) {
      log.warn("LanguageModel.params() threw", { message: String(err) });
    }
    if (params) log.info("LanguageModel.params()", params);

    if (availability === "unavailable") {
      return { ok: false, detail: "availability() reports unavailable" };
    }
    return { ok: true, detail: { availability, params } };
  },

  load: async ({ system, log, progress }) => {
    systemAtCreate = system;

    // initialPrompts is the only way in for a system prompt. No await/monitor
    // subtleties beyond this: monitor is called synchronously with the monitor
    // object, and downloadprogress gives e.loaded as a 0-1 fraction with no
    // documented e.total.
    const session = await LanguageModel.create({
      initialPrompts: system
        ? [{ role: "system", content: system }]
        : undefined,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          progress(
            e.loaded,
            `downloading model: ${Math.round(e.loaded * 100)}%`,
          );
        });
      },
    });

    // Stage one of overflow is silent eviction, so without this listener the
    // conversation quietly loses its oldest turns and nothing says why.
    overflowCount = 0;
    session.addEventListener?.("contextoverflow", () => {
      overflowCount += 1;
      log.warn(
        `contextoverflow fired (${overflowCount}) — Chrome has evicted the oldest turn pair(s). The system prompt is never evicted.`,
      );
    });

    // THE named finding. There is no documented context-window number anywhere in
    // the docs or the spec, because Chrome picks a ~2B or ~4B Gemini Nano variant
    // per device after benchmarking the GPU. So this value is the answer, and it
    // is only knowable at runtime, on this machine.
    log.info("session created — context budget as this device reports it", {
      contextWindow: session.contextWindow ?? null,
      contextUsage: session.contextUsage ?? null,
      // Old names, kept as an explicit check that they are gone from web
      // contexts rather than assuming it.
      inputQuota_legacy: typeof session.inputQuota,
      inputUsage_legacy: typeof session.inputUsage,
      // Sampling knobs read undefined in a web page without the origin trial.
      temperature: session.temperature ?? null,
      topK: session.topK ?? null,
    });

    return session;
  },

  generate: async ({ handle, prompt, system, onChunk, stats, log, signal }) => {
    if (systemAtCreate !== null && systemAtCreate !== system) {
      log.warn(
        "System prompt was edited, but Chrome fixes initialPrompts at create() — this turn still uses the original. Unload and Load to change it. Every other runtime in this demo resends the system message per turn.",
      );
    }

    const before = handle.contextUsage ?? null;

    // A dry run of what this prompt will cost, before spending it.
    let measured = null;
    try {
      measured = await handle.measureContextUsage?.(prompt);
    } catch (err) {
      log.warn("measureContextUsage() threw", { message: String(err) });
    }

    // The session keeps its own history — "Previous interactions are taken into
    // account for future interactions until the session's context window is
    // full." So `messages` from the harness is deliberately IGNORED here. This is
    // the sharpest difference between the five runtimes: everywhere else we resend
    // the whole conversation and pay to re-prefill it.
    //
    // No await before promptStreaming: it returns the stream synchronously.
    const stream = handle.promptStreaming(prompt, signal ? { signal } : {});

    try {
      for await (const chunk of stream) {
        // Chunks are deltas already, not cumulative snapshots.
        if (chunk) onChunk(chunk);
      }
    } finally {
      const after = handle.contextUsage ?? null;
      stats({
        contextWindow: handle.contextWindow ?? null,
        contextUsageBefore: before,
        contextUsageAfter: after,
        // Answers "are output tokens charged against the same budget as input?"
        // If this exceeds what the prompt alone measured, they are.
        contextConsumedThisTurn:
          before !== null && after !== null ? after - before : null,
        measuredCostOfPromptAlone: measured ?? null,
        overflowEvents: overflowCount,
        historyResentByUs: false,
      });
    }
  },

  unload: async ({ handle, log }) => {
    // destroy() aborts any ongoing execution and later prompt() calls reject.
    // Nothing to delete: the weights are the browser's, shared across origins,
    // and no page-facing API frees or even measures them. Chrome collapses the
    // three cache states the other runtimes distinguish — resident, on disk,
    // absent — into one the page cannot see.
    handle?.destroy?.();
    systemAtCreate = null;
    log.info(
      "session.destroy() returned — the model itself is Chrome's and stays on disk, unmeasurable from here",
    );
  },
});
