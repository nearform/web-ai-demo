/* global navigator:false, WebAssembly:false, crossOriginIsolated:false */

// Device probe. Reports what the browser will actually give us, with no
// interpretation and no guessing: every field is either read from an API or
// marked unavailable. Numbers we cannot read do not get defaults.
//
// This is the instrument the article's memory claims have to come from, so
// nothing here is allowed to infer. `maxBufferSize` is what the adapter says,
// not what we believe a device can handle.

const MB = 1024 * 1024;

const toMb = (bytes) =>
  typeof bytes === "number" ? Math.floor(bytes / MB) : null;

// WebAssembly SIMD: the shortest valid module using a v128 local.
const SIMD_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8,
  0, 65, 0, 253, 15, 253, 98, 11,
]);

const hasSimd = () => {
  try {
    return WebAssembly.validate(SIMD_MODULE);
  } catch {
    return false;
  }
};

// iPadOS 13+ reports itself as a Mac; touch points disambiguate. Reported as an
// observation, not used to gate anything in a spike — the point of the spikes is
// to find out what the device does, not to pre-decide it.
export const looksLikeIos = () => {
  const ua = navigator.userAgent ?? "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return ua.includes("Mac") && (navigator.maxTouchPoints ?? 0) > 1;
};

const probeWebGpu = async () => {
  if (!("gpu" in navigator)) {
    return { available: false, reason: "navigator.gpu is undefined" };
  }

  let adapter;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch (err) {
    return { available: false, reason: `requestAdapter threw: ${err.message}` };
  }

  if (!adapter) {
    return { available: false, reason: "requestAdapter resolved to null" };
  }

  const limits = adapter.limits ?? {};

  return {
    available: true,
    // adapter.info is not universally implemented; report what is there.
    info: adapter.info
      ? {
          vendor: adapter.info.vendor ?? null,
          architecture: adapter.info.architecture ?? null,
          device: adapter.info.device ?? null,
          description: adapter.info.description ?? null,
        }
      : null,
    features: {
      "shader-f16": adapter.features?.has?.("shader-f16") ?? null,
      subgroups: adapter.features?.has?.("subgroups") ?? null,
      "timestamp-query": adapter.features?.has?.("timestamp-query") ?? null,
    },
    limits: {
      maxBufferSizeMb: toMb(limits.maxBufferSize),
      maxStorageBufferBindingSizeMb: toMb(limits.maxStorageBufferBindingSize),
      maxBufferSizeBytes: limits.maxBufferSize ?? null,
      maxComputeInvocationsPerWorkgroup:
        limits.maxComputeInvocationsPerWorkgroup ?? null,
    },
  };
};

const probeStorage = async () => {
  if (!navigator.storage?.estimate) {
    return { available: false, reason: "navigator.storage.estimate missing" };
  }
  try {
    const { quota, usage } = await navigator.storage.estimate();
    return { available: true, quotaMb: toMb(quota), usageMb: toMb(usage) };
  } catch (err) {
    return { available: false, reason: err.message };
  }
};

export const probeDevice = async () => {
  const [webgpu, storage] = await Promise.all([probeWebGpu(), probeStorage()]);

  return {
    capturedAt: new Date().toISOString(),
    userAgent: navigator.userAgent ?? null,
    looksLikeIos: looksLikeIos(),
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    // navigator.deviceMemory is non-standard; absent on Safari. Report honestly.
    deviceMemoryGb: navigator.deviceMemory ?? null,
    webgpu,
    storage,
    wasm: {
      simd: hasSimd(),
      sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
      crossOriginIsolated:
        typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : null,
    },
  };
};
