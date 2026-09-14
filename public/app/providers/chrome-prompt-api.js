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

// Session-scoped, not module-scoped where it can be helped: these exist only
// because the values have to survive from load() to generate().
let overflowCount = 0;
let systemAtCreate = null;
let toolsAtCreate = null;
// Whether load() was ASKED for tools, as distinct from whether it got any. The
// two differ on every Chrome that ships today, and only the first answers "did
// the reader flip the toggle after loading" — which is the one case where
// reloading would change anything.
let toolsRequestedAtCreate = false;

// A tool as the explainer declares it: `inputSchema`, not `parameters`, and an
// `execute` the BROWSER calls rather than a call reported back to the page.
// Written to the spec even though nothing reads it yet, because a shape invented
// here would be a third thing that is neither what Chrome will take nor what the
// other four take.
const toolEntriesFor = (tools) =>
  tools.declarations.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.parameters,
    execute: (args) => tools.call(d.name, args).then((r) => JSON.stringify(r)),
  }));

/**
 * Does this Chrome have tool use, or does it only accept the option?
 *
 * The two are not the same question and the obvious test cannot tell them
 * apart: `tools` is a dictionary member, so a Chrome that has never heard of it
 * drops it and returns a perfectly good session. What Chrome *does* reject is
 * an `expectedOutputs` entry of type `tool-call`, because that goes through an
 * enum. So the presence of the whole feature is read off the one part of it
 * that fails loudly.
 *
 * Costs one create()/destroy() against a model that is already resident, and
 * only when tools were asked for.
 */
const probeToolSupport = async (log) => {
  try {
    const probe = await LanguageModel.create({
      expectedInputs: [{ type: "tool-response" }],
      expectedOutputs: [{ type: "tool-call" }],
    });
    probe.destroy?.();
    log.info(
      'expectedOutputs: [{ type: "tool-call" }] was accepted — this Chrome knows the tool-use types.',
    );
    return { accepted: true, error: null };
  } catch (err) {
    log.warn(
      `Tool use is not implemented in this Chrome. create() with expectedOutputs [{ type: "tool-call" }] threw ${err.name}, and the \`tools\` option itself is accepted and dropped — an unknown dictionary member is not an error. The declarations below go out and nothing will read them.`,
      { name: err.name, message: String(err.message ?? err) },
    );
    return { accepted: false, error: { name: err.name, message: String(err) } };
  }
};

// Stage one of overflow is silent eviction, so without this listener the
// conversation quietly loses its oldest turns and nothing says why. The count is
// per session, so it resets whenever a session does.
const watchOverflow = (session, log) => {
  overflowCount = 0;
  session.addEventListener?.("contextoverflow", () => {
    overflowCount += 1;
    log.warn(
      `contextoverflow fired (${overflowCount}) — Chrome has evicted the oldest turn pair(s). The system prompt is never evicted.`,
    );
  });
};

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

  load: async ({ system, tools, log, progress }) => {
    systemAtCreate = system;

    let toolSupport = null;
    toolsRequestedAtCreate = Boolean(tools);
    if (tools) {
      toolSupport = await probeToolSupport(log);
      toolsAtCreate = toolSupport.accepted ? tools.declarations : null;
    } else {
      toolsAtCreate = null;
    }

    // initialPrompts is the only way in for a system prompt. monitor is called
    // synchronously with the monitor object, and downloadprogress gives e.loaded
    // as a 0-1 fraction with no documented e.total.
    const session = await LanguageModel.create({
      initialPrompts: system
        ? [{ role: "system", content: system }]
        : undefined,
      // Sent whether or not the probe above found anything to receive it. An
      // unknown dictionary member is dropped, so this costs nothing today and
      // is the line that starts working on the Chrome that ships the option.
      tools: tools ? toolEntriesFor(tools) : undefined,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          progress(
            e.loaded,
            `downloading model: ${Math.round(e.loaded * 100)}%`,
          );
        });
      },
    });

    watchOverflow(session, log);

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
      // Present only when tools were asked for, and the answer that matters:
      // whether the session that came back knows anything about them.
      ...(tools
        ? {
            toolsOptionPassed: true,
            sessionToolsProperty: typeof session.tools,
            toolCallOutputAccepted: toolSupport.accepted,
          }
        : {}),
    });

    return {
      session,
      // Surfaced to the UI so the context control can show a real number instead
      // of a blank. This is the only runtime that fills this in.
      discoveredContext: session.contextWindow ?? null,
      toolsAccepted: toolSupport?.accepted ?? null,
    };
  },

  generate: async ({
    handle,
    prompt,
    system,
    json,
    tools,
    onChunk,
    stats,
    wire,
    log,
    signal,
  }) => {
    const { session } = handle;

    if (systemAtCreate !== null && systemAtCreate !== system) {
      log.warn(
        "System prompt edited, but initialPrompts is fixed at create(). This turn uses the original; unload and load to change it.",
      );
    }

    // Tools are a create() option here, like the system prompt and for the same
    // reason — so the same warning applies, and it applies even though nothing
    // is listening: turning the toggle on after loading changes nothing at all.
    // Only when the toggle was flipped AFTER loading. When the session was
    // created with tools and this Chrome dropped them, load() has already said
    // so once and repeating it every turn adds nothing.
    if (tools && !toolsRequestedAtCreate) {
      log.warn(
        "A tool is declared, but this session was created before the toggle was on and `tools` is a create() option. Nothing will call it this turn. Unload and load to apply it.",
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
    // Only this turn's prompt goes over. The absence of a history here is the
    // finding, so the panel reports what was sent rather than implying more was.
    wire?.({
      request: { prompt, options },
      note: "The session owns the history: only this turn's prompt is sent, and the system prompt was fixed at create(). Nothing is resent.",
    });

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
        // Declared, never called. Kept as two fields rather than one so the
        // diagnostics distinguish "no tool was offered" from "a tool was
        // offered and the runtime has no way to reach for it".
        toolsDeclared: tools ? tools.declarations.length : 0,
        toolCallsMade: 0,
        // No token rates exist on this API. Said out loud so a null in the
        // diagnostics reads as "not offered" rather than "we forgot to read it".
        runtimeReportsItsOwnRates: false,
      });
    }
  },

  // A new chat, for the runtime that owns the history. There is no clear() on a
  // session and clone() is not one: the Chrome docs are explicit that it forks
  // the conversation with "the context and initial prompt preserved", so a clone
  // remembers everything the original did. A fresh session is the only reset.
  //
  // Created BEFORE the old one is destroyed, so a create() that fails leaves the
  // working session in place rather than a dead handle. There is no download to
  // repeat here — the weights are Chrome's and already resident.
  resetConversation: async ({ handle, log }) => {
    const session = await LanguageModel.create({
      initialPrompts: systemAtCreate
        ? [{ role: "system", content: systemAtCreate }]
        : undefined,
      // Whatever the original session was created with, so the replacement is
      // the same session and not a subtly different one.
      tools: toolsAtCreate ?? undefined,
    });
    watchOverflow(session, log);
    handle?.session?.destroy?.();
    log.info(
      "new session created, previous session destroyed — history and contextUsage are back to zero",
      {
        contextWindow: session.contextWindow ?? null,
        contextUsage: session.contextUsage ?? null,
        systemPromptReapplied: Boolean(systemAtCreate),
      },
    );
    return {
      ...handle,
      session,
      discoveredContext:
        session.contextWindow ?? handle?.discoveredContext ?? null,
    };
  },

  unload: async ({ handle, log }) => {
    // destroy() aborts any ongoing execution and later prompt() calls reject.
    // Nothing to delete: the weights are the browser's, shared across origins,
    // and no page-facing API frees or even measures them. Chrome collapses the
    // three cache states the other runtimes distinguish — resident, on disk,
    // absent — into one the page cannot see.
    handle?.session?.destroy?.();
    systemAtCreate = null;
    toolsAtCreate = null;
    toolsRequestedAtCreate = false;
    overflowCount = 0;
    log.info(
      "session.destroy() returned — the model itself is Chrome's and stays on disk, unmeasurable from here",
    );
  },
};
