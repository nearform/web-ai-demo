/* global window:false, performance:false, navigator:false, console:false, AbortController:false, requestAnimationFrame:false, cancelAnimationFrame:false */

// The session controller: one runtime at a time, loaded, asked, and unloaded.
//
// This is the spike harness's logic (public/spikes/lib/harness.js) as a React
// hook, and the parts that look fussy are the parts that were learned the hard
// way there. Three of them are worth stating up front, because they are the
// reason this is not just useState around a promise:
//
//   1. **Generation is orthogonal to status.** The runtime stays "loaded" for the
//      whole time a reply is streaming, so "can I press Ask" and "is a model
//      resident" are two different questions and cannot share one enum.
//
//   2. **Streamed chunks must not each cause a render.** A fast decode delivers
//      hundreds of chunks a second. Setting React state per chunk is how a phone
//      demo becomes a phone slideshow — so chunks accumulate in a ref and are
//      flushed to state once per animation frame.
//
//   3. **An abort is a result, not a failure.** How far a runtime got before you
//      gave up is data. Some runtimes honor a stop by throwing and some by simply
//      ending the stream (web-llm's interruptGenerate does the latter), so the
//      signal decides whether it was a stop — never the control flow.
//
// One thing this adds that the harness did not need: switching providers has to
// unload the outgoing one first. Several adapters keep module-level state (a
// Wllama instance, the system prompt baked into a LiteRT conversation), and two
// of them leak badly if abandoned rather than torn down — a wllama instance
// abandoned rather than exited hard-killed an iPhone tab.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { probeDevice } from "../../lib/probe.js";
import {
  startBlackbox,
  crumb,
  track,
  trackNow,
  warnings,
  dismissRecovered,
} from "../../lib/blackbox.js";
import { textQuality, degeneracyReason } from "../../lib/quality.js";
import { loadAdapter, getDescriptor } from "../providers/index.js";
import { readDeepLink, writeDeepLink } from "../util/deeplink.js";
import { jsonSafe } from "../util/wire.js";
import { parseGgufSpec } from "../util/hf-gguf.js";
import {
  DEFAULT_SYSTEM,
  DEFAULT_PROMPT,
  MAX_REPLY_TOKENS,
  JSON_SCHEMA,
  JSON_INSTRUCTION,
} from "../providers/descriptors.js";

// Errors are the product here. Capture name, message and stack verbatim — the
// LiteRT work showed the error *string* is the diagnostic signal, so it never
// gets summarized or prettified.
const describeError = (err) => {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack ?? null };
  }
  return { name: typeof err, message: String(err), stack: null };
};

const fmtMs = (ms) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

// The context value a runtime should start at: its own default where it has one,
// otherwise nothing (which for web-llm means "the model's compiled default" and
// is a meaningfully different state from any number we could pick).
const initialContextFor = (descriptor) =>
  descriptor?.context?.control === "load"
    ? (descriptor.context.default ?? null)
    : null;

// A model id nobody vetted, turned into a picker entry. Custom ids join `models`
// rather than living in a field of their own, so that the picker, the notes, the
// deep link and load() all keep treating "the selected model" as one thing —
// there is no second code path for a model that was typed instead of chosen.
//
// No sizeMb, deliberately: the size is on the Hub and this page has not asked.
// An invented number beside a curated one that was measured would be worse than
// the blank the picker already renders.
const customEntryFor = (descriptor, id) => {
  if (!descriptor?.customModel) return null;
  const spec = parseGgufSpec(id);
  if (!spec.ok) return null;
  return {
    id: spec.id,
    label: `${spec.label} (custom)`,
    note: spec.warning ? `${spec.note} ${spec.warning}` : spec.note,
    custom: true,
  };
};

// The list a runtime starts with, plus the deep-linked custom entry if the link
// named one. A `?model=` for a custom repo has to appear in the picker or the
// select would render blank while `model` held a value — the URL saying one thing
// and the control another.
const initialModelsFor = (descriptor, linkedModel) => {
  const listed = descriptor?.models ?? null;
  if (!listed || !linkedModel || listed.some((m) => m.id === linkedModel)) {
    return listed;
  }
  const custom = customEntryFor(descriptor, linkedModel);
  return custom ? [...listed, custom] : listed;
};

export const useRuntime = () => {
  // Read once, lazily, before anything can write to the address bar. Everything
  // downstream treats this as the initial selection and nothing else — see
  // util/deeplink.js for why a link must not start a download.
  const [deepLink] = useState(readDeepLink);

  const [providerId, setProviderId] = useState(deepLink.providerId);
  const descriptor = useMemo(() => getDescriptor(providerId), [providerId]);

  // --- render-visible state -------------------------------------------------
  const [status, setStatus] = useState("not_loaded");
  const [statusDetail, setStatusDetail] = useState(null);
  const [progress, setProgress] = useState(null);
  const [models, setModels] = useState(() =>
    initialModelsFor(descriptor, deepLink.model),
  );
  const [modelsState, setModelsState] = useState(
    descriptor?.models
      ? "ready"
      : descriptor?.modelChoice?.kind === "discovered"
        ? "idle"
        : "none",
  );
  const [model, setModel] = useState(
    deepLink.model ?? descriptor?.models?.[0]?.id ?? null,
  );
  const [context, setContext] = useState(() => initialContextFor(descriptor));
  const [replyCap, setReplyCap] = useState(MAX_REPLY_TOKENS);
  const [system, setSystem] = useState(DEFAULT_SYSTEM);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [jsonMode, setJsonMode] = useState(false);
  const [turns, setTurns] = useState([]);
  const [streaming, setStreaming] = useState(null);
  const [events, setEvents] = useState([]);
  const [device, setDevice] = useState(null);
  const [runs, setRuns] = useState([]);
  const [recoveredCrash, setRecoveredCrash] = useState(null);
  const [discoveredContext, setDiscoveredContext] = useState(null);
  const [generating, setGenerating] = useState(false);

  // --- refs: things that must not drive renders ------------------------------
  // The live handle. A ref rather than state because it is never rendered and
  // because an adapter's teardown contract (Transformers.js in particular) makes
  // "who holds this object" a correctness question, not a display one.
  const handleRef = useRef(null);
  const abortRef = useRef(null);
  const messagesRef = useRef([]);
  const eventsRef = useRef([]);
  const runsRef = useRef([]);
  // Chunk accumulator + the pending animation frame that flushes it. See note 2.
  const streamRef = useRef("");
  const frameRef = useRef(null);
  // Guards a provider switch racing its own async teardown.
  const switchingRef = useRef(false);
  // Guards ask-to-load against a double click. abortRef only exists once
  // generation starts, so it cannot cover the load that may precede it.
  const askingRef = useRef(false);
  // A ?model= that named a runtime whose catalog is inside its own bundle, held
  // until the catalog is actually read. Cleared once consumed, or when the reader
  // switches runtime themselves — at which point the link no longer describes
  // what is on screen.
  const pendingModelRef = useRef(deepLink.pendingModel);

  // --- logging --------------------------------------------------------------
  const log = useCallback((level, message, data) => {
    const entry = {
      at: new Date().toISOString(),
      sinceStartMs: Math.round(performance.now()),
      level,
      message,
      ...(data === undefined ? {} : { data }),
    };
    eventsRef.current = [...eventsRef.current, entry];
    setEvents(eventsRef.current);
    if (level === "error") console.error(message, data);
  }, []);

  const logger = useMemo(
    () => ({
      info: (m, d) => log("info", m, d),
      warn: (m, d) => log("warn", m, d),
      error: (m, d) => log("error", m, d),
    }),
    [log],
  );

  // --- deep links -----------------------------------------------------------
  // What the query string did, or failed to do, said out loud. A reader who was
  // handed a link and got something else on screen needs to be told why, and the
  // event log is where this page says things.
  useEffect(() => {
    for (const message of deepLink.warnings) log("warn", message);
    if (deepLink.pendingModel) {
      log(
        "info",
        `?model=${deepLink.pendingModel} is held until the ${descriptor?.name} catalog is read: its model list lives inside the library bundle, and a link does not download one.`,
      );
    }
    // Mount only. These describe the URL as it was on arrival, and the effect
    // below is about to rewrite it.
  }, []);

  // The address bar always describes what is on screen, so the URL is a link to
  // the current selection without anyone having to press anything. Runs on mount
  // too, which canonicalises the link a reader arrived on: a mistyped model that
  // was ignored above disappears from the URL rather than staying in it to be
  // copied on again.
  useEffect(() => {
    writeDeepLink({ providerId, model });
  }, [providerId, model]);

  // --- crashbox -------------------------------------------------------------
  // ONE namespace for the whole app, deliberately, and this is a departure from
  // the spikes. crashbox keeps a single `current` pointer per namespace; the
  // spikes namespace per page because five pages on one origin would otherwise
  // consume each other's records. Here there is one page hosting five runtimes in
  // turn, so a namespace per provider would mean every provider switch abandons
  // a session that never wrote a clean-shutdown marker — and the next visit would
  // report a crash that never happened. So the app gets one namespace and the
  // active provider rides in the SNAPSHOT instead, where it is recoverable
  // anyway: a recovered record's `provider` field is what says which runtime
  // killed the tab.
  useEffect(() => {
    const { recovered, gpuIntercepted } = startBlackbox({
      name: "unified",
      scope: "app",
      log: logger,
      onMemoryPressure: (info) => {
        logger.warn(`memory pressure: ${info?.level ?? "unknown"}`, info);
      },
    });

    if (recovered) {
      setRecoveredCrash(recovered);
      dismissRecovered();
      logger.error("crashbox recovered a crash from the previous session", {
        reason: recovered.reason,
        lastSeen: new Date(recovered.lastSeen).toISOString(),
        sessionId: recovered.sessionId,
        // Which runtime was active when the tab died — the field the whole
        // single-namespace decision above exists to preserve.
        snapshot: recovered.snapshot ?? null,
        breadcrumbs: recovered.breadcrumbs ?? [],
      });
    } else {
      logger.info(
        "crashbox armed; previous session exited cleanly (or is first)",
        { gpuDeviceInterception: gpuIntercepted },
      );
    }

    // A tab that dies takes its console with it, so anything catchable before the
    // end gets logged. This is not crash reporting — it is the last thing we see
    // before a runtime that kills tabs kills this one.
    const onError = (event) =>
      log("error", "window.onerror", {
        message: event.message,
        source: event.filename,
        line: event.lineno,
      });
    const onRejection = (event) =>
      log("error", "unhandledrejection", describeError(event.reason));
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
    // Mount only, and the empty dep array is load-bearing rather than lazy:
    // crashbox must be armed before anything can load a model, and re-arming on
    // a logger identity change would repoint its session pointer mid-flight.
    // `logger` is stable in practice (it is a useMemo over a useCallback with no
    // deps), so nothing is stale here.
  }, []);

  // --- device probe ---------------------------------------------------------
  useEffect(() => {
    probeDevice().then((d) => {
      setDevice(d);
      // A recovered record has to say what hardware it died on, and the crashed
      // session cannot tell us afterwards.
      trackNow({
        device: {
          looksLikeIos: d.looksLikeIos,
          maxBufferSizeMb: d.webgpu.limits?.maxBufferSizeMb ?? null,
          webgpu: d.webgpu.available,
          userAgent: d.userAgent,
        },
      });
      log("info", "Device probed", {
        webgpu: d.webgpu.available,
        maxBufferSizeMb: d.webgpu.limits?.maxBufferSizeMb ?? null,
        looksLikeIos: d.looksLikeIos,
      });
    });
    // Mount only: the device does not change under us, and re-probing would
    // request a second GPU adapter for no reason.
  }, []);

  // --- status helper --------------------------------------------------------
  const applyStatus = useCallback((next, detail) => {
    setStatus(next);
    setStatusDetail(detail ?? null);
    // A phase change is exactly the moment worth persisting: "died while loading"
    // and "died while idle" are different findings.
    trackNow({ status: next, statusDetail: detail ?? null });
    crumb(`status: ${next}`, detail ? { detail } : undefined);
  }, []);

  const reportProgress = useCallback((fraction, text) => {
    if (fraction === null) {
      setProgress(null);
      return;
    }
    setProgress({ fraction, text: text ?? `${Math.round(fraction * 100)}%` });
    // Throttled inside blackbox: a download fires this many times a second and
    // each write is synchronous. How far the download got before the tab died is
    // the single most useful field in a recovered record.
    track({
      progress: Number(fraction.toFixed(3)),
      progressText: text ?? null,
    });
  }, []);

  // --- model list resolution ------------------------------------------------
  // Static lists come straight off the descriptor and cost nothing. A discovered
  // list (web-llm only) lives inside the library bundle, so asking for it is what
  // pays for the download — hence the explicit state and the logged cost.
  //
  // Returns the id it selected, rather than the list. Ask-to-load needs that id
  // *now* — reading `model` back would give the previous render's value — and
  // "the first entry" is no longer the answer once a link can ask for another.
  const discoverModels = useCallback(async () => {
    if (!descriptor || descriptor.modelChoice?.kind !== "discovered") {
      return null;
    }
    setModelsState("loading");
    try {
      const adapter = await loadAdapter(descriptor.id, { log: logger });
      const list = await adapter.discoverModels({ log: logger });
      setModels(list);

      // This is the first moment a ?model= for this runtime can be checked
      // against anything, because the catalog it names arrived with the bundle.
      const wanted = pendingModelRef.current;
      pendingModelRef.current = null;
      const chosen =
        wanted && list.some((m) => m.id === wanted)
          ? wanted
          : (list[0]?.id ?? null);
      if (wanted && chosen !== wanted) {
        log(
          "warn",
          `?model=${wanted} is not in this catalog; using ${chosen ?? "nothing"} instead.`,
        );
      }
      setModel(chosen);
      setModelsState("ready");
      log("info", `Model catalog loaded: ${list.length} entries`, {
        smallest: list[0] ?? null,
        selected: chosen,
      });
      return chosen;
    } catch (err) {
      setModelsState("failed");
      log("error", "discoverModels() failed", describeError(err));
      return null;
    }
  }, [descriptor, logger, log]);

  // A specifier typed into the picker rather than chosen from the list. It is
  // validated HERE, not at load, because the whole value of the check is
  // catching a typo before it becomes a several-hundred-megabyte request — and
  // the returned spec is what the input renders its error from.
  //
  // The entry is appended to `models` and then selected, so from this point on
  // nothing downstream can tell it apart from a curated one.
  const addCustomModel = useCallback(
    (input) => {
      if (!descriptor?.customModel) {
        return {
          ok: false,
          error: `${descriptor?.name} does not take a repo.`,
        };
      }
      const spec = parseGgufSpec(input);
      if (!spec.ok) {
        log("warn", `Ignoring "${String(input).trim()}": ${spec.error}`);
        return spec;
      }
      const entry = customEntryFor(descriptor, spec.id);
      setModels((prev) => {
        const list = prev ?? [];
        return list.some((m) => m.id === entry.id) ? list : [...list, entry];
      });
      setModel(entry.id);
      log("info", `Custom model selected: ${entry.id}`, {
        repo: spec.repo,
        file: spec.file,
        quant: spec.quant,
      });
      // The draft-head trap, said out loud. Nothing refuses the load; the log is
      // where a reader finds out why the reply was empty.
      if (spec.warning) log("warn", spec.warning);
      return spec;
    },
    [descriptor, log],
  );

  // --- teardown -------------------------------------------------------------
  const doUnload = useCallback(
    async ({ quiet = false } = {}) => {
      // Unload stays reachable mid-generation, because status is still "loaded".
      // Tearing an engine out from under a running stream produces an unhelpful
      // error at best, so stop first.
      if (abortRef.current) abortRef.current.abort();
      const handle = handleRef.current;
      if (handle) {
        try {
          const adapter = await loadAdapter(providerId, { log: logger });
          await adapter.unload?.({ handle, log: logger });
          if (!quiet) log("info", "unload() finished");
        } catch (err) {
          log("error", "unload() threw", describeError(err));
        }
      }
      // Dropped before anything can touch it again. This is not tidiness: a
      // disposed Transformers.js pipeline poisons every later load in the page if
      // it is called once more, so "the handle is gone" is a correctness
      // guarantee the adapter relies on.
      handleRef.current = null;
      messagesRef.current = [];
      setTurns([]);
      setStreaming(null);
      setDiscoveredContext(null);
      crumb("unload: done");
      applyStatus("not_loaded");
      setProgress(null);
    },
    [providerId, logger, log, applyStatus],
  );

  // --- provider switching ---------------------------------------------------
  const selectProvider = useCallback(
    async (nextId) => {
      if (nextId === providerId || switchingRef.current) return;
      switchingRef.current = true;
      try {
        // The outgoing runtime must be torn down, not abandoned. Several adapters
        // hold module-level state and two of them leak hard: an abandoned wllama
        // instance keeps its wasm heap and GPU buffers, which is what hard-killed
        // an iPhone tab on 2026-08-23.
        if (handleRef.current) {
          log("info", `Unloading ${providerId} before switching to ${nextId}`);
          await doUnload({ quiet: true });
        }
        const next = getDescriptor(nextId);
        setProviderId(nextId);
        trackNow({ provider: nextId });
        crumb(`provider: ${nextId}`);
        // Reset everything that is per-runtime. Notably the context control:
        // 4096 means n_ctx on wllama and maxNumTokens on LiteRT-LM, and means
        // nothing at all on Transformers.js.
        setModels(next?.models ?? null);
        setModelsState(
          next?.models
            ? "ready"
            : next?.modelChoice?.kind === "discovered"
              ? "idle"
              : "none",
        );
        // A deep-linked model belongs to the runtime it was linked with. Once the
        // reader picks a different one themselves, it is stale — and leaving it
        // set would apply it to a catalog it was never meant for.
        pendingModelRef.current = null;
        setModel(next?.models?.[0]?.id ?? null);
        setContext(initialContextFor(next));
        setDiscoveredContext(null);
        applyStatus("not_loaded");
        setProgress(null);
        runsRef.current = [];
        setRuns([]);
        // JSON mode does not survive a switch to a runtime that cannot enforce
        // it — leaving it on would silently downgrade from grammar-constrained
        // to asking politely, which is the one distinction this toggle exists to
        // make visible.
        if (jsonMode && !next?.json?.supported) {
          setJsonMode(false);
          log(
            "warn",
            `JSON mode turned off: ${next?.name} cannot enforce a schema.`,
          );
        }
      } finally {
        switchingRef.current = false;
      }
    },
    [providerId, doUnload, log, applyStatus, jsonMode],
  );

  // --- load -----------------------------------------------------------------
  // Returns true only if the runtime is actually loaded afterwards, so a caller
  // can chain on it.
  //
  // Resolving the model happens here rather than in the callers because for a
  // runtime whose catalog ships inside its own bundle there is no model selected
  // until that catalog is read — `model` is null on a fresh
  // `?runtime=web-llm`, and web-llm answers a null id with "Cannot find model
  // record in appConfig for null". Discovery already picks a default (smallest
  // first); it just has to be reached from every path that loads, not only Ask.
  const doLoad = useCallback(async () => {
    let targetModel = model;
    if (!targetModel && descriptor?.modelChoice?.kind === "discovered") {
      log("info", "Reading the model catalog before loading.");
      // Before applyStatus("loading"): discovery reports itself through
      // modelsState, and a failure here should leave the runtime not_loaded
      // rather than stuck at loading.
      targetModel = await discoverModels();
      if (!targetModel) return false;
    }
    applyStatus("loading");
    reportProgress(0, "starting");
    // The model is the thing most likely to kill the tab, so it goes into the
    // snapshot before the attempt rather than after it.
    trackNow({
      phase: "load",
      provider: providerId,
      model: targetModel,
      context,
      replyCap,
    });
    crumb("load: start", { provider: providerId, model: targetModel });
    const started = performance.now();

    try {
      const adapter = await loadAdapter(providerId, { log: logger });

      // check() first. A runtime that reports itself unavailable here is a
      // result, not an error — "this browser cannot do this at all" is one of the
      // five things the demo exists to show.
      if (adapter.check) {
        let ok = false;
        let result = null;
        try {
          result = await adapter.check({ log: logger });
          ok = result?.ok ?? Boolean(result);
        } catch (err) {
          log("error", "check() threw", describeError(err));
          ok = false;
        }
        log(
          ok ? "info" : "warn",
          ok
            ? "check() passed"
            : "check() says this runtime is unavailable here",
          result?.detail ?? result,
        );
        if (!ok) {
          applyStatus(
            "unavailable",
            typeof result?.detail === "string" ? result.detail : undefined,
          );
          reportProgress(null);
          return false;
        }
      }

      const handle = await adapter.load({
        model: targetModel,
        system,
        context,
        replyCap,
        log: logger,
        progress: reportProgress,
      });
      handleRef.current = handle;

      // Several runtimes can only tell you their real context budget after
      // loading — Chrome because it is per-device, wllama and LiteRT-LM because
      // the requested value may have been clamped. Surfaced so the control can
      // show what actually happened rather than what we asked for.
      if (handle?.discoveredContext) {
        setDiscoveredContext(handle.discoveredContext);
      }

      const elapsed = performance.now() - started;
      runsRef.current = [
        ...runsRef.current,
        {
          kind: "load",
          provider: providerId,
          model: targetModel,
          ms: Math.round(elapsed),
        },
      ];
      setRuns(runsRef.current);
      log("info", `load() finished in ${fmtMs(elapsed)}`);
      crumb("load: ok", { ms: Math.round(elapsed) });
      // Back to idle, or a recovered record reads as "died during load" for the
      // whole time the page then sat there loaded and doing nothing.
      trackNow({ phase: "idle", progress: null, progressText: null });
      reportProgress(null);
      applyStatus("loaded");
      return true;
    } catch (err) {
      const described = describeError(err);
      log(
        "error",
        `load() failed after ${fmtMs(performance.now() - started)}`,
        described,
      );
      // A load that throws is a survivable failure, so it lands in the log. It
      // still gets a breadcrumb, because the next thing that happens might not be.
      crumb("load: failed", {
        name: described.name,
        message: described.message,
      });
      handleRef.current = null;
      reportProgress(null);
      applyStatus("error", described.message);
      return false;
    }
  }, [
    providerId,
    model,
    descriptor,
    discoverModels,
    system,
    context,
    replyCap,
    logger,
    log,
    applyStatus,
    reportProgress,
  ]);

  // Load whatever this runtime needs in order to answer, if it is not loaded
  // already. doLoad handles reading a catalog where the model list lives inside
  // the library, so this is only the already-loaded short circuit.
  //
  // Keyed off handleRef rather than `status` deliberately — this runs inside an
  // async chain, and `status` closed over from the render that started it goes
  // stale the moment doLoad flips it. The ref is always current.
  const ensureLoaded = useCallback(async () => {
    if (handleRef.current) return true;
    return doLoad();
  }, [doLoad]);

  // --- streaming flush ------------------------------------------------------
  // See note 2 at the top of the file. Chunks land in a ref; this pushes the
  // accumulated text into state at most once per frame.
  const scheduleFlush = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setStreaming({ text: streamRef.current });
    });
  }, []);

  // --- ask ------------------------------------------------------------------
  const doAsk = useCallback(async () => {
    const asked = prompt.trim();
    if (!asked || abortRef.current || askingRef.current) return;

    // Ask loads on demand. Nothing about a demo is served by making someone
    // press two buttons in order, and the interesting failure — the load that
    // cannot finish on this device — is reached faster this way. If it fails,
    // `status` already carries the reason and there is nothing to ask.
    askingRef.current = true;
    const ready = await ensureLoaded();
    if (!ready) {
      askingRef.current = false;
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setPrompt("");

    // JSON mode is applied as prompt text for EVERY runtime, including the three
    // that can also constrain the grammar. That uniformity is the point: it keeps
    // the comparison like-for-like, and it is required even where the grammar
    // works — web-llm's own docs warn that a constrained model with no
    // instruction can emit an unending stream of whitespace until it hits the
    // token cap, which reads as a hang and is really a well-formed empty object.
    const effectivePrompt = jsonMode
      ? `${asked}\n\n${JSON_INSTRUCTION}`
      : asked;

    messagesRef.current = [
      ...messagesRef.current,
      { role: "user", content: effectivePrompt },
    ];
    const turn = messagesRef.current.filter((m) => m.role === "user").length;
    setTurns((t) => [...t, { role: "user", text: asked, jsonMode, turn }]);

    streamRef.current = "";
    setStreaming({ text: "" });

    trackNow({
      phase: "generate",
      turn,
      promptChars: effectivePrompt.length,
      prompt: effectivePrompt.slice(0, 200),
    });
    crumb(`generate: start turn ${turn}`, {
      promptChars: effectivePrompt.length,
    });

    const started = performance.now();
    let firstChunkAt = null;
    let chunks = 0;
    let runtimeStats = null;
    // What the adapter actually sent, and what it actually received. Deliberately
    // NOT part of the run record: run records go into the log and the diagnostics
    // copy, and a full resent history per turn would swamp both. This stays on
    // the turn, in memory, for the panel to read.
    let wireRecord = null;

    // Built in both the completed and the aborted path, so a stopped generation
    // produces the same shape of record as a finished one.
    const recordRun = (aborted) => {
      const text = streamRef.current;
      const total = performance.now() - started;
      const ttft = firstChunkAt === null ? null : firstChunkAt - started;
      // LiteRT-LM on the CPU backend computes the whole reply and then delivers
      // every chunk at once — 123 chunks in the last 3 ms of a 9-second turn.
      // Dividing by (total - ttft) there produced a nonsense 39677 chunks/sec, so
      // the adapter tells us whether it streamed and the rate is withheld rather
      // than published wrong.
      const streamsIncrementally =
        handleRef.current?.streamsIncrementally ?? true;
      const run = {
        kind: "generate",
        provider: providerId,
        model,
        turn,
        promptChars: effectivePrompt.length,
        replyChars: text.length,
        totalMs: Math.round(total),
        timeToFirstChunkMs: ttft === null ? null : Math.round(ttft),
        chunks,
        // Chunks, not tokens: a chunk is what we can actually observe. Null where
        // the runtime does not stream incrementally, because there the figure
        // describes our measurement rather than the runtime.
        chunksPerSecond:
          !streamsIncrementally || ttft === null || total === ttft
            ? null
            : Number((chunks / ((total - ttft) / 1000)).toFixed(1)),
        chunksPerSecondWithheld: !streamsIncrementally,
        runtimeReportedStats: runtimeStats,
        aborted,
        jsonRequested: jsonMode,
        // Whether the reply is usable prose, as a number rather than an
        // impression. See lib/quality.js.
        quality: textQuality(text),
      };
      // The partial reply is part of the conversation whether we stopped it or
      // not, and the next turn's prefix depends on it being here. An empty one is
      // not: stopping before the first chunk would otherwise leave a blank
      // assistant turn in the history, which some chat templates reject.
      if (text.length > 0) {
        messagesRef.current = [
          ...messagesRef.current,
          { role: "assistant", content: text },
        ];
      }
      runsRef.current = [...runsRef.current, run];
      setRuns(runsRef.current);
      return run;
    };

    const finish = (run) => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      // Read the accumulator BEFORE scheduling the update, not inside the
      // updater. React calls a functional setState lazily, during render — so an
      // updater that reaches for `streamRef.current` gets whatever is there
      // *then*, which is the empty string this function resets it to two lines
      // later. MEASURED in Chrome: a five-character reply rendered as an empty
      // turn while the run record correctly said replyChars: 5.
      const text = streamRef.current;
      setTurns((t) => [
        ...t,
        {
          role: "assistant",
          text,
          provider: providerId,
          run,
          turn,
          // `raw` falls back to the displayed text, because four of the five
          // adapters do not transform their output and so have no second version
          // of it to report. web-llm does — it strips a leading think block — and
          // the difference between these two is the only place that is visible.
          wire: {
            request: wireRecord?.request ?? null,
            raw: wireRecord?.raw ?? text,
            rawReported: wireRecord?.raw != null,
            note: wireRecord?.note ?? null,
          },
        },
      ]);
      setStreaming(null);
      streamRef.current = "";
    };

    try {
      const adapter = await loadAdapter(providerId, { log: logger });
      await adapter.generate({
        handle: handleRef.current,
        prompt: effectivePrompt,
        // The full history is always offered. The two runtimes that own their own
        // history (Chrome, LiteRT-LM) ignore it — and that difference is one of
        // the things this demo exists to surface.
        messages: messagesRef.current.slice(),
        system,
        turn,
        replyCap,
        json: jsonMode ? { schema: JSON_SCHEMA } : null,
        log: logger,
        signal: controller.signal,
        onChunk: (chunk) => {
          if (firstChunkAt === null) firstChunkAt = performance.now();
          chunks += 1;
          streamRef.current += chunk;
          scheduleFlush();
          // Coalesced to one write per 500 ms inside blackbox. Untangling "died
          // before the first token" from "died 300 tokens in" is the whole reason
          // this field exists.
          //
          // The TAIL of the reply rides along, because the transcript in the
          // diagnostics only helps a session that survives to be copied. MEASURED
          // 2026-08-23: three iPhone crash records came back with an empty
          // transcript, since the recovering page has no conversation of its own —
          // so for a session that dies mid-reply the text has to live in the crash
          // snapshot or nowhere. Tail rather than head: if the model is looping,
          // the tail is where the loop is visible.
          track({
            chunks,
            replyChars: streamRef.current.length,
            replyTail: streamRef.current.slice(-240),
          });
        },
        stats: (s) => {
          runtimeStats = s;
        },
        // Sanitized and copied on arrival rather than on render: `request` is the
        // live object an adapter is about to hand its library, and wllama's
        // carries an AbortSignal. Adapters may call this more than once — the
        // request before generating, the raw text after — so parts merge.
        wire: (part) => {
          wireRecord = { ...(wireRecord ?? {}), ...jsonSafe(part) };
        },
      });

      // A runtime may honor an abort by returning early rather than throwing —
      // web-llm's interruptGenerate() does exactly that — so the signal, not the
      // control flow, decides whether this was a stop.
      const run = recordRun(controller.signal.aborted);
      finish(run);
      if (run.quality?.looksDegenerate) {
        log(
          "warn",
          `Reply looks degenerate: ${degeneracyReason(run.quality)}`,
          run.quality,
        );
      }
      log(
        "info",
        controller.signal.aborted
          ? `generate() turn ${turn} stopped after ${chunks} chunks`
          : `generate() turn ${turn} complete`,
        run,
      );
      crumb(
        controller.signal.aborted
          ? `generate: stopped turn ${turn}`
          : `generate: ok turn ${turn}`,
        // From the run record, not the accumulator: finish() has already reset
        // streamRef by this point, so reading it here would breadcrumb a 0.
        { chunks, replyChars: run.replyChars },
      );
    } catch (err) {
      const described = describeError(err);
      if (controller.signal.aborted || described.name === "AbortError") {
        const run = recordRun(true);
        finish(run);
        log("info", `generate() turn ${turn} stopped after ${chunks} chunks`, {
          ...run,
          threw: described.name,
        });
      } else {
        log("error", `generate() failed on turn ${turn}`, described);
        crumb(`generate: failed turn ${turn}`, {
          name: described.name,
          message: described.message,
        });
        const run = recordRun(false);
        finish({ ...run, failed: described });
      }
    } finally {
      abortRef.current = null;
      askingRef.current = false;
      setGenerating(false);
      trackNow({ phase: "idle", chunks });
    }
  }, [
    prompt,
    ensureLoaded,
    jsonMode,
    providerId,
    model,
    system,
    replyCap,
    logger,
    log,
    scheduleFlush,
  ]);

  // --- new chat -------------------------------------------------------------
  // Clearing the transcript is the easy half. The other half is that two of the
  // five keep the conversation inside the runtime — a Chrome session, a LiteRT-LM
  // Conversation — so a page that only emptied `turns` would show a blank
  // conversation to a model that still remembers every word of the last one, and
  // the next reply would prove it. Those two get `resetConversation()`; the other
  // three have nothing of their own to clear beyond a cache.
  //
  // Deliberately not an unload: the weights stay resident, so this costs nothing
  // and the next turn starts immediately.
  const doNewChat = useCallback(async () => {
    // A turn in flight would land in the cleared transcript: doAsk holds its own
    // `turn` and appends when generate() returns, with no idea a reset happened
    // in between. Stop first, then start a new chat.
    if (askingRef.current) {
      log("warn", "New chat ignored: a turn is still running. Stop it first.");
      return;
    }

    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    streamRef.current = "";
    messagesRef.current = [];
    setTurns([]);
    setStreaming(null);
    crumb("new chat");

    if (!handleRef.current) {
      log("info", "New chat: transcript cleared. Nothing is loaded.");
      return;
    }

    try {
      const adapter = await loadAdapter(providerId, { log: logger });
      if (!adapter.resetConversation) {
        log(
          "info",
          `New chat: transcript cleared. ${descriptor?.name} holds no history of its own — it is re-sent from here each turn.`,
        );
        return;
      }
      const next = await adapter.resetConversation({
        handle: handleRef.current,
        log: logger,
      });
      // An adapter that rebuilds its session returns the replacement. Anything
      // still pointing at the old one is a use-after-free waiting to happen, so
      // the swap is here and not inside the adapter.
      if (next) {
        handleRef.current = next;
        if (next.discoveredContext != null) {
          setDiscoveredContext(next.discoveredContext);
        }
      }
      log("info", `New chat: ${descriptor?.name} conversation reset.`);
    } catch (err) {
      // The reset paths tear something down before they build its replacement,
      // so a failure can leave a handle that no longer works. Unloading is the
      // honest end state: "not loaded" is true, and Ask will build a new one.
      log(
        "error",
        "New chat failed; unloading so the status on screen is true",
        describeError(err),
      );
      await doUnload({ quiet: true });
    }
  }, [providerId, descriptor, logger, log, doUnload]);

  const doStop = useCallback(() => {
    if (!abortRef.current) return;
    log("info", "Stop requested; aborting generation");
    abortRef.current.abort();
  }, [log]);

  // --- diagnostics ----------------------------------------------------------
  const diagnostics = useCallback(
    () => ({
      capturedAt: new Date().toISOString(),
      surface: "unified demo",
      provider: {
        id: providerId,
        name: descriptor?.name ?? null,
        docs: descriptor?.docs ?? null,
      },
      // The settings a reader would need to reproduce this run. Recorded as they
      // are at capture time, which is why the context field distinguishes what we
      // asked for from what the runtime reported back.
      settings: {
        model,
        contextRequested: context,
        contextReported: discoveredContext,
        replyCap,
        system,
        jsonMode,
        jsonEnforced: jsonMode ? Boolean(descriptor?.json?.supported) : null,
      },
      status,
      statusDetail,
      device,
      runs,
      events,
      // The recovered record from a previous session that died, if any. This is
      // the only field here that can describe a run whose own diagnostics were
      // destroyed — so it must survive into the paste-back, or a device test that
      // killed the tab reports nothing at all.
      recoveredCrash,
      // crashbox's in-session observations: memory pressure and device-loss
      // events seen while this page has been alive.
      crashboxWarnings: warnings(),
      // The actual conversation, bounded per turn to keep the payload copyable on
      // a phone. Its absence cost us once: a reply scored as 513 characters
      // containing 2 words could not be read back, so what the model actually
      // emitted was unrecoverable. The article wants to quote degenerate output,
      // not just score it.
      transcript: messagesRef.current.map((m) => ({
        role: m.role,
        chars: m.content.length,
        text: m.content.slice(0, 600),
        truncated: m.content.length > 600,
      })),
    }),
    [
      providerId,
      descriptor,
      model,
      context,
      discoveredContext,
      replyCap,
      system,
      jsonMode,
      status,
      statusDetail,
      device,
      runs,
      events,
      recoveredCrash,
    ],
  );

  const copyDiagnostics = useCallback(async () => {
    // Local only. Nothing here is transmitted anywhere — the clipboard is the
    // whole delivery mechanism, by design.
    const text = JSON.stringify(diagnostics(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      log("info", "Diagnostics copied to clipboard");
    } catch (err) {
      log(
        "warn",
        "Clipboard write failed; dumping to console instead",
        describeError(err),
      );
      console.log(text);
    }
  }, [diagnostics, log]);

  // Toggling JSON mode is worth a log line rather than being silent, because on
  // two of the five it changes nothing about the decoding and only adds a
  // sentence to the prompt.
  const toggleJsonMode = useCallback(
    (next) => {
      setJsonMode(next);
      if (!next) return;
      log(
        descriptor?.json?.supported ? "info" : "warn",
        descriptor?.json?.supported
          ? `JSON mode on. ${descriptor.name} constrains the grammar via ${descriptor.json.field}; the schema is also sent in the prompt.`
          : `JSON mode on, but ${descriptor?.name} cannot enforce it. The schema is sent in the prompt only.`,
      );
    },
    [descriptor, log],
  );

  return {
    // identity
    providerId,
    descriptor,
    selectProvider,
    // lifecycle
    status,
    statusDetail,
    progress,
    generating,
    load: doLoad,
    unload: doUnload,
    ask: doAsk,
    stop: doStop,
    newChat: doNewChat,
    // model selection
    models,
    modelsState,
    discoverModels,
    model,
    setModel,
    addCustomModel,
    // knobs
    context,
    setContext,
    discoveredContext,
    replyCap,
    setReplyCap,
    system,
    setSystem,
    prompt,
    setPrompt,
    jsonMode,
    setJsonMode: toggleJsonMode,
    // output
    turns,
    streaming,
    runs,
    events,
    device,
    recoveredCrash,
    diagnostics,
    copyDiagnostics,
  };
};
