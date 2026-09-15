/* global caches:false, navigator:false */

// "Will picking this one cost me a gigabyte?" — answered before you press Load.
//
// The status panel says loaded or not loaded, which is about the runtime. This
// is the other question, and for a page whose whole subject is the cost of
// running a model in a browser it is arguably the more useful one: the weights
// outlive every unload, so a model you have already fetched is free to pick
// again and one you have not is a download.
//
// THE CONSTRAINT THAT SHAPES THIS FILE: it must not import a runtime library.
// The picker renders before anything is loaded — that is the point of the
// registry in providers/index.js — so a probe that called web-llm's
// `hasModelInCache()` or wllama's `modelManager.getModels()` would drag a CDN
// bundle down just to grey out a label. Every check here therefore reads the
// browser's own storage directly, using each runtime's naming scheme rather
// than its API.
//
// That is a real trade and it is worth naming: these are OTHER libraries'
// private storage layouts, and a library is free to change one in a patch
// release. The failure mode is deliberately soft — an unrecognised layout
// reports "unknown", never "absent", because a wrong "not cached" would send a
// reader off to re-download something they already have.
//
// Layouts, read off a populated profile 2026-09-14:
//
//   web-llm          Cache Storage "webllm/model"
//                    https://huggingface.co/mlc-ai/<model_id>/resolve/main/…
//   Transformers.js  Cache Storage "transformers-cache"   (env.cacheKey)
//                    https://huggingface.co/<owner>/<repo>/resolve/main/…
//   LiteRT-LM        Cache Storage "litertlm-models"      (ours; see litert.js)
//                    the model URL, verbatim
//   wllama           OPFS, directory "cache"
//                    <sha1>_<filename.gguf>, plus __metadata__<sha1>_<filename>
//                    (`getNameFromURL` documents the format as
//                    `${hashSHA1(fullURL)}_${fileName}`)
//   Chrome           nothing to probe — LanguageModel.availability() is the
//                    answer, and it is a live call rather than a stored file.

// The `parse*Spec` forms rather than the `*LoadParams` ones: these report a bad
// id as `{ ok: false }` instead of throwing, and they expose the raw repo and
// filename rather than the shape each library's loader happens to want.
import { parseGgufSpec } from "./hf-gguf.js";
import { parseOnnxSpec } from "./hf-onnx.js";
import { litertlmLoadParams } from "./litertlm.js";

/** Cached-state values. `unknown` is the honest answer wherever we cannot tell. */
export const CACHED = "cached";
export const ABSENT = "absent";
export const UNKNOWN = "unknown";

/** Every URL in a named Cache Storage bucket, or null if it cannot be read. */
const cacheUrls = async (name) => {
  try {
    if (typeof caches === "undefined") return null;
    if (!(await caches.has(name))) return [];
    const requests = await (await caches.open(name)).keys();
    return requests.map((r) => r.url);
  } catch {
    // Private browsing and some embedded webviews reject caches.open().
    return null;
  }
};

/** Every entry name in an OPFS subdirectory, or null if it cannot be read. */
const opfsNames = async (dir) => {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return null;
    let handle;
    try {
      handle = await root.getDirectoryHandle(dir);
    } catch {
      // No directory yet simply means nothing has been downloaded.
      return [];
    }
    const names = [];
    for await (const [name] of handle.entries()) names.push(name);
    return names;
  } catch {
    return null;
  }
};

// A probe returns a function from model id to state, so the storage is read
// ONCE per refresh rather than once per model — a wllama list of six entries
// against an OPFS directory is six directory walks otherwise.
const PROBES = {
  "web-llm": async () => {
    const urls = await cacheUrls("webllm/model");
    if (!urls) return () => UNKNOWN;
    return (id, entry) => {
      // The record's own `model` field where discovery gave us one, since an
      // appConfig may point somewhere other than mlc-ai. The id is the fallback
      // and matches the published catalog's layout.
      const prefix = entry?.cacheUrl;
      const hit = prefix
        ? urls.some((u) => u.startsWith(prefix))
        : urls.some((u) => u.includes(`/${id}/`));
      return hit ? CACHED : ABSENT;
    };
  },

  "transformers-js": async () => {
    const urls = await cacheUrls("transformers-cache");
    if (!urls) return () => UNKNOWN;
    return (id) => {
      const spec = parseOnnxSpec(id);
      if (!spec.ok) return UNKNOWN;
      return urls.some((u) => u.includes(`/${spec.repo}/`)) ? CACHED : ABSENT;
    };
  },

  litert: async () => {
    // Same bucket name providers/litert.js writes, which is also the one
    // Google's own demo uses.
    const urls = await cacheUrls("litertlm-models");
    if (!urls) return () => UNKNOWN;
    return (id) => {
      let url;
      try {
        ({ url } = litertlmLoadParams(id));
      } catch {
        return UNKNOWN;
      }
      return urls.includes(url) ? CACHED : ABSENT;
    };
  },

  wllama: async () => {
    const names = await opfsNames("cache");
    if (!names) return () => UNKNOWN;
    // THE SIDECAR IS THE COMPLETION MARKER, and this is the one runtime here
    // where a finished download can be told from an abandoned one. From
    // cache-manager.ts: `write()` awaits `sb.write(name, stream)` and only then
    // `writeMetadata(name, metadata)`. So a blob with no `__metadata__` partner
    // is a download that stopped partway.
    //
    // Not hypothetical: a profile here held a 15.8 MB
    // `…_Qwen3.5-4B-Q4_K_M.gguf` — against a listed 2613 MB — with no sidecar.
    // Matching on the blob alone reported it cached, which is the worst answer
    // of the three, since picking it starts the download over anyway.
    const complete = new Set(
      names
        .filter((n) => n.startsWith("__metadata__"))
        .map((n) => n.slice("__metadata__".length)),
    );
    return (id) => {
      const spec = parseGgufSpec(id);
      if (!spec.ok) return UNKNOWN;
      // `repo:QUANT` resolves its filename inside wllama, at download time, so
      // there is nothing to match here. Unknown rather than absent — see the
      // header.
      if (!spec.file) return UNKNOWN;
      return [...complete].some((n) => n.endsWith(`_${spec.file}`))
        ? CACHED
        : ABSENT;
    };
  },
};

/**
 * Read cached state for every model in `models`, in one pass over storage.
 *
 * Returns a plain object keyed by model id. Never throws and never rejects: a
 * storage API that is unavailable, partitioned or simply unreadable yields
 * `unknown` for everything, which the picker renders as no marker at all.
 *
 * What "cached" is worth varies by runtime, and the picker's note says so:
 * wllama's answer is exact, because it writes a completion marker. The Cache
 * Storage ones are per-file exact — `cache.put()` only stores a body it read to
 * the end — but a model is many files and this asks whether any of them are
 * there, so a set that stopped halfway still reads as cached.
 */
export const probeModelCache = async (providerId, models) => {
  const probe = PROBES[providerId];
  const out = {};
  if (!probe || !models?.length) return out;
  try {
    const lookup = await probe(models);
    for (const m of models) out[m.id] = lookup(m.id, m);
  } catch {
    for (const m of models) out[m.id] = UNKNOWN;
  }
  return out;
};

/** How many of `models` are cached, for the summary line under the picker. */
export const cachedCount = (states, models) =>
  (models ?? []).filter((m) => states?.[m.id] === CACHED).length;
