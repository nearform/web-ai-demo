/* global navigator:false */

// Spike: web-llm (@mlc-ai/web-llm 0.2.84)
//
// Verified against the 0.2.84 source rather than remembered:
//   - CreateMLCEngine(modelId, { initProgressCallback, logLevel }, chatOpts)
//   - InitProgressReport = { progress, timeElapsed, text }
//   - engine.chat.completions.create({ messages, stream, stream_options })
//   - usage.extra.{ prefill_tokens_per_s, decode_tokens_per_s, time_to_first_token_s }
//   - engine.unload()
// The published bundle is self-contained (no bare-specifier imports, no
// SharedArrayBuffer), so a plain static host with no COOP/COEP is enough.
//
// Two things this spike is here to establish, beyond "does it run":
//   1. The catalog is read from prebuiltAppConfig at runtime, not hardcoded — so
//      what shows up in the picker IS the answer to "what can you actually load".
//   2. web-llm is the only one of the five that reports its own prefill and
//      decode token rates. Everywhere else we count chunks. That asymmetry is
//      worth a line in the article.

import * as webllm from "@mlc-ai/web-llm";
import { runSpike } from "./lib/harness.js";

// web-llm is functional per call: the whole history goes over on every request.
// It reuses the KV cache only if it detects the history is an extension of the
// last one — so editing the system prompt mid-conversation silently throws away
// the cache and re-prefills everything. Tracked so the log can say when.
let lastSystem = null;

runSpike({
  name: "web-llm",
  docs: "https://github.com/mlc-ai/web-llm",
  notes:
    "MLC-compiled weights over WebGPU. Model list is read from the library's own prebuiltAppConfig at load time.",
  defaultPrompt: "In one sentence, what is WebGPU?",

  loadModels: async ({ log }) => {
    const list = webllm.prebuiltAppConfig?.model_list ?? [];
    log.info(`prebuiltAppConfig declares ${list.length} models`, {
      modelVersion: webllm.modelVersion ?? null,
    });
    // Smallest first: a spike wants the cheapest thing that could work.
    return list
      .slice()
      .sort((a, b) => (a.vram_required_MB ?? 1e9) - (b.vram_required_MB ?? 1e9))
      .map((m) => ({
        id: m.model_id,
        label: m.model_id,
        // vram_required_MB as the library declares it — not a download size, and
        // not our estimate. Labelled honestly in the picker.
        sizeMb: m.vram_required_MB ?? null,
      }));
  },

  check: async ({ log }) => {
    if (!("gpu" in navigator)) {
      return { ok: false, detail: "navigator.gpu is undefined — no WebGPU" };
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { ok: false, detail: "requestAdapter() resolved to null" };
    }
    const f16 = adapter.features?.has?.("shader-f16") ?? false;
    // Most q4f16_1 models declare required_features: ["shader-f16"]. Report it
    // rather than gating on it — the point is to find out what actually happens.
    log.info("WebGPU adapter acquired", {
      shaderF16: f16,
      maxBufferSizeMb: adapter.limits?.maxBufferSize
        ? Math.floor(adapter.limits.maxBufferSize / (1024 * 1024))
        : null,
    });
    if (!f16) {
      log.warn(
        "shader-f16 is absent; q4f16_1 models will likely refuse to load",
      );
    }
    return { ok: true, detail: { shaderF16: f16 } };
  },

  load: async ({ model, log, progress }) => {
    log.info(`CreateMLCEngine("${model}")`);
    return webllm.CreateMLCEngine(model, {
      logLevel: "WARN",
      initProgressCallback: (report) => {
        progress(report.progress, report.text);
      },
    });
  },

  generate: async ({ handle, messages, system, onChunk, stats, log }) => {
    if (lastSystem !== null && lastSystem !== system) {
      log.warn(
        "System prompt changed since the last turn — web-llm will discard the KV cache and re-prefill the whole history",
      );
    }
    lastSystem = system;

    const payload = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages,
    ];

    const chunks = await handle.chat.completions.create({
      messages: payload,
      stream: true,
      stream_options: { include_usage: true },
    });

    for await (const chunk of chunks) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) onChunk(delta);
      // Usage arrives only in the final chunk, and only because
      // stream_options.include_usage asked for it.
      if (chunk.usage) {
        stats({
          promptTokens: chunk.usage.prompt_tokens ?? null,
          completionTokens: chunk.usage.completion_tokens ?? null,
          prefillTokensPerSecond:
            chunk.usage.extra?.prefill_tokens_per_s ?? null,
          decodeTokensPerSecond: chunk.usage.extra?.decode_tokens_per_s ?? null,
          timeToFirstTokenSeconds:
            chunk.usage.extra?.time_to_first_token_s ?? null,
          endToEndLatencySeconds: chunk.usage.extra?.e2e_latency_s ?? null,
        });
      }
    }
  },

  unload: async ({ handle, log }) => {
    // unload() disposes the pipelines and destroys the WebGPU device. The
    // downloaded weights stay cached — freeing those is a separate question the
    // unified demo will have to answer.
    await handle?.unload?.();
    lastSystem = null;
    log.info("engine.unload() returned — weights remain cached on disk");
  },
});
