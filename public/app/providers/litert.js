/* global navigator:false, WebAssembly:false, fetch:false, caches:false, Response:false, TransformStream:false, performance:false */

// LiteRT-LM adapter (@litert-lm/core 0.15.0).
//
// FIRST, THE NAME. This stop was originally called "LiteRT.js" and that was the
// wrong product. LiteRT.js (`@litertjs/core`) runs general `.tflite` models and
// its own docs send LLM users away. The LLM path is **LiteRT-LM**
// (`@litert-lm/core`), documented at developers.google.com/edge/litert-lm/js.
// MediaPipe's LLM Inference API — the older third name — is banner-flagged
// maintenance-only and points here too. Three names, one of them ours to get
// right.
//
// Verified against the shipped 0.15.0 tarball (`dist/*.js`, `dist/*.d.ts`) and
// against Google's own chat demo bundle, rather than remembered:
//   - Engine.create({ model, backend, mainExecutorSettings, benchmarkEnabled })
//   - model accepts string | Blob | ReadableStream<Uint8Array>
//   - engine.createConversation({ sessionConfig, preface, ... })
//   - conversation.sendMessageStreaming(msg) -> ReadableStream<Message>, and it
//     takes NO options argument — which is why there is no JSON mode here
//   - chunks are DELTAS; content is `string | ContentPart[]`; reasoning arrives
//     on `channels.thought`
//   - conversation.getBenchmarkInfo() -> prefill/decode tok/s + TTFT
//   - conversation.delete(), engine.delete(), unloadLiteRtLm()
//
// THE LIVE BLOCKER, and it is not ours: **`@litert-lm/core@0.16.0` is an empty
// publish** — one file, `package.json`, no `dist/`, no `wasm/` — and it is still
// what `dist-tags.latest` points at (re-checked 2026-08-22). So Google's own
// quickstart URL, `https://cdn.jsdelivr.net/npm/@litert-lm/core/+esm`, returns
// **404**, and `npm i @litert-lm/core` installs nothing usable. v0.16.1 is tagged
// on GitHub and never published. Hence the pin in index.html, which is
// load-bearing rather than tidy.
//
// The WASM survives that breakage only because it is pinned *in source*:
// `LiteRtLm.DEFAULT_WASM_PATH = '…/@litert-lm/core@0.15.0/wasm'`. Four builds
// ship and `dist/load.js` picks one from two probes (relaxedSimd × JSPI) — see
// check(), which predicts the choice, because which binary ran changes what every
// number here means.
//
// Backend.GPU is deliberately NOT offered. It is reported to crash the tab;
// nothing in the docs or the source supports that, and testing it should be a
// separate deliberate act rather than something a reader stumbles into.
//
// MEASURED 2026-08-22, and both of these surprised us:
//   - **On Backend.CPU, `sendMessageStreaming` does not actually stream.** The
//     whole reply is computed and then every chunk arrives at once: 123 chunks in
//     the last 3 ms of a 9144 ms turn. `setSingleThreadedExecution(true)` is
//     unconditional in engine.js, so with no JSPI suspension points on the CPU
//     path the WASM call never yields and the callbacks queue up. GPU_ARTISAN
//     streams properly (first chunk at 38-47 ms). So a chunks-per-second figure
//     is meaningless on CPU — read the two timings, not the rate. The controller
//     suppresses the rate for this reason.
//   - **`enable_thinking: false` is per-model, not per-runtime.** Gemma 4 E2B
//     honours it across five turns; MiniCPM5-1B ignores it and emits visible
//     `<think>` blocks — as ordinary `content`, with `channels.thought` empty. So
//     the tidy reasoning channel this runtime offers only helps for models that
//     populate it.

import { Engine, Backend, unloadLiteRtLm } from "@litert-lm/core";

// Hand-rolled, because the runtime caches nothing. That is not an omission we are
// working around blind — `dist/engine_settings.js` calls
// `setCacheDir(':nocache')` unconditionally, with the comment "Not supported in
// JS.", and Google's own demo carries its own `caches.open('litertlm-models')`
// for exactly this reason. Same cache name as the demo, so a model pulled by
// either is a hit for both.
const CACHE_NAME = "litertlm-models";

let bakedSystem = null;

const parseModelId = (id) => {
  const [backendName, url] = id.split("|");
  return { backendName, backend: Backend[backendName], url };
};

const mb = (bytes) => Math.round(bytes / 1048576);

// The relaxedSimd probe, byte-for-byte from `dist/wasm_feature_detect.js`.
// Copied rather than imported because that module is not re-exported from the
// package index — and predicting the build is worth a copied constant, since
// the compat and asyncify variants differ by 11 MiB of binary and a slower
// execution model.
const WASM_RELAXED_SIMD_CHECK = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1,
  13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11,
]);

// The library's own selection logic, mirrored so we can log which of the four
// binaries is about to load. From `dist/load.js`.
const predictWasmBuild = (relaxedSimd, jspi) => {
  if (relaxedSimd) {
    return jspi
      ? "litertlm_wasm_internal (19 MiB)"
      : "litertlm_wasm_asyncify_internal (31 MiB)";
  }
  return jspi
    ? "litertlm_wasm_compat_internal (19 MiB)"
    : "litertlm_wasm_compat_asyncify_internal (30 MiB)";
};

// There is no progress callback anywhere in this API — `modelToStream()` does a
// bare `fetch()` and hands the body straight to the runtime. Because `model`
// accepts a ReadableStream, running our own fetch is the documented-by-omission
// way to get both a progress bar and a cache. It is also the only hook where an
// `Authorization` header could go, which is what a gated repo would need.
//
// Cache-then-read rather than tee: `cache.put()` streams to disk, so a 1.9 GB
// model never sits in memory twice. Cost is one extra pass over the cached bytes
// on first load; the payoff is that the second load is disk-speed.
const openModelStream = async ({ url, log, progress }) => {
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch (err) {
    log.warn("caches.open() failed — proceeding without a cache", {
      message: String(err),
    });
  }

  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      log.info("Cache Storage hit — no download", {
        contentLength: hit.headers.get("content-length"),
      });
      progress(1, "from Cache Storage");
      return { stream: hit.body, cacheState: "on_disk" };
    }
    log.info("Cache Storage miss — downloading", { cache: CACHE_NAME });
  }

  const counted = (response) => {
    const total = Number(response.headers.get("content-length")) || 0;
    let loaded = 0;
    return response.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          loaded += chunk.byteLength;
          if (total)
            progress(loaded / total, `${mb(loaded)} / ${mb(total)} MB`);
          controller.enqueue(chunk);
        },
      }),
    );
  };

  const response = await fetch(url);
  if (!response.ok) {
    // HF returns 401 here for a gated repo, which is a policy failure and not a
    // technical one — worth reading as such rather than as "the model is broken".
    throw new Error(`Model fetch failed: HTTP ${response.status} for ${url}`);
  }

  if (!cache) return { stream: counted(response), cacheState: "absent" };

  try {
    // Headers are copied so content-length survives, which is what the progress
    // bar reads on the next load.
    await cache.put(
      url,
      new Response(counted(response), { headers: response.headers }),
    );
  } catch (err) {
    // Quota is the expected failure at 1-2 GB. The body is spent by now, so this
    // costs a second download — reported rather than hidden, since "you will
    // download it twice" is the honest cost of a runtime that caches nothing.
    log.warn(
      "cache.put() failed; re-fetching uncached. This model will re-download on every load.",
      { message: String(err) },
    );
    const retry = await fetch(url);
    if (!retry.ok) {
      // The cache failure is the interesting half of this, so it travels with
      // the HTTP status rather than being replaced by it.
      throw new Error(`Model re-fetch failed: HTTP ${retry.status}`, {
        cause: err,
      });
    }
    return { stream: counted(retry), cacheState: "absent" };
  }

  const stored = await cache.match(url);
  if (!stored) throw new Error("cache.put() resolved but cache.match() missed");
  return { stream: stored.body, cacheState: "on_disk" };
};

export default {
  id: "litert",

  check: async ({ log }) => {
    // Which of the four WASM builds is about to load, predicted with the
    // library's own two probes. This is the iOS story in one line: 0.13.x was
    // JSPI-only and threw `new WebAssembly.Suspending` on Safari (issue #2616);
    // 0.15.0 ships the Asyncify builds and selects them when JSPI is absent. So
    // a Safari run that reports an asyncify build here has cleared the blocker
    // that used to stop it dead.
    const jspi = "Suspending" in WebAssembly;
    let relaxedSimd = false;
    try {
      await WebAssembly.instantiate(WASM_RELAXED_SIMD_CHECK);
      relaxedSimd = true;
    } catch {
      // Not supported here; the compat build is predicted below.
    }

    const webgpu = "gpu" in navigator;
    let adapter = null;
    if (webgpu) {
      try {
        // high-performance, because that is what litertlm_web.js asks for.
        adapter = await navigator.gpu.requestAdapter({
          powerPreference: "high-performance",
        });
      } catch {
        adapter = null;
      }
    }

    log.info("wasm build prediction and GPU probe", {
      relaxedSimd,
      jspi,
      predictedBuild: predictWasmBuild(relaxedSimd, jspi),
      webgpuGlobal: webgpu,
      webgpuAdapter: adapter !== null,
      // createDefaultWebGpuDevice() requests these two when the adapter has
      // them, and requests the adapter's own maxBufferSize as a required limit —
      // so a device that reports a small buffer gets a small buffer, with no
      // padding and no guessing on our side.
      shaderF16: adapter?.features?.has?.("shader-f16") ?? null,
      subgroups: adapter?.features?.has?.("subgroups") ?? null,
      maxBufferSizeMb: adapter?.limits?.maxBufferSize
        ? mb(adapter.limits.maxBufferSize)
        : null,
      // Threading is not in play at all: no threaded artifact ships, and
      // setSingleThreadedExecution(true) is unconditional in engine.js. Which is
      // why this one needs no COOP/COEP and runs on plain GitHub Pages — as
      // Google's own demo does.
      singleThreadedByConstruction: true,
    });

    // Disk, not GPU. A 1-2 GB model has to land somewhere, and the cache we
    // hand-roll above is the thing that will hit a quota wall first.
    try {
      const est = await navigator.storage?.estimate?.();
      if (est) {
        log.info("storage estimate", {
          usageMb: mb(est.usage ?? 0),
          quotaMb: mb(est.quota ?? 0),
          persisted: (await navigator.storage?.persisted?.()) ?? null,
        });
      }
    } catch (err) {
      log.warn("storage.estimate() failed", { message: String(err) });
    }

    if (!webgpu) {
      log.warn(
        "No navigator.gpu. GPU_ARTISAN and GPU both call setupDefaultWebGpuDevice(), which throws 'No GPU adapter found.' — only the CPU entries can work here.",
      );
    }
    // Report, don't gate: a CPU-backend run is a legitimate measurement.
    return { ok: true, detail: { relaxedSimd, jspi, webgpu } };
  },

  load: async ({ model, system, context, replyCap, log, progress }) => {
    const { backendName, backend, url } = parseModelId(model);
    if (backend === undefined) {
      throw new Error(`Unknown backend in model id: ${backendName}`);
    }

    const isWebPackaged = url.includes("-web.litertlm");
    log.info(`Engine.create with Backend.${backendName}`, {
      url,
      webPackaged: isWebPackaged,
      // Stated before the attempt so the log reads as a prediction rather than a
      // rationalisation.
      path:
        backend === Backend.GPU_ARTISAN
          ? "streaming (ModelAssets.createStreaming) — the path with the two 'not supported yet' errors"
          : "VFS (loadModelToVfs + ModelAssets.create) — never touches the section reader, peak memory ~3x file size",
      wasmFrom:
        "DEFAULT_WASM_PATH, pinned in source to @0.15.0/wasm — not to the broken 'latest'",
    });
    if (backend === Backend.GPU_ARTISAN && !isWebPackaged) {
      log.warn(
        "Non-`-web` file on the streaming path; expect a 'Streaming ... section is not supported yet' error.",
      );
    }

    const { stream, cacheState } = await openModelStream({
      url,
      log,
      progress,
    });
    progress(null);
    log.info("model bytes ready", { cacheState });

    // Engine.create loads the WASM itself on first call, via
    // getOrLoadGlobalLiteRtLm(). No separate loadLiteRtLm() needed — and calling
    // it ourselves would throw 'already loading / loaded' on a second load.
    const started = performance.now();
    const engine = await Engine.create({
      model: stream,
      backend,
      mainExecutorSettings: { maxNumTokens: context },
      // Required for getBenchmarkInfo() to return anything. It maps to
      // wasmEngineSettings.enableBenchmark(), and without it every prefill and
      // decode rate reads as zero — which is exactly how a zero gets mistaken
      // for a measurement.
      benchmarkEnabled: true,
    });
    const settingsContext =
      engine.settings?.mainExecutorSettings?.maxNumTokens ?? null;
    log.info(
      `Engine.create() returned in ${Math.round(performance.now() - started)}ms`,
      {
        // Read back off the engine rather than echoed from our own request, so a
        // silently clamped context shows up here.
        settings: {
          backend: engine.settings?.backend ?? null,
          maxNumTokens: settingsContext,
        },
      },
    );
    if (settingsContext && context && settingsContext !== context) {
      log.warn(
        `Requested maxNumTokens ${context} but the engine reports ${settingsContext} — it was clamped.`,
      );
    }

    // The system prompt is baked in HERE, at conversation construction, in
    // `preface.messages` — exactly like Chrome's initialPrompts and unlike the
    // other three, where it is a per-turn message. A mid-conversation edit does
    // nothing, so we remember what was baked and say so when it changes.
    bakedSystem = system;
    const conversation = await engine.createConversation({
      // maxOutputTokens is set HERE, not per turn — the only one of the five
      // where the reply cap is a load-time decision.
      sessionConfig: { maxOutputTokens: replyCap },
      preface: {
        messages: system ? [{ role: "system", content: system }] : undefined,
        // Where thinking gets switched off. Not a documented field on the JS
        // page — this is how Google's own chat demo does it, read off its bundle.
        // Repo-wide policy, see MODELS.md: a small model given a 512-token
        // budget will spend all of it deliberating and never answer.
        extra_context: { enable_thinking: false },
      },
      // Prefill the system prompt at construction rather than on the first turn,
      // so turn 1's time-to-first-token measures turn 1 and not the preface.
      prefillPrefaceOnInit: true,
    });
    log.info("conversation created", {
      systemPromptBakedIn: Boolean(system),
      historyOwner:
        "the Conversation. Like Chrome, unlike web-llm/wllama/Transformers.js — we must NOT resend messages.",
      tokenCount: await conversation.getTokenCount(),
    });

    return {
      engine,
      conversation,
      discoveredContext: settingsContext,
      // The controller uses this to suppress its chunks-per-second figure: on
      // CPU the whole reply arrives in one burst at the end, so the rate is an
      // artefact of the measurement rather than a property of the runtime.
      streamsIncrementally: backend === Backend.GPU_ARTISAN,
      backendName,
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
    if (bakedSystem !== null && bakedSystem !== system) {
      log.warn(
        "System prompt edited, but it is fixed in the conversation preface. This turn uses the original; unload and load to change it.",
        { bakedSystem, requested: system },
      );
    }
    if (json) {
      log.warn(
        "JSON requested in the prompt only. sendMessageStreaming() takes no options, so the schema is not enforced.",
      );
    }

    // Only the new turn goes over the wire. The Conversation holds the history
    // inside the WASM, so the controller's `messages` is deliberately unused —
    // and that divergence is one of the findings.
    const stream = handle.conversation.sendMessageStreaming(prompt);
    const reader = stream.getReader();

    let thoughtChars = 0;
    let contentChars = 0;
    let chunkShape = null;

    const onAbort = () => {
      // reader.cancel() is not optional bookkeeping. It runs the stream's cancel
      // handler, which calls conversation.cancelProcess() AND clears the
      // conversation's private `isBusy` flag. Breaking out of the loop without it
      // leaves isBusy true, and every later turn throws
      // 'Conversation is busy. A generation is already in progress.' for the life
      // of the page.
      log.info("reader.cancel() — cancels generation and clears isBusy");
      reader.cancel("stopped by user").catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        // Chunks are deltas, not cumulative snapshots — confirmed from the
        // official demo, which does `text += chunk`. Getting this backwards
        // produces a reply that reads as a stutter.
        if (typeof value.channels?.thought === "string") {
          // Reasoning rides on its own channel here, which is a nicer shape than
          // wllama (where it arrives as ordinary content and cannot be filtered).
          // Surfaced rather than hidden, because a turn that is all thought and no
          // answer otherwise looks dead.
          thoughtChars += value.channels.thought.length;
          onChunk(value.channels.thought);
        }
        if (value.content) {
          // `content` is `string | ContentPart[]`, and both shapes turn up.
          const text =
            typeof value.content === "string"
              ? value.content
              : (value.content[0]?.text ?? "");
          if (chunkShape === null) {
            chunkShape = typeof value.content === "string" ? "string" : "parts";
          }
          contentChars += text.length;
          onChunk(text);
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);

      // In a finally, so an abort still reports. This bit the wllama spike first:
      // stats() sat after the loop, an abort threw straight past it, and every
      // figure came back null on exactly the runs worth reading.
      let bench = null;
      try {
        bench = await handle.conversation.getBenchmarkInfo();
      } catch (err) {
        log.warn("getBenchmarkInfo() failed", { message: String(err) });
      }
      let tokenCount = null;
      try {
        // Cumulative for the whole conversation, so across turns this is the
        // context-budget readout — the one number that says how many turns are
        // left of maxNumTokens.
        tokenCount = await handle.conversation.getTokenCount();
      } catch (err) {
        log.warn("getTokenCount() failed", { message: String(err) });
      }

      stats({
        // The runtime's own rates, not ours.
        prefillTokensPerSecond: bench?.lastPrefillTokensPerSecond ?? null,
        prefillTokenCount: bench?.lastPrefillTokenCount ?? null,
        decodeTokensPerSecond: bench?.lastDecodeTokensPerSecond ?? null,
        decodeTokenCount: bench?.lastDecodeTokenCount ?? null,
        timeToFirstTokenSeconds: bench?.timeToFirstTokenInSecond ?? null,
        // Watch this across turns: it should grow by roughly the tokens of each
        // exchange. If prefillTokenCount stays small while this climbs, the KV
        // cache is being reused and per-turn cost is flat.
        conversationTokenCount: tokenCount,
        thoughtChars,
        contentChars,
        contentChunkShape: chunkShape,
        backend: handle.backendName,
        historyResentByUs: false,
        jsonConstrained: false,
        runtimeReportsItsOwnRates: true,
        rawBenchmarkInfo: bench,
      });

      if (thoughtChars > 0 && contentChars === 0) {
        log.warn(
          `All ${thoughtChars} chars arrived on channels.thought and no answer followed — the turn ran out of budget mid-thought despite enable_thinking: false.`,
        );
      }
    }
  },

  unload: async ({ handle, log }) => {
    // Order matters: the conversation holds a session against the engine, so it
    // goes first. engine.delete() then runs the Cleanup chain built during
    // create() — deleting the wasm Engine, the ModelAssets, and FS.unlink()ing
    // any staged VFS file.
    try {
      await handle?.conversation?.delete();
      log.info("conversation.delete() returned — history and session freed");
    } catch (err) {
      log.error("conversation.delete() threw", { message: String(err) });
    }
    try {
      await handle?.engine?.delete();
      log.info(
        "engine.delete() returned — wasm engine, ModelAssets and any staged VFS file freed",
      );
    } catch (err) {
      log.error("engine.delete() threw", { message: String(err) });
    }
    bakedSystem = null;

    // Deliberately NOT called: unloadLiteRtLm() would drop the WASM module too,
    // costing a 19-31 MiB re-download on the next load. So "unloaded" here means
    // three separable things — engine gone, module still resident, weights still
    // in Cache Storage.
    log.info(
      "WASM module left resident; weights left in Cache Storage. unloadLiteRtLm() exists and would drop the module.",
      { moduleUnloadAvailable: typeof unloadLiteRtLm === "function" },
    );
  },
};
