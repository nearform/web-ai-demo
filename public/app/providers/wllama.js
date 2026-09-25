/* global navigator:false, WebAssembly:false, URL:false, console:false */

// wllama adapter (@wllama/wllama 3.6.0, llama.cpp b10454-4df29be).
//
// Verified against the 3.6.0 tarball source and its published types rather than
// remembered:
//   - new Wllama(pathConfig, wllamaConfig)  — pathConfig key is "default"
//   - loadModelFromHF({ repo, file | quant }, { n_ctx, progressCallback })
//   - createChatCompletion({ messages, stream, onData, cache_prompt, ... })
//   - response_format: { type: 'json_schema', json_schema: { name, schema } }
//   - chunk.choices[0].delta.content        — OpenAI-shaped
//   - exit()                                — spends the instance
//   - cacheManager / modelManager           — OPFS, shard-aware
//
// Four upgrade-path traps, all of which broke the earlier attempt. Each one is a
// line of code here, and getting any of them wrong looks like "wllama is broken"
// rather than "we called it wrong":
//   1. pathConfig takes a single "default" key. The v2 keys
//      ('single-thread/wllama.wasm', 'multi-thread/wllama.wasm') still exist on
//      the interface, marked deprecated, and are NOT read — loadModel throws
//      '"default" is missing from pathConfig'.
//   2. The streaming callback is onData. onNewToken was the v2 name.
//   3. n_ctx defaults to 1024, not the model's trained context, and n_ctx_auto
//      was removed in v3.0. Left at the default, multi-turn dies at turn two for
//      a reason that has nothing to do with the model.
//   4. Omit n_threads for auto. n_threads: -1 reads like "auto" and silently
//      DISABLES threading (useMultiThread = supportMultiThread && nbThreads > 1).
//
// Also: the CDN specifier must spell out /esm/index.js. package.json says
// "main": "index.js" but no such file exists at the package root, so the bare
// specifier 404s. And the README's `esm/wasm-from-cdn.js` import is not in the
// published package at all.

import { Wllama } from "@wllama/wllama";
import { ggufLoadParams } from "../util/hf-gguf.js";
import { parseLlamaMemory } from "../util/llama-memory.js";

// The WASM URL is DERIVED from the import map, never written down. wllama ships
// its JS and its WASM from one llama.cpp sync, so a hardcoded version here can
// silently pair new bindings with an old binary — which is exactly what a bump
// of the specifier in index.html used to leave behind.
//
// import.meta.resolve() applies this document's import map, so it returns the
// same URL the `@wllama/wllama` import above resolved to, version and all. The
// WASM then hangs off it as a relative path: esm/index.js → ../src/wasm/…
// There is nothing to keep in sync because there is no second copy.
const WLLAMA_ESM_URL = import.meta.resolve("@wllama/wllama");

// Fail loudly rather than fetching a 404 later. The relative hop above assumes
// the specifier still points at esm/index.js; if it ever points somewhere else,
// the derived path is wrong and this says so at load, naming what it got.
if (!/\/esm\/index(\.min)?\.js$/.test(new URL(WLLAMA_ESM_URL).pathname)) {
  throw new Error(
    `Cannot derive the wllama WASM URL: expected the @wllama/wllama specifier ` +
      `to resolve to esm/index.js, got ${WLLAMA_ESM_URL}`,
  );
}

const WASM_URL = new URL("../src/wasm/wllama.wasm", WLLAMA_ESM_URL).href;

// The instance is the state. exit() nulls its internal proxy, so a spent Wllama
// cannot be reloaded — load() must construct a fresh one or loadModel throws
// 'Module is already initialized'.
let wllama = null;
let lastSystem = null;

export default {
  id: "wllama",

  check: async ({ log }) => {
    // These are the same two probes src/utils.ts uses, and together they predict
    // which binary will load: needCompat() = !isSupportJSPI() || !isSupportMem64().
    // The default build is Memory64 + JSPI; Safari gets the Asyncify compat build,
    // auto-fetched from jsDelivr with no code change on our side. Worth logging
    // because "which build ran" changes what every number below means.
    const jspi = typeof WebAssembly.Suspending === "function";
    let mem64 = false;
    try {
      // `initial` must be a BigInt when address is "i64" — a Number throws, so
      // passing 1 instead of 1n reports a false negative and mispredicts the
      // build. This is exactly what src/utils.ts does.
      new WebAssembly.Memory({ address: "i64", initial: 1n });
      mem64 = true;
    } catch {
      // Memory64 unsupported here; mem64 stays false, so compat is predicted.
    }
    const needCompat = !jspi || !mem64;

    // SIMD is unconditional in this build — checkEnvironmentCompatible() throws
    // outright without wasm exceptions or SIMD, so a failure here is terminal
    // rather than a slow path.
    const webgpu = "gpu" in navigator;
    let adapter = null;
    if (webgpu) {
      try {
        adapter = await navigator.gpu.requestAdapter();
      } catch {
        adapter = null;
      }
    }

    log.info("wasm and GPU feature probe", {
      jspi,
      memory64: mem64,
      predictedBuild: needCompat ? "compat (Asyncify, slower)" : "default",
      webgpuGlobal: webgpu,
      webgpuAdapter: adapter !== null,
      // Threading needs SharedArrayBuffer, which needs COOP/COEP. Absent it,
      // pthreadPoolSize goes to 0 and it falls back to single-thread CPU — no
      // error, just slower. WebGPU is independent of SAB entirely.
      crossOriginIsolated: globalThis.crossOriginIsolated ?? false,
      sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    });

    if (needCompat) {
      log.warn(
        "Compat build predicted. Note its pointers are Number-typed with no >>> 0 coercion, so issue #204's overflow may still bite past a 2 GiB heap here.",
      );
    }
    if (!webgpu) {
      log.warn("No navigator.gpu — expect single-threaded CPU inference.");
    }

    // Report, don't gate: CPU-only is a legitimate outcome worth measuring.
    return { ok: true, detail: { jspi, memory64: mem64, webgpu } };
  },

  load: async ({ model, context, log, progress }) => {
    // An id is either `repo|file.gguf` or `repo:QUANT` — see util/hf-gguf.js for
    // why both, and why the parser is not in this file.
    const hf = ggufLoadParams(model);

    // Free the OUTGOING instance before building a new one. This was a real bug,
    // and it cost a measurement: on 2026-08-23 an iPhone run loaded a 398 MiB model
    // over an already-resident 218 MiB one and the tab was hard-killed during init.
    // Reassigning `wllama` drops our reference but frees nothing on its own — the
    // wasm heap and the GPU buffers belong to the old module, and GC of an
    // Emscripten instance holding a GPUDevice is neither prompt nor guaranteed. A
    // 128 GB desktop never notices; a phone dies. exit() is safe to call when
    // nothing is loaded, so this is unconditional.
    if (wllama) {
      try {
        await wllama.exit();
        log.info("freed the previously loaded model before loading a new one");
      } catch (err) {
        log.warn("exit() on the previous instance threw", {
          message: String(err),
        });
      }
      wllama = null;
    }

    // A fresh instance every load — see the note on `wllama` above.
    // parallelDownloads lives on the CONSTRUCTOR's second argument, not the load
    // call, which is easy to get wrong from the docs.
    //
    // The logger is the default (console) plus a copy of each line, because the
    // buffer sizes llama.cpp prints at load are the only measure of what this
    // context costs in memory.
    const nativeLines = [];
    const tee =
      (fn) =>
      (...args) => {
        nativeLines.push(args.join(" "));
        fn(...args);
      };
    wllama = new Wllama(
      { default: WASM_URL },
      {
        parallelDownloads: 3,
        logger: {
          debug: tee(console.debug),
          log: tee(console.log),
          warn: tee(console.warn),
          error: tee(console.error),
        },
      },
    );

    // Cache state before we touch the network. This is the closest thing wllama
    // has to "is it already downloaded", and it is shard-aware where
    // cacheManager.list() returns raw per-shard files.
    let cachedCount = null;
    try {
      const cached = await wllama.modelManager.getModels();
      cachedCount = cached.length;
      log.info(`modelManager reports ${cached.length} cached model(s)`, {
        models: cached.map((m) => ({ url: m.url, size: m.size })),
      });
    } catch (err) {
      log.warn("modelManager.getModels() failed", { message: String(err) });
    }

    log.info(`loadModelFromHF(${JSON.stringify(hf)})`, {
      n_ctx: context,
    });

    await wllama.loadModelFromHF(hf, {
      // Trap 3. Must be explicit, and the UI control is why it is a variable
      // here rather than a constant: on a phone the KV cache is often what
      // exhausts memory before the weights do.
      n_ctx: context,
      // n_threads deliberately omitted — see trap 4.
      progressCallback: ({ loaded, total }) => {
        if (total) {
          progress(
            loaded / total,
            `${Math.round(loaded / 1048576)} / ${Math.round(total / 1048576)} MB`,
          );
        }
      },
    });

    // Everything here is a claim the article might make, answered by the runtime
    // itself rather than by us: which build ran, whether threads happened,
    // whether WebGPU is actually in play, and the real context window.
    log.info("model loaded", {
      libllama: Wllama.getLibllamaVersion?.() ?? null,
      multithread: wllama.isMultithread?.() ?? null,
      threads: wllama.getNumThreads?.() ?? null,
      supportWebGPU: wllama.isSupportWebGPU?.() ?? null,
      hasChatTemplate: Boolean(wllama.getChatTemplate?.()),
      cachedModelsBefore: cachedCount,
    });

    let discoveredContext = null;
    let contextCeiling = null;
    let memory = null;
    try {
      const info = await wllama.getLoadedContextInfo();
      // n_ctx read back off the runtime, not echoed from our request — a
      // silently clamped context shows up here and nowhere else.
      discoveredContext = info.n_ctx ?? null;
      // The length the model was trained to, which is where the slider stops.
      contextCeiling = info.n_ctx_train ?? null;
      memory = parseLlamaMemory(nativeLines, info.n_ctx, info.n_ubatch);
      log.info("memory at load, from llama.cpp buffer sizes", memory);
      log.info("loaded context info", {
        n_ctx: info.n_ctx,
        n_ctx_train: info.n_ctx_train,
        n_vocab: info.n_vocab,
        n_layer: info.n_layer,
      });
      if (info.n_ctx && context && info.n_ctx !== context) {
        log.warn(
          `Requested n_ctx ${context} but the runtime reports ${info.n_ctx} — it was clamped.`,
        );
      }
    } catch (err) {
      log.warn("getLoadedContextInfo() failed", { message: String(err) });
    }

    return { wllama, discoveredContext, contextCeiling, memory };
  },

  generate: async ({
    handle,
    messages,
    system,
    json,
    tools,
    replyCap,
    onChunk,
    stats,
    wire,
    log,
    signal,
  }) => {
    const instance = handle.wllama;

    if (lastSystem !== null && lastSystem !== system) {
      log.warn(
        "System prompt changed since the last turn — the cached prefix no longer matches, so expect a full re-prefill",
      );
    }
    lastSystem = system;

    // Multi-turn is stateless from the caller's side: a system message is just a
    // message, and the whole array is resent every turn. Prefix reuse is the
    // runtime's job, requested via cache_prompt.
    const payload = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages,
    ];

    const buildRequest = () => {
      const request = {
        messages: payload,
        stream: true,
        // Without this a turn runs until it hits EOG or exhausts n_ctx, and a small
        // model asked "what is node.js?" will happily produce 10,000 characters —
        // which reads as a hang, not as an answer. Measured: 2304 chunks / 9948
        // chars in 20.7s before a human gave up and hit Stop.
        max_tokens: replyCap,
        // Qwen3.5's chat template takes an `enable_thinking` flag, and the GGUF
        // build behaves as though it defaults ON even though the model card says
        // non-thinking is the default: asked "what is node.js?" it spent its whole
        // budget emitting "Thinking Process: 1. Analyze the Request..." as ordinary
        // content and never reached an answer. Templates that do not know the flag
        // ignore it.
        chat_template_kwargs: { enable_thinking: false },
        // cache_prompt is a pass-through to llama-server, and timings_per_token is
        // what makes cache_n visible per chunk. Together they are how you tell
        // whether prefix reuse actually happens across turns.
        cache_prompt: true,
        timings_per_token: true,
        abortSignal: signal,
      };

      if (tools) {
        // No load-time flag turns this on — upstream's own examples/tools page
        // loads with nothing but a progress callback. The whole options object
        // is JSON.stringify'd into the WASM, so `tools` lands in llama-server's
        // handler and the GGUF's template decides whether anything comes back.
        request.tools = tools.declarations.map((d) => ({
          type: "function",
          function: d,
        }));
        request.tool_choice = "auto";
      }

      if (json) {
        // Note the shape difference from web-llm: `schema` here is an object, not
        // a JSON string. Same-looking field, different contract.
        request.response_format = {
          type: "json_schema",
          json_schema: { name: "answer", schema: json.schema },
        };
        log.info("response_format: json_schema (pass-through to llama-server)");
      }
      return request;
    };

    // Usage and timings may arrive on the last chunk or be sprinkled per chunk
    // depending on timings_per_token, so keep the most recent sighting of each
    // rather than trusting one position in the stream.
    let usage = null;
    let timings = null;
    let reasoningChars = 0;
    let contentChars = 0;
    let toolCallsMade = 0;
    const requestsSent = [];

    const reportStats = () =>
      stats({
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        // These two are the ones to watch across turns. If they grow
        // monotonically, prefix reuse works; if they reset on alternating turns,
        // issue #174 still bites.
        cachedPromptTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
        timingsCacheN: timings?.cache_n ?? null,
        prefillTokensPerSecond: timings?.prompt_per_second ?? null,
        decodeTokensPerSecond: timings?.predicted_per_second ?? null,
        // Split out, because on a reasoning model these diverge wildly and a
        // chunks-per-second figure that lumps them together says nothing.
        reasoningChars,
        contentChars,
        historyResentByUs: true,
        jsonConstrained: Boolean(json),
        toolsDeclared: tools ? tools.declarations.length : 0,
        toolCallsMade,
        requestsThisTurn: requestsSent.length,
        runtimeReportsItsOwnRates: true,
        // Kept raw so a shape we didn't anticipate is still visible in the
        // diagnostics rather than silently flattened to nulls again.
        rawUsage: usage,
        rawTimings: timings,
      });

    // The whole loop is wrapped so that stats() still fires when the user stops a
    // generation. It previously sat after the loop, so an abort threw straight
    // past it and every token count, rate and cache figure came back null — on
    // exactly the runs where "what was it doing when I gave up" is the question.
    try {
      const maxRounds = tools ? (tools.maxRounds ?? 4) : 1;
      for (let round = 1; round <= maxRounds; round += 1) {
        const request = buildRequest();
        // A SNAPSHOT of the history, not the live array. `payload` is mutated
        // between rounds — the assistant's tool_calls and the tool result are
        // pushed onto it — and the panel renders these after the turn ends, so
        // holding the reference would show round 1 carrying messages that did
        // not exist when round 1 was sent. The panel's whole job is to be exact.
        requestsSent.push({ ...request, messages: [...payload] });
        // `abortSignal` is a live object rather than data, so it shows in the panel
        // as a marker naming its type. Everything else here is verbatim.
        wire?.({
          request: requestsSent.length === 1 ? request : requestsSent,
          note:
            requestsSent.length === 1
              ? "The whole history is resent every turn. Reasoning arrives as ordinary content on this runtime and cannot be filtered, so it is shown as part of the answer."
              : "One entry per round trip: the model asked for a tool, the result went back as a `tool` message, and the whole history was resent. Reasoning arrives as ordinary content and is shown as part of the answer.",
        });

        // Deliberately NOT using the onData overload. With onData supplied,
        // createChatCompletion resolves to void — measured, not assumed: the first
        // run of this spike reported every token figure as null because of it. The
        // async-iterator overload (omit onData with stream: true) is the only shape
        // that exposes the final chunk, which is where usage and timings ride.
        const stream = await instance.createChatCompletion(request);

        // Fragments keyed by `index`, exactly as upstream's tool example
        // accumulates them: the name and the arguments both arrive in pieces.
        const collected = new Map();
        let finishReason = null;

        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          finishReason = choice?.finish_reason ?? finishReason;
          const delta = choice?.delta ?? {};

          // Reasoning models put their thinking on a separate channel, and reading
          // only `content` can make a turn look completely dead: measured on
          // Qwen3.5-0.8B at Q2_K_XL, 4050 tokens over 37s with zero visible output.
          if (delta.reasoning_content) {
            reasoningChars += delta.reasoning_content.length;
            onChunk(delta.reasoning_content);
          }
          if (delta.content) {
            contentChars += delta.content.length;
            onChunk(delta.content);
          }
          for (const tc of delta.tool_calls ?? []) {
            const entry = collected.get(tc.index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments)
              entry.arguments += tc.function.arguments;
            collected.set(tc.index, entry);
          }

          if (chunk.usage) usage = chunk.usage;
          if (chunk.timings) timings = chunk.timings;
        }

        const calls = [...collected.values()];
        if (finishReason !== "tool_calls" || calls.length === 0) break;
        if (signal?.aborted) break;

        payload.push({
          role: "assistant",
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          })),
        });

        for (const call of calls) {
          let args = {};
          try {
            args = JSON.parse(call.arguments);
          } catch (err) {
            log.warn(
              `Tool arguments did not parse as JSON: ${call.arguments}`,
              {
                message: String(err),
              },
            );
          }
          const result = await tools.call(call.name, args);
          toolCallsMade += 1;
          payload.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }

        if (round === maxRounds) {
          log.warn(
            `Stopped after ${maxRounds} tool round(s) without a final answer. The tool results are in the history; the model never came back with prose.`,
          );
        }
      }
    } finally {
      if (reasoningChars > 0 && contentChars === 0) {
        log.warn(
          `All ${reasoningChars} chars were reasoning and no answer followed — the turn ran out of budget mid-thought. max_tokens ${replyCap}.`,
        );
      }
      reportStats();
    }
  },

  unload: async ({ handle, log }) => {
    // exit() frees the model and all memory, and will not throw if nothing was
    // loaded. But it nulls the internal proxy, so the instance is spent —
    // "unloaded" and "reusable" are not the same state here, which is why load()
    // constructs a fresh Wllama every time.
    await handle?.wllama?.exit?.();
    wllama = null;
    lastSystem = null;
    log.info(
      "exit() returned — the instance is now spent; a reload constructs a fresh Wllama. Weights stay in OPFS.",
    );
  },
};
