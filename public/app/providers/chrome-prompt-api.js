/* global LanguageModel:false */

// Chrome Prompt API adapter (built-in Gemini Nano).
//
// The control case for weights: no download, no model choice, no format — the
// browser has the model or it does not. What the other four spend effort on
// (caching, progress, memory) is not a concern here.
//
// The trade is availability, and it is the narrowest of the five. Chrome's docs
// list Windows 10/11, macOS 13+, Linux and Chromebook-Plus ChromeOS, and state
// that Chrome for Android, iOS and non-Chromebook-Plus ChromeOS are not
// supported. Every iOS browser is WebKit underneath, so Chrome for iOS does not
// have it either.
//
// Verified against the Chrome docs and the spec rather than remembered:
//   - LanguageModel.availability(opts) -> "unavailable" | "downloadable"
//                                        | "downloading" | "available"
//   - LanguageModel.create({ initialPrompts, monitor, signal })
//   - LanguageModel.params() -> { defaultTopK, maxTopK, defaultTemperature, ... }
//   - session.promptStreaming(input, { signal, responseConstraint })  — NO await
//     before it; returns a ReadableStream whose chunks are deltas
//   - session.contextUsage / session.contextWindow  (the old inputUsage /
//     inputQuota names are gone from web contexts)
//   - session.measureContextUsage(text), session.destroy()
//   - the "contextoverflow" event
//
// There is no `systemPrompt` option — the still-published debug-gemini-nano page
// showing one is dated 2025-02-28 and is stale. A system prompt is a `system`
// role entry in `initialPrompts`, which means it is fixed at create() time.

// Session-scoped, not module-scoped where it can be helped: these two exist only
// because the values have to survive from load() to generate().
let overflowCount = 0;
let systemAtCreate = null;

export default {
  id: "chrome-prompt-api",

  check: async ({ log }) => {
    if (typeof LanguageModel === "undefined") {
      return {
        ok: false,
        detail:
          "LanguageModel is undefined. The web Prompt API needs Chrome 148+ on desktop — Windows 10/11, macOS 13+, Linux, or a Chromebook Plus. Chrome for Android and every iOS browser are unsupported, and it is unavailable in Web Workers.",
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

    // initialPrompts is the only way in for a system prompt. monitor is called
    // synchronously with the monitor object, and downloadprogress gives e.loaded
    // as a 0-1 fraction with no documented e.total.
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

    // THE named finding, and the reason this runtime's context control is
    // read-only rather than absent. There is no documented context-window number
    // anywhere in the docs or the spec, because Chrome benchmarks the GPU at
    // first create() and hands you a ~2B or ~4B Gemini Nano variant per device.
    // So this value is the answer, and it is only knowable at runtime, here.
    log.info("session created", {
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

    return {
      session,
      // Surfaced to the UI so the context control can show a real number instead
      // of a blank. This is the only runtime that fills this in.
      discoveredContext: session.contextWindow ?? null,
    };
  },

  generate: async ({
    handle,
    prompt,
    system,
    json,
    onChunk,
    stats,
    log,
    signal,
  }) => {
    const { session } = handle;

    if (systemAtCreate !== null && systemAtCreate !== system) {
      log.warn(
        "System prompt edited, but initialPrompts is fixed at create(). This turn uses the original; unload and load to change it.",
      );
    }

    const before = session.contextUsage ?? null;

    // A dry run of what this prompt will cost, before spending it.
    let measured = null;
    try {
      measured = await session.measureContextUsage?.(prompt);
    } catch (err) {
      log.warn("measureContextUsage() threw", { message: String(err) });
    }

    // The session keeps its own history — "Previous interactions are taken into
    // account for future interactions until the session's context window is
    // full." So the controller's `messages` is deliberately not used here. This
    // is the sharpest difference between the five runtimes: everywhere except
    // LiteRT-LM we resend the whole conversation and pay to re-prefill it.
    //
    // No await before promptStreaming: it returns the stream synchronously.
    const options = {};
    if (signal) options.signal = signal;
    if (json) {
      // A JSON Schema object, passed per call. Chrome 137+.
      options.responseConstraint = json.schema;
      log.info("responseConstraint set", { schema: json.schema });
    }
    const stream = session.promptStreaming(prompt, options);

    try {
      for await (const chunk of stream) {
        // Chunks are deltas already, not cumulative snapshots.
        if (chunk) onChunk(chunk);
      }
    } finally {
      const after = session.contextUsage ?? null;
      stats({
        contextWindow: session.contextWindow ?? null,
        contextUsageBefore: before,
        contextUsageAfter: after,
        // Answers "are output tokens charged against the same budget as input?"
        // If this exceeds what the prompt alone measured, they are.
        contextConsumedThisTurn:
          before !== null && after !== null ? after - before : null,
        measuredCostOfPromptAlone: measured ?? null,
        overflowEvents: overflowCount,
        historyResentByUs: false,
        jsonConstrained: Boolean(json),
        // No token rates exist on this API. Said out loud so a null in the
        // diagnostics reads as "not offered" rather than "we forgot to read it".
        runtimeReportsItsOwnRates: false,
      });
    }
  },

  unload: async ({ handle, log }) => {
    // destroy() aborts any ongoing execution and later prompt() calls reject.
    // Nothing to delete: the weights are the browser's, shared across origins,
    // and no page-facing API frees or even measures them. Chrome collapses the
    // three cache states the other runtimes distinguish — resident, on disk,
    // absent — into one the page cannot see.
    handle?.session?.destroy?.();
    systemAtCreate = null;
    overflowCount = 0;
    log.info(
      "session.destroy() returned — the model itself is Chrome's and stays on disk, unmeasurable from here",
    );
  },
};
