/* global navigator:false, WebAssembly:false */

// Spike: wllama (@wllama/wllama 3.6.0, llama.cpp b10454-4df29be)
//
// Verified against the 3.6.0 tarball source rather than remembered:
//   - new Wllama(pathConfig, wllamaConfig)  — pathConfig key is "default"
//   - loadModelFromHF({ repo, file }, { n_ctx, progressCallback })
//   - createChatCompletion({ messages, stream, onData, cache_prompt, ... })
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
//
// What this spike is here to establish, beyond "does it run":
//   1. Whether trap 1 was the whole story.
//   2. Whether a ~200-460 MB GGUF loads on an iPhone 15 Pro. The arXiv paper
//      "Llamas on the Web" reports <500 MB of Safari tab memory and only its four
//      smallest models fitting — but its harness streams weights from OPFS into
//      GPU buffers, which is NOT in released wllama. So released wllama may do
//      worse, and this is the highest-value single test in the project.
//   3. Whether cache_prompt actually reuses the prefix across turns, or whether
//      issue #174 (prompt cache resetting on alternating turns) still bites. The
//      stats below report cached_tokens and timings.cache_n per turn so the
//      answer is readable off five consecutive asks.
//   4. Whether GBNF grammar / response_format work at all — both are
//      pass-throughs to llama-server with zero upstream test coverage.

import { Wllama } from "@wllama/wllama";
import { runSpike } from "./lib/harness.js";

const WLLAMA_VERSION = "3.6.0";
const WASM_URL = `https://cdn.jsdelivr.net/npm/@wllama/wllama@${WLLAMA_VERSION}/src/wasm/wllama.wasm`;

// n_ctx has to be explicit (trap 3). 4096 is a deliberate compromise: big enough
// that a five-turn conversation is a real test of prefix reuse, small enough that
// the KV cache is not itself the thing that exhausts a phone.
const N_CTX = 4096;

// Cap on one reply. Uncapped, a turn runs to EOG or to the end of n_ctx, and a
// small model asked "what is node.js?" produced 9948 characters in 2304 chunks
// before a human gave up and hit Stop. Bounding it also protects the multi-turn
// test: one runaway answer otherwise consumes the context budget that turns 2-5
// are supposed to be measuring.
const MAX_TOKENS = 512;

// Selected per the repo-wide policy in ../../MODELS.md: Gemma 4 yes, Gemma 3 and
// earlier never (license), latest Qwen with a browser-sized variant, at least one
// entry inside the iPhone budget, language models only. Sizes are bytes off the
// Hugging Face tree API, checked 2026-08-21 — not the arXiv paper's rounded
// figures and not our estimates.
//
// Careful when re-pinning these: `mtp-*` files in these repos are multi-token
// prediction draft heads and `mmproj-*` are vision projectors. Both are far
// smaller than the model and both sort to the top if you order by size.
const MODELS = [
  {
    // The one that should comfortably fit a phone.
    id: "LiquidAI/LFM2.5-350M-GGUF|LFM2.5-350M-Q4_K_M.gguf",
    label: "LFM2.5-350M Q4_K_M",
    sizeMb: 218,
  },
  {
    // Latest Qwen, squeezed to sit at the ~400 MB iPhone budget.
    id: "unsloth/Qwen3.5-0.8B-GGUF|Qwen3.5-0.8B-UD-Q2_K_XL.gguf",
    label: "Qwen3.5-0.8B Q2_K_XL (iPhone budget edge)",
    sizeMb: 398,
  },
  {
    // Same model at an honest quant — the size/quality pair with the one above.
    id: "unsloth/Qwen3.5-0.8B-GGUF|Qwen3.5-0.8B-Q4_K_M.gguf",
    label: "Qwen3.5-0.8B Q4_K_M",
    sizeMb: 507,
  },
  {
    // Desktop, and the test of whether the 2 GB single-file ceiling really is
    // retired on the Memory64 build — a claim wllama's own README contradicts.
    id: "unsloth/Qwen3.5-4B-GGUF|Qwen3.5-4B-Q4_K_M.gguf",
    label: "Qwen3.5-4B Q4_K_M (>2 GiB — desktop only)",
    sizeMb: 2613,
  },
  {
    // Rule 1. Expected to be marginal: wllama keeps the whole model in main
    // memory even when layers are offloaded to the GPU, against a 4 GiB wasm
    // ceiling, so this may simply not load. Finding either way.
    id: "ggml-org/gemma-4-E2B-it-GGUF|gemma-4-E2B-it-Q4_0.gguf",
    label: "Gemma 4 E2B Q4_0 (desktop only)",
    sizeMb: 2709,
  },
];

// The instance is the state. exit() nulls its internal proxy, so a spent Wllama
// cannot be reloaded — load() must construct a fresh one or loadModel throws
// 'Module is already initialized'.
let wllama = null;
let lastSystem = null;

const parseModelId = (id) => {
  const [repo, file] = id.split("|");
  return { repo, file };
};

runSpike({
  name: "wllama",
  docs: "https://github.com/ngxson/wllama",
  notes:
    "llama.cpp compiled to WASM, WebGPU on by default since 3.1. The only one of the five that loads Hugging Face GGUFs directly, and the only one where the iPhone test could come back positive.",
  models: MODELS,

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

  load: async ({ model, log, progress }) => {
    const { repo, file } = parseModelId(model);

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
    wllama = new Wllama({ default: WASM_URL }, { parallelDownloads: 3 });

    // Cache state before we touch the network. This is the closest thing wllama
    // has to "is it already downloaded", and it is shard-aware where
    // cacheManager.list() returns raw per-shard files. Logged as data rather than
    // wired into the UI — the three-state cache model is a unified-demo decision
    // and one runtime is not enough evidence to design it from.
    try {
      const cached = await wllama.modelManager.getModels();
      log.info(`modelManager reports ${cached.length} cached model(s)`, {
        models: cached.map((m) => ({ url: m.url, size: m.size })),
      });
    } catch (err) {
      log.warn("modelManager.getModels() failed", { message: String(err) });
    }

    log.info(`loadModelFromHF({ repo: "${repo}", file: "${file}" })`, {
      n_ctx: N_CTX,
    });

    await wllama.loadModelFromHF(
      { repo, file },
      {
        n_ctx: N_CTX,
        // n_threads deliberately omitted — see trap 4.
        progressCallback: ({ loaded, total }) => {
          if (total) {
            progress(
              loaded / total,
              `${Math.round(loaded / 1048576)} / ${Math.round(total / 1048576)} MB`,
            );
          }
        },
      },
    );

    // Everything here is a claim the article might make, answered by the runtime
    // itself rather than by us: which build ran, whether threads happened,
    // whether WebGPU is actually in play, and the real context window.
    log.info("model loaded", {
      libllama: Wllama.getLibllamaVersion?.() ?? null,
      multithread: wllama.isMultithread?.() ?? null,
      threads: wllama.getNumThreads?.() ?? null,
      supportWebGPU: wllama.isSupportWebGPU?.() ?? null,
      hasChatTemplate: Boolean(wllama.getChatTemplate?.()),
    });

    try {
      const info = await wllama.getLoadedContextInfo();
      log.info("loaded context info", {
        n_ctx: info.n_ctx,
        n_ctx_train: info.n_ctx_train,
        n_vocab: info.n_vocab,
        n_layer: info.n_layer,
      });
    } catch (err) {
      log.warn("getLoadedContextInfo() failed", { message: String(err) });
    }

    return wllama;
  },

  generate: async ({
    handle,
    messages,
    system,
    onChunk,
    stats,
    log,
    signal,
  }) => {
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

    // Deliberately NOT using the onData overload. With onData supplied,
    // createChatCompletion resolves to void — measured, not assumed: the first
    // run of this spike reported every token figure as null because of it. The
    // async-iterator overload (omit onData with stream: true) is the only shape
    // that exposes the final chunk, which is where usage and timings ride.
    const stream = await handle.createChatCompletion({
      messages: payload,
      stream: true,
      // Without this a turn runs until it hits EOG or exhausts n_ctx, and a small
      // model asked "what is node.js?" will happily produce 10,000 characters —
      // which reads as a hang, not as an answer. Measured: 2304 chunks / 9948
      // chars in 20.7s before a human gave up and hit Stop. A cap is not a
      // cosmetic nicety here; an uncapped turn also eats the context budget that
      // the multi-turn test depends on.
      max_tokens: MAX_TOKENS,
      // Qwen3.5's chat template takes an `enable_thinking` flag, and the GGUF
      // build behaves as though it defaults ON even though the model card says
      // non-thinking is the default: asked "what is node.js?" it spent its whole
      // budget emitting "Thinking Process: 1. Analyze the Request..." as ordinary
      // content and never reached an answer. Turning it off is what makes a small
      // reasoning-capable model usable in a chat demo at all. Templates that do
      // not know the flag ignore it.
      chat_template_kwargs: { enable_thinking: false },
      // The issue #174 test. cache_prompt is a pass-through to llama-server, and
      // timings_per_token is what makes cache_n visible per chunk.
      cache_prompt: true,
      timings_per_token: true,
      abortSignal: signal,
    });

    // Usage and timings may arrive on the last chunk or be sprinkled per chunk
    // depending on timings_per_token, so keep the most recent sighting of each
    // rather than trusting one position in the stream.
    let usage = null;
    let timings = null;
    let reasoningChars = 0;
    let contentChars = 0;

    const reportStats = () =>
      stats({
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        // These two are the ones to watch across five turns. If they grow
        // monotonically, prefix reuse works and #174 is fixed by the v3 rewrite.
        // If they reset on alternating turns, it is not.
        cachedPromptTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
        timingsCacheN: timings?.cache_n ?? null,
        prefillTokensPerSecond: timings?.prompt_per_second ?? null,
        decodeTokensPerSecond: timings?.predicted_per_second ?? null,
        // Split out, because on a reasoning model these diverge wildly and a
        // chunks-per-second figure that lumps them together says nothing.
        reasoningChars,
        contentChars,
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
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta ?? {};

        // Reasoning models put their thinking on a separate channel, and reading
        // only `content` can make a turn look completely dead: measured on
        // Qwen3.5-0.8B at Q2_K_XL, 4050 tokens over 37s with zero visible output.
        // Note Qwen3.5 is non-thinking BY DEFAULT — thinking is opt-in via
        // chat_template_kwargs: { enable_thinking: true } — so a long reply here
        // is usually just a long reply, not deliberation.
        if (delta.reasoning_content) {
          reasoningChars += delta.reasoning_content.length;
          onChunk(delta.reasoning_content);
        }
        if (delta.content) {
          contentChars += delta.content.length;
          onChunk(delta.content);
        }

        if (chunk.usage) usage = chunk.usage;
        if (chunk.timings) timings = chunk.timings;
      }
    } finally {
      if (reasoningChars > 0 && contentChars === 0) {
        log.warn(
          `All ${reasoningChars} chars were reasoning and no answer followed — the turn ran out of budget mid-thought. n_ctx ${N_CTX}, max_tokens ${MAX_TOKENS}.`,
        );
      }
      reportStats();
    }
  },

  unload: async ({ handle, log }) => {
    // exit() frees the model and all memory, and will not throw if nothing was
    // loaded. But it nulls the internal proxy, so the instance is spent — this is
    // one of the three places the plan expects a unified `unload` to leak, and
    // the leak is that "unloaded" and "reusable" are not the same state here.
    await handle?.exit?.();
    wllama = null;
    lastSystem = null;
    log.info(
      "exit() returned — the instance is now spent; a reload constructs a fresh Wllama. Weights stay in OPFS.",
    );
  },
});
