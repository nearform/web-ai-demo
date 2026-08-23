/* global document:false, window:false, performance:false, navigator:false, console:false, AbortController:false */

// Spike harness. Deliberately dependency-free — no React, no shared provider
// abstraction — so that when a spike fails, the failure is unambiguously the
// runtime under test and not our code. The unified app comes later; these pages
// exist to answer one question per runtime: does it load and emit tokens, on
// this machine, today.
//
// A spike supplies four functions (`check`, `load`, `generate`, `unload`) and the
// harness supplies everything around them: UI, timing, conversation state,
// cancellation, and verbatim error capture.
//
// On cancellation: `generate` receives an `AbortSignal`. It matters more than it
// looks — on a phone a small model decodes slowly enough that a runaway generation
// would otherwise have to be killed with the tab, and killing the tab takes the
// diagnostics with it. An abort is recorded as a run with `aborted: true`, not as
// a failure; how far a runtime got before being stopped is data too.
//
// On honest measurement: the harness counts *chunks* delivered to `onChunk`, not
// tokens, because a chunk is what we can actually observe. A runtime that reports
// its own prefill/decode token rates should pass them to `ctx.stats()`; those are
// labeled separately and attributed to the runtime.

import { probeDevice } from "../../lib/probe.js";
import {
  startBlackbox,
  crumb,
  track,
  trackNow,
  warnings,
  dismissRecovered,
} from "../../lib/blackbox.js";
// The degeneracy metric lives in lib/ so the spikes and the unified demo score
// output with the identical thresholds — see the note at the top of quality.js.
import { textQuality, degeneracyReason } from "../../lib/quality.js";

const fmtMs = (ms) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  });
  (Array.isArray(children) ? children : [children])
    .filter(Boolean)
    .forEach((child) => node.append(child));
  return node;
};

const modelOption = (m) =>
  el("option", {
    value: m.id,
    text: m.sizeMb ? `${m.label} — ${m.sizeMb} MB` : m.label,
  });

// Errors are the product here. Capture name, message, and stack verbatim — the
// LiteRT work showed the error *string* is the diagnostic signal, so it never
// gets summarized or prettified.
const describeError = (err) => {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack ?? null };
  }
  return { name: typeof err, message: String(err), stack: null };
};

export const runSpike = (spike) => {
  const state = {
    handle: null,
    status: "not_loaded",
    messages: [],
    device: null,
    runs: [],
    events: [],
    // The AbortController for an in-flight generate, or null. This is the one
    // piece of state the `status` vocabulary can't express: the runtime is still
    // "loaded" the whole time a reply is streaming.
    abort: null,
    // The previous session's crash record, if this page is loading after a hard
    // kill. Recovered synchronously below, before anything can kill us again.
    recoveredCrash: null,
  };

  const nodes = {};

  const log = (level, message, data) => {
    const entry = {
      at: new Date().toISOString(),
      sinceStartMs: Math.round(performance.now()),
      level,
      message,
      ...(data === undefined ? {} : { data }),
    };
    state.events.push(entry);
    const line = el("div", { class: `log-line log-line--${level}` }, [
      el("span", {
        class: "log-time",
        text: `+${(entry.sinceStartMs / 1000).toFixed(2)}s`,
      }),
      el("span", { class: "log-msg", text: message }),
      data === undefined
        ? null
        : el("pre", { class: "log-data", text: JSON.stringify(data, null, 2) }),
    ]);
    nodes.log.append(line);
    nodes.log.scrollTop = nodes.log.scrollHeight;
    if (level === "error") console.error(message, data);
  };

  const logger = {
    info: (message, data) => log("info", message, data),
    warn: (message, data) => log("warn", message, data),
    error: (message, data) => log("error", message, data),
  };

  const setStatus = (status, detail) => {
    state.status = status;
    // A phase change is exactly the moment worth persisting: "died while
    // loading" and "died while idle" are different findings.
    trackNow({ status, statusDetail: detail ?? null });
    crumb(`status: ${status}`, detail ? { detail } : undefined);
    nodes.status.textContent = detail ? `${status} — ${detail}` : status;
    nodes.status.className = `spike-status spike-status--${status}`;
    nodes.load.disabled = status === "loading" || status === "loaded";
    nodes.ask.disabled = status !== "loaded";
    nodes.unload.disabled = status !== "loaded";
  };

  // Generation is orthogonal to `status` — the runtime stays "loaded" while a
  // reply streams — so Ask and Stop are driven from here instead.
  const setGenerating = (controller) => {
    state.abort = controller;
    nodes.stop.disabled = controller === null;
    nodes.ask.disabled = controller !== null || state.status !== "loaded";
  };

  const doStop = () => {
    if (!state.abort) return;
    logger.info("Stop requested; aborting generation");
    state.abort.abort();
  };

  const setProgress = (fraction, text) => {
    if (fraction === null) {
      nodes.progress.hidden = true;
      return;
    }
    nodes.progress.hidden = false;
    nodes.progressBar.style.width = `${Math.round(fraction * 100)}%`;
    nodes.progressText.textContent = text ?? `${Math.round(fraction * 100)}%`;
    // Throttled: a download fires this many times a second, and each write is
    // synchronous. How far the download got before the tab died is the single
    // most useful field in a recovered record.
    track({
      progress: Number(fraction.toFixed(3)),
      progressText: text ?? null,
    });
  };

  const ctxBase = (extra = {}) => ({
    log: logger,
    model: nodes.model?.value ?? null,
    system: nodes.system.value,
    progress: setProgress,
    ...extra,
  });

  const doCheck = async () => {
    if (!spike.check) {
      logger.info("No check() defined for this spike; skipping.");
      return true;
    }
    try {
      const result = await spike.check(ctxBase());
      const ok = result?.ok ?? Boolean(result);
      logger[ok ? "info" : "warn"](
        ok ? "check() passed" : "check() says this runtime is unavailable here",
        result?.detail ?? result,
      );
      return ok;
    } catch (err) {
      logger.error("check() threw", describeError(err));
      return false;
    }
  };

  const doLoad = async () => {
    setStatus("loading");
    setProgress(0, "starting");
    // The model is the thing most likely to kill the tab, so it goes into the
    // snapshot before the attempt rather than after it.
    trackNow({
      phase: "load",
      model: nodes.model?.value ?? null,
      modelLabel: nodes.model?.selectedOptions?.[0]?.textContent ?? null,
    });
    crumb("load: start", { model: nodes.model?.value ?? null });
    const started = performance.now();
    try {
      const ok = await doCheck();
      if (!ok) {
        setStatus("unavailable");
        setProgress(null);
        return;
      }
      state.handle = await spike.load(ctxBase());
      const elapsed = performance.now() - started;
      state.runs.push({ kind: "load", ms: Math.round(elapsed) });
      logger.info(`load() finished in ${fmtMs(elapsed)}`);
      crumb("load: ok", { ms: Math.round(elapsed) });
      // Back to idle, or a recovered record reads as "died during load" for the
      // whole time the page then sat there loaded and doing nothing.
      trackNow({ phase: "idle", progress: null, progressText: null });
      setProgress(null);
      setStatus("loaded");
    } catch (err) {
      const described = describeError(err);
      logger.error(
        `load() failed after ${fmtMs(performance.now() - started)}`,
        described,
      );
      // A load that throws is a *survivable* failure, so it lands in the log. It
      // still gets a breadcrumb, because the next thing that happens might not be.
      crumb("load: failed", {
        name: described.name,
        message: described.message,
      });
      setProgress(null);
      setStatus("error", described.message);
    }
  };

  const doAsk = async () => {
    const prompt = nodes.prompt.value.trim();
    if (!prompt) return;

    const controller = new AbortController();
    setGenerating(controller);
    state.messages.push({ role: "user", content: prompt });
    const turn = state.messages.filter((m) => m.role === "user").length;
    const answer = el("div", { class: "turn" }, [
      el("div", { class: "turn-role", text: `you (turn ${turn})` }),
      el("div", { class: "turn-text", text: prompt }),
    ]);
    nodes.output.append(answer);

    const replyText = el("div", { class: "turn-text", text: "" });
    nodes.output.append(
      el("div", { class: "turn turn--model" }, [
        el("div", { class: "turn-role", text: spike.name }),
        replyText,
      ]),
    );

    trackNow({
      phase: "generate",
      turn,
      promptChars: prompt.length,
      prompt: prompt.slice(0, 200),
    });
    crumb(`generate: start turn ${turn}`, { promptChars: prompt.length });

    const started = performance.now();
    let firstChunkAt = null;
    let chunks = 0;
    let text = "";
    let runtimeStats = null;

    // Built in both the completed and the aborted path, so a stopped generation
    // produces the same shape of record as a finished one.
    const recordRun = (aborted) => {
      const total = performance.now() - started;
      const ttft = firstChunkAt === null ? null : firstChunkAt - started;
      const run = {
        kind: "generate",
        turn,
        promptChars: prompt.length,
        replyChars: text.length,
        totalMs: Math.round(total),
        timeToFirstChunkMs: ttft === null ? null : Math.round(ttft),
        chunks,
        // Chunks, not tokens. See the note at the top of this file.
        chunksPerSecond:
          ttft === null || total === ttft
            ? null
            : Number((chunks / ((total - ttft) / 1000)).toFixed(1)),
        runtimeReportedStats: runtimeStats,
        aborted,
        // Whether the reply is usable prose, as a number rather than an
        // impression. See lib/quality.js.
        quality: textQuality(text),
      };
      // The partial reply is part of the conversation whether we stopped it or
      // not, and the next turn's prefix depends on it being here. An empty one is
      // not: stopping before the first chunk would otherwise leave a blank
      // assistant turn in the history, which some chat templates reject.
      if (text.length > 0) {
        state.messages.push({ role: "assistant", content: text });
      }
      state.runs.push(run);
      return run;
    };

    try {
      await spike.generate(
        ctxBase({
          handle: state.handle,
          prompt,
          // The full history is always offered. Runtimes that hold their own
          // session will ignore it — and *that difference* is one of the things
          // these spikes exist to surface.
          messages: state.messages.slice(),
          turn,
          onChunk: (chunk) => {
            if (firstChunkAt === null) firstChunkAt = performance.now();
            chunks += 1;
            text += chunk;
            replyText.textContent = text;
            nodes.output.scrollTop = nodes.output.scrollHeight;
            // Coalesced to one write per 500 ms — see the note in blackbox.js.
            // Untangling "died before the first token" from "died 300 tokens in"
            // is the whole reason this field exists.
            //
            // The TAIL of the reply rides along, because the `transcript` added to
            // the diagnostics only helps a session that survives to be copied.
            // MEASURED 2026-08-23: three iPhone crash records came back with
            // `transcript: []`, since the recovering page has no conversation of
            // its own — so for a session that dies mid-reply the text has to live
            // in the crash snapshot or nowhere. Tail rather than head: if the
            // model is looping, the tail is where the loop is visible.
            track({
              chunks,
              replyChars: text.length,
              replyTail: text.slice(-240),
            });
          },
          stats: (s) => {
            runtimeStats = s;
          },
          signal: controller.signal,
        }),
      );

      // A runtime may honor an abort by simply returning early rather than
      // throwing — web-llm's interruptGenerate() does exactly that — so the
      // signal, not the control flow, decides whether this was a stop.
      const run = recordRun(controller.signal.aborted);
      if (run.quality?.looksDegenerate) {
        logger.warn(
          `Reply looks degenerate: ${degeneracyReason(run.quality)}`,
          run.quality,
        );
      }
      logger.info(
        controller.signal.aborted
          ? `generate() turn ${turn} stopped after ${chunks} chunks`
          : `generate() turn ${turn} complete`,
        run,
      );
      crumb(
        controller.signal.aborted
          ? `generate: stopped turn ${turn}`
          : `generate: ok turn ${turn}`,
        { chunks, replyChars: text.length },
      );
    } catch (err) {
      const described = describeError(err);
      if (controller.signal.aborted || described.name === "AbortError") {
        const run = recordRun(true);
        logger.info(`generate() turn ${turn} stopped after ${chunks} chunks`, {
          ...run,
          threw: described.name,
        });
      } else {
        logger.error(`generate() failed on turn ${turn}`, described);
        crumb(`generate: failed turn ${turn}`, {
          name: described.name,
          message: described.message,
        });
        replyText.textContent = `[failed: ${described.message}]`;
      }
    } finally {
      setGenerating(null);
      nodes.prompt.value = "";
      trackNow({ phase: "idle", chunks, replyChars: text.length });
    }
  };

  const doUnload = async () => {
    // Unload stays clickable mid-generation, because status is still "loaded".
    // Tearing the engine out from under a running stream is the kind of thing
    // that produces an unhelpful error, so stop first.
    if (state.abort) state.abort.abort();
    try {
      await spike.unload?.(ctxBase({ handle: state.handle }));
      logger.info("unload() finished");
    } catch (err) {
      logger.error("unload() threw", describeError(err));
    }
    state.handle = null;
    state.messages = [];
    nodes.output.replaceChildren();
    crumb("unload: done");
    setStatus("not_loaded");
  };

  const diagnostics = () => ({
    spike: spike.name,
    docs: spike.docs,
    capturedAt: new Date().toISOString(),
    status: state.status,
    model: nodes.model?.value ?? null,
    device: state.device,
    runs: state.runs,
    events: state.events,
    // The recovered record from a previous session that died, if any. This is
    // the only field here that can describe a run whose own diagnostics were
    // destroyed — so it must survive into the paste-back, or a device test that
    // killed the tab reports nothing at all.
    recoveredCrash: state.recoveredCrash,
    // crashbox's in-session observations: memory pressure and device-loss events
    // seen while this page has been alive.
    crashboxWarnings: warnings(),
    // The actual conversation, truncated. This was missing, and its absence cost
    // us: a reply scored as 513 characters containing 2 words could not be read
    // back from the paste-out, so what the model actually emitted was
    // unrecoverable. The article wants to quote degenerate output, not just score
    // it. Bounded per turn to keep the payload copyable on a phone.
    transcript: state.messages.map((m) => ({
      role: m.role,
      chars: m.content.length,
      text: m.content.slice(0, 600),
      truncated: m.content.length > 600,
    })),
  });

  const copyDiagnostics = async () => {
    // Local only. Nothing here is transmitted anywhere — the clipboard is the
    // whole delivery mechanism, by design.
    const text = JSON.stringify(diagnostics(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      logger.info("Diagnostics copied to clipboard");
    } catch (err) {
      logger.warn(
        "Clipboard write failed; dumping to console instead",
        describeError(err),
      );
      console.log(text);
    }
  };

  // Build the page.
  const build = () => {
    nodes.status = el("div", { class: "spike-status", text: "not_loaded" });
    nodes.progressBar = el("div", { class: "progress-bar" });
    nodes.progressText = el("span", { class: "progress-text", text: "" });
    nodes.progress = el("div", { class: "progress", hidden: "" }, [
      el("div", { class: "progress-track" }, nodes.progressBar),
      nodes.progressText,
    ]);

    // A spike may declare a static model list, or discover one at load time via
    // loadModels(). Discovery is preferred where the runtime publishes its own
    // catalog: hardcoded sizes go stale, and a number read from the library is a
    // number we can cite.
    nodes.model =
      spike.models?.length || spike.loadModels
        ? el(
            "select",
            { class: "control-input" },
            (spike.models ?? []).map((m) => modelOption(m)),
          )
        : null;

    nodes.system = el("textarea", {
      class: "control-input control-input--area",
      rows: "3",
      text: spike.defaultSystem ?? "You are a concise, accurate assistant.",
    });

    nodes.prompt = el("textarea", {
      class: "control-input control-input--area",
      rows: "2",
      placeholder: "Ask something…",
      text: spike.defaultPrompt ?? "In one sentence, what is WebGPU?",
    });

    nodes.load = el("button", {
      class: "btn btn--primary",
      text: "Load",
      onclick: doLoad,
    });
    nodes.ask = el("button", {
      class: "btn",
      text: "Ask",
      disabled: "",
      onclick: doAsk,
    });
    nodes.unload = el("button", {
      class: "btn",
      text: "Unload",
      disabled: "",
      onclick: doUnload,
    });
    nodes.stop = el("button", {
      class: "btn",
      text: "Stop",
      disabled: "",
      onclick: doStop,
    });
    nodes.output = el("div", { class: "output" });
    nodes.log = el("div", { class: "log" });
    nodes.probe = el("pre", { class: "probe", text: "probing…" });

    // Hidden unless the previous session died. Populated after build().
    nodes.recovery = el("section", { class: "recovery", hidden: "" });

    const root = el("div", { class: "spike" }, [
      el("header", { class: "spike-header" }, [
        // "./" not "./index.html": the directory URL is the canonical one in both
        // serve and Pages, so it lands in one hop instead of bouncing through a
        // rewrite — and avoids the index page having to normalize its own URL.
        el("a", { class: "back", href: "./", text: "← all spikes" }),
        el("h1", { text: spike.name }),
        el("a", {
          class: "docs",
          href: spike.docs,
          target: "_blank",
          rel: "noopener noreferrer",
          text: "docs ↗",
        }),
      ]),
      spike.notes ? el("p", { class: "spike-notes", text: spike.notes }) : null,
      nodes.recovery,
      el("section", { class: "panel" }, [
        el("div", { class: "panel-title", text: "Runtime" }),
        nodes.status,
        nodes.progress,
        nodes.model
          ? el("label", { class: "control" }, [
              el("span", { text: "Model" }),
              nodes.model,
            ])
          : null,
        el("label", { class: "control" }, [
          el("span", { text: "System instructions" }),
          nodes.system,
        ]),
        el("div", { class: "btn-row" }, [nodes.load, nodes.unload]),
      ]),
      el("section", { class: "panel" }, [
        el("div", { class: "panel-title", text: "Conversation" }),
        nodes.output,
        el("label", { class: "control" }, [
          el("span", { text: "Prompt" }),
          nodes.prompt,
        ]),
        el("div", { class: "btn-row" }, [nodes.ask, nodes.stop]),
      ]),
      el("section", { class: "panel" }, [
        el("div", { class: "panel-title", text: "Device" }),
        nodes.probe,
      ]),
      el("section", { class: "panel" }, [
        el("div", { class: "panel-title", text: "Log" }),
        nodes.log,
        el("div", { class: "btn-row" }, [
          el("button", {
            class: "btn",
            text: "Copy diagnostics",
            onclick: copyDiagnostics,
          }),
        ]),
      ]),
    ]);

    document.getElementById("root").replaceChildren(root);
  };

  build();

  // Start the black box now: before any model can be loaded, and after build()
  // so a recovered record has a log panel to be reported into. crashbox recovers
  // the previous session synchronously inside init(), so `recovered` is already
  // populated when this returns.
  const { recovered, gpuIntercepted } = startBlackbox({
    name: spike.name,
    log: logger,
    onMemoryPressure: (info) => {
      // Live pressure, while we are still alive to say so. On Chromium this is
      // read from performance.memory; on iOS Safari there is no memory API, so
      // this fires from growth tracking or not at all.
      logger.warn(`memory pressure: ${info?.level ?? "unknown"}`, info);
    },
  });
  state.recoveredCrash = recovered ?? null;

  if (recovered) {
    // The headline. A tab that died on the last visit is the most valuable thing
    // this page can tell you, so it goes above the panels rather than into the log
    // — on a phone the log is several scrolls down, and the reason to look at all
    // is that the previous attempt vanished.
    const diedAt = new Date(recovered.lastSeen).toISOString();
    nodes.recovery.hidden = false;
    nodes.recovery.replaceChildren(
      el("div", {
        class: "recovery-title",
        text: `Previous session crashed — ${recovered.reason}`,
      }),
      el("div", {
        class: "recovery-detail",
        text: `Last heartbeat ${diedAt}. The breadcrumb trail and the state at death are in the log below and in the copied diagnostics.`,
      }),
    );
    // Acknowledge it. crashbox already consumed the persisted record when it
    // delivered this one, so this only keeps the debug handle in sync — see
    // dismissRecovered(). The record lives on in state.recoveredCrash and in the
    // log, so the paste-back still carries it.
    dismissRecovered();
    logger.error("crashbox recovered a crash from the previous session", {
      reason: recovered.reason,
      lastSeen: diedAt,
      sessionId: recovered.sessionId,
      // What the page was doing when it died. This is the field the device pass
      // exists to produce.
      snapshot: recovered.snapshot ?? null,
      breadcrumbs: recovered.breadcrumbs ?? [],
    });
  } else {
    logger.info(
      "crashbox armed; previous session exited cleanly (or is first)",
      {
        // Reported because it is our instrumentation rather than crashbox's, and
        // if it is false then GPU device loss will not be attributable.
        gpuDeviceInterception: gpuIntercepted,
      },
    );
  }

  // A tab that dies takes its console with it, so anything we can catch before
  // the end gets logged. This is not crash reporting — it's the last thing we
  // see before the runtimes that kill tabs kill this one.
  window.addEventListener("error", (event) => {
    log("error", "window.onerror", {
      message: event.message,
      source: event.filename,
      line: event.lineno,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    log("error", "unhandledrejection", describeError(event.reason));
  });

  if (spike.loadModels && nodes.model) {
    nodes.model.replaceChildren(el("option", { text: "loading catalog…" }));
    spike
      .loadModels({ log: logger })
      .then((models) => {
        nodes.model.replaceChildren(...models.map((m) => modelOption(m)));
        log("info", `Model catalog loaded: ${models.length} entries`, {
          smallest: models[0] ?? null,
        });
      })
      .catch((err) => {
        nodes.model.replaceChildren(el("option", { text: "catalog failed" }));
        log("error", "loadModels() failed", describeError(err));
      });
  }

  probeDevice().then((device) => {
    state.device = device;
    nodes.probe.textContent = JSON.stringify(device, null, 2);
    // A recovered record has to say what hardware it died on, and the crashed
    // session cannot tell us afterwards. Keep it to the few fields that identify
    // the device — the snapshot is byte-capped and shared with the live state.
    trackNow({
      device: {
        looksLikeIos: device.looksLikeIos,
        maxBufferSizeMb: device.webgpu.limits?.maxBufferSizeMb ?? null,
        webgpu: device.webgpu.available,
        userAgent: device.userAgent,
      },
    });
    log("info", "Device probed", {
      webgpu: device.webgpu.available,
      maxBufferSizeMb: device.webgpu.limits?.maxBufferSizeMb ?? null,
      looksLikeIos: device.looksLikeIos,
    });
  });
};
