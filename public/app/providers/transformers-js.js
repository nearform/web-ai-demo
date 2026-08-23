/* global navigator:false, performance:false */

// Transformers.js adapter (@huggingface/transformers 4.2.0, ONNX Runtime Web).
//
// Verified against the 4.2.0 source and its published types rather than
// remembered:
//   - pipeline("text-generation", modelId, { dtype, device, progress_callback })
//   - progress_callback gets SIX status variants; "progress_total" is the v4 one
//     that gives a single end-to-end figure
//   - new TextStreamer(tokenizer, { skip_prompt, callback_function })
//   - new InterruptableStoppingCriteria() + .interrupt()
//   - generator(messages, { max_new_tokens, streamer, stopping_criteria })
//   - chat input -> output[0].generated_text.at(-1).content
//   - env.backends.onnx.wasm.wasmPaths is an OBJECT ({ mjs, wasm }), not a string
//   - GenerationConfig has NO grammar or response-format field; `constraints` is
//     the beam-search token-forcing port, which cannot enforce a schema
//
// THE FOOTGUN, and it is not subtle: device default dtype is `wasm` -> q8,
// everything else -> **fp32**. So `device: "webgpu"` with no dtype silently loads
// fp32 weights, which is roughly 4x the download and the proximate cause of the
// std::bad_alloc in issue #1518. dtype is always explicit below.

import {
  pipeline,
  TextStreamer,
  InterruptableStoppingCriteria,
  env,
} from "@huggingface/transformers";
import { trackNow } from "../../lib/blackbox.js";

// dtype is `q4`, NOT `q4f16`, and that is a measured decision rather than a
// preference. On WebGPU in Chrome 151, q4f16 made SmolLM2-135M emit **zero
// tokens** — the pipeline resolved, generated_text came back as a well-formed
// message array, and the last message was empty. Same model, same device, dtype
// q4: "Hello, welcome to Hugging Face." LFM2.5-350M at q4f16 managed 5
// characters. So q4f16 is quietly broken here for at least some models, and it
// fails by producing nothing rather than by throwing. Related upstream: #1599
// (q4f16 ~3x slower decode on WebGPU) and #1416 (rotary attention errors).
const DTYPE = "q4";

// The stopping criteria object, which is this runtime's only cancellation
// mechanism. Module-scoped so an abort arriving between turns cannot reach a
// stale one.
let stopper = null;

export default {
  id: "transformers-js",

  check: async ({ log }) => {
    // Which ORT artifacts were selected is the whole Safari story, so read it
    // rather than infer it. On Safari, 4.2.0 picks the non-asyncify build here.
    const wasmPaths = env?.backends?.onnx?.wasm?.wasmPaths ?? null;
    const asyncify =
      typeof wasmPaths?.wasm === "string"
        ? wasmPaths.wasm.includes("asyncify")
        : null;

    // Into the crash snapshot, not just the log. MEASURED WHY, 2026-08-23: an
    // iPhone run was killed mid-load and the recovered record could not say which
    // ORT build had been selected — log events die with the tab, only breadcrumbs
    // and the snapshot survive. Which build ran is the entire Safari story (4.2.0
    // hands Safari the non-asyncify build, which has no webgpuInit; issue #1604,
    // PR #1700 merged and unreleased), so it has to be in the part that outlives
    // the renderer.
    trackNow({
      ortAsyncify: asyncify,
      ortWasmPath: typeof wasmPaths?.wasm === "string" ? wasmPaths.wasm : null,
      dtype: DTYPE,
    });

    log.info("ORT artifact selection as this browser resolved it", {
      wasmPaths,
      isObject: wasmPaths !== null && typeof wasmPaths === "object",
      asyncify,
      proxy: env?.backends?.onnx?.wasm?.proxy ?? null,
      powerPreference: env?.backends?.onnx?.webgpu?.powerPreference ?? null,
      useWasmCache: env?.useWasmCache ?? null,
    });

    if (!("gpu" in navigator)) {
      log.warn(
        "navigator.gpu is undefined — WebGPU is unavailable, so this will fall back to single-threaded WASM and be very slow.",
      );
      return { ok: true, detail: "no WebGPU; wasm fallback" };
    }

    const adapter = await navigator.gpu.requestAdapter();
    const f16 = adapter?.features?.has?.("shader-f16") ?? false;
    log.info("WebGPU adapter", {
      acquired: adapter !== null,
      shaderF16: f16,
      note: "q4f16 needs shader-f16; without it, use dtype q4",
    });
    if (!f16) {
      log.warn("shader-f16 absent — the q4f16 models below will likely fail");
    }
    // Report rather than gate: a wasm-only run is a legitimate measurement.
    return { ok: true, detail: { shaderF16: f16 } };
  },

  load: async ({ model, log, progress }) => {
    const useWebGpu = "gpu" in navigator;
    // dtype ALWAYS explicit — see the footgun note at the top of this file, and
    // the DTYPE note for why it is q4 rather than q4f16.
    const dtype = DTYPE;
    const device = useWebGpu ? "webgpu" : "wasm";
    log.info(`pipeline("text-generation", "${model}")`, { dtype, device });

    const generator = await pipeline("text-generation", model, {
      dtype,
      device,
      progress_callback: (p) => {
        // Six variants arrive; progress_total is the only one that describes the
        // whole load rather than one file of many. Gemma 4 here is eight files,
        // so per-file progress would jump backwards repeatedly.
        if (p.status === "progress_total") {
          const frac = typeof p.progress === "number" ? p.progress / 100 : 0;
          progress(
            frac,
            `${Math.round((p.loaded ?? 0) / 1048576)} / ${Math.round((p.total ?? 0) / 1048576)} MB`,
          );
        } else if (p.status === "ready") {
          progress(1, "ready");
        }
      },
    });

    log.info("pipeline ready", {
      device,
      dtype,
      hasTokenizer: Boolean(generator.tokenizer),
      // The KV-cache question: Transformers.js is handed the whole history every
      // turn like wllama, but unlike wllama it exposes no cache counters at all,
      // so there is nothing to read.
      reportsCacheCounters: false,
      // Nor any context figure. This is the one runtime where the demo cannot
      // tell you what the budget is, which is why its context control is absent
      // rather than read-only.
      reportsContextWindow: false,
    });

    return generator;
  },

  generate: async ({
    handle,
    messages,
    system,
    json,
    replyCap,
    onChunk,
    stats,
    log,
    signal,
  }) => {
    if (json) {
      // Stated every turn rather than once, because a JSON-shaped reply that
      // happens to parse would otherwise look like enforcement. There is no
      // grammar here: the schema reached the model as an instruction in the
      // prompt and nothing constrains the tokens.
      log.warn(
        "JSON requested in the prompt only. GenerationConfig has no grammar or response-format field, so the schema is not enforced.",
      );
    }

    // A system message is just a message, first in the array; the pipeline calls
    // apply_chat_template for us. Multi-turn is stateless from our side: the whole
    // conversation goes over every turn, as with wllama and web-llm.
    const conversation = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages,
    ];

    // There is no AbortSignal in this API. InterruptableStoppingCriteria is the
    // documented way, and it stops at the next token boundary.
    stopper = new InterruptableStoppingCriteria();
    const onAbort = () => {
      log.info("InterruptableStoppingCriteria.interrupt()");
      stopper?.interrupt();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let tokenCount = 0;
    const streamer = new TextStreamer(handle.tokenizer, {
      // skip_prompt matters: return_full_text defaults true, so without this the
      // prompt is streamed back at us before the reply.
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text) => {
        if (text) onChunk(text);
      },
      token_callback_function: (tokens) => {
        tokenCount += tokens?.length ?? 1;
      },
    });

    const startedAt = performance.now();
    try {
      const output = await handle(conversation, {
        max_new_tokens: replyCap,
        streamer,
        stopping_criteria: stopper,
      });

      // Chat input gives back the full message array, so the reply is the last
      // message's content — not a bare string.
      const reply = output?.[0]?.generated_text;
      const finalText = Array.isArray(reply)
        ? (reply.at(-1)?.content ?? "")
        : String(reply ?? "");
      log.info("generation returned", {
        shape: Array.isArray(reply) ? "message array" : typeof reply,
        finalChars: finalText.length,
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
      const elapsedS = (performance.now() - startedAt) / 1000;
      // This runtime reports nothing about itself, so every figure here is ours,
      // counted from the streamer. That asymmetry is labelled rather than hidden:
      // web-llm, wllama and LiteRT-LM give their own rates, this does not.
      stats({
        tokensCountedByUs: tokenCount,
        tokensPerSecondCountedByUs:
          elapsedS > 0 ? Number((tokenCount / elapsedS).toFixed(1)) : null,
        maxNewTokens: replyCap,
        historyResentByUs: true,
        // False even when JSON mode is on — the instruction went in the prompt,
        // but no grammar constrained the tokens.
        jsonConstrained: false,
        runtimeReportsItsOwnRates: false,
      });
      stopper = null;
    }
  },

  unload: async ({ handle, log }) => {
    // There IS a teardown path, and it is undocumented outside the source, where
    // it cascades three levels:
    //   Pipeline.dispose() -> PreTrainedModel.dispose()
    //     -> for each of this.sessions: session.release()   (ORT's own teardown)
    // plus a tensor-level dispose that frees anything with location "gpu-buffer".
    //
    // Verified: after this, inference on the same pipeline throws
    // `cannot run inference. invalid session id: N`, so the session really is gone,
    // and a fresh pipeline for the same model loads and runs normally.
    //
    // THE SHARP EDGE, measured: if anything calls the disposed pipeline before the
    // reload, that failed call poisons the next load — it fails with the *same*
    // stale session id, for the life of the page. So dispose is safe only if the
    // handle is never touched again. The controller guarantees that: it drops the
    // handle and disables Ask the moment unload returns.
    try {
      await handle?.dispose?.();
      log.info(
        "pipeline.dispose() returned — ORT session released. Weights stay in the HTTP cache and env.useWasmCache keeps the WASM binary, so a reload is fast.",
      );
    } catch (err) {
      log.error("dispose() threw", { message: String(err) });
    }
    stopper = null;
    log.warn(
      "A disposed pipeline must not be called again; doing so affects later loads in this page.",
    );
  },
};
