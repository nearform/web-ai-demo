// What a llama.cpp context costs, read from the buffer sizes it prints at load,
// and scaled to another context size.
//
// Read, not derived from the GGUF. A formula from metadata has to know every
// architecture's attention layout — Qwen3.5 keeps a KV cache on one layer in
// four and a fixed recurrent state on the rest, Gemma 4 caches most layers only
// for a sliding window — and llama.cpp already did that work when it allocated.
// So the page reports what was allocated and scales only the parts that grow.
//
// The lines this reads, from llama.cpp b10454 (one per backend where it says so):
//
//   llama_prepare_model_devices: using device WebGPU (WebGPU) (unknown id) - 4095 MiB free
//   load_tensors:       WebGPU model buffer size =   497.40 MiB
//   llama_kv_cache: size =   48.00 MiB (  4096 cells,   6 layers,  4/1 seqs), K (f16): ...
//   llama_memory_recurrent:     WebGPU RS buffer size =    77.06 MiB
//   sched_reserve:     WebGPU compute buffer size =    44.58 MiB
//
// A sliding-window model prints two llama_kv_cache lines: one sized to n_ctx,
// which grows, and one sized to the window, which does not.

const MIB = /=\s*([\d.]+) MiB/;

const sumOf = (lines, re) =>
  lines
    .filter((l) => re.test(l))
    .reduce((sum, l) => sum + Number(l.match(MIB)?.[1] ?? 0), 0);

/**
 * @param {string[]} lines native log lines from one load
 * @param {number} nCtx the context that load actually got
 * @param {number} nUbatch the micro-batch size that load used
 * @returns {null | { nCtx, nUbatch, weightsMiB, kvGrowingMiB, kvFixedMiB,
 *   recurrentMiB, computeMiB, computeBuffers, gpuMiB }}
 */
export const parseLlamaMemory = (lines, nCtx, nUbatch = 512) => {
  if (!nCtx || !lines?.length) return null;

  const weightsMiB = sumOf(lines, /model buffer size/);
  if (!weightsMiB) return null;

  // Split the KV caches by whether they hold every cell of the context.
  let kvGrowingMiB = 0;
  let kvFixedMiB = 0;
  for (const l of lines) {
    const m = /llama_kv_cache: size =\s*([\d.]+) MiB \(\s*(\d+) cells/.exec(l);
    if (!m) continue;
    if (Number(m[2]) >= nCtx) kvGrowingMiB += Number(m[1]);
    else kvFixedMiB += Number(m[1]);
  }

  // Not read: the "N MiB free" llama.cpp prints for the WebGPU device. It is
  // the adapter's largest single buffer, not a total, and a context whose
  // buffers add up to well past it loads and answers.
  return {
    nCtx,
    nUbatch,
    weightsMiB,
    kvGrowingMiB,
    kvFixedMiB,
    recurrentMiB: sumOf(lines, /RS buffer size/),
    computeMiB: sumOf(lines, /compute buffer size/),
    computeBuffers: lines.filter((l) => /compute buffer size/.test(l)).length,
    gpuMiB: sumOf(lines, /WebGPU\s+\S+ buffer size/),
  };
};

/**
 * The same model at another context size.
 *
 * The growing KV cache scales exactly with n_ctx. Each compute buffer grows by
 * n_ubatch f16 values per token of context — the attention mask — which
 * matched every load of three models from 4K to 256K to the MiB. Weights, the
 * sliding-window cache and recurrent state do not grow.
 */
export const estimateLlamaMemory = (measured, nCtx) => {
  if (!measured || !nCtx) return null;
  const delta = nCtx - measured.nCtx;
  const kvMiB =
    (measured.kvGrowingMiB * nCtx) / measured.nCtx + measured.kvFixedMiB;
  const computeGrowthMiB =
    (measured.computeBuffers * measured.nUbatch * 2 * delta) / 1048576;
  const otherMiB =
    measured.recurrentMiB + measured.computeMiB + computeGrowthMiB;
  const kvMeasuredMiB = measured.kvGrowingMiB + measured.kvFixedMiB;
  // Only the KV cache and the GPU's own compute buffer grow on the GPU side.
  const gpuMiB = measured.gpuMiB
    ? measured.gpuMiB +
      kvMiB -
      kvMeasuredMiB +
      computeGrowthMiB / measured.computeBuffers
    : null;
  return {
    nCtx,
    weightsMiB: measured.weightsMiB,
    kvMiB,
    otherMiB,
    totalMiB: measured.weightsMiB + kvMiB + otherMiB,
    gpuMiB,
    kvPerTokenKiB: (measured.kvGrowingMiB * 1024) / measured.nCtx,
  };
};
