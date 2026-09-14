// LiteRT-LM model specifiers, parsed without loading the runtime to do it.
//
// Same reasoning as util/hf-gguf.js: the picker validates what a reader typed
// BEFORE a gigabyte starts moving, and importing the adapter to borrow its
// parser would pull @litert-lm/core just to check a string.
//
// A LiteRT-LM id is `BACKEND|url`, and the backend half is not a detail. It
// decides which of two load paths runs — `ModelAssets.createStreaming()` for
// GPU_ARTISAN, `loadModelToVfs()` plus `ModelAssets.create()` for the rest —
// and therefore whether the `-web` packaging requirement applies at all. The
// curated entry in providers/descriptors.js is already in this shape, so
// nothing special-cases a typed id against a chosen one.
//
// WHAT GOOGLE ACTUALLY DOCUMENTS, from developers.google.com/edge/litert-lm/js
// (read 2026-09-14), because it is narrower than "any `.litertlm` file":
//
//   "The LiteRT-LM JS API currently supports a limited set of web-compatible
//    models. We're working on expanding this to cover general .litertlm model
//    files, but for now, the following models are supported:
//      gemma-4-E2B-it-web.litertlm from litert-community/gemma-4-E2B-it-litert-lm
//      gemma-4-E4B-it-web.litertlm from litert-community/gemma-4-E4B-it-litert-lm"
//
// So the `-web` suffix is necessary and not sufficient, and this file says both
// — a non-`-web` file gets one warning and an unrecognised `-web` file gets a
// milder one. Neither is a refusal: finding out which community packagings the
// runtime has grown to accept is exactly what an arbitrary-model field is for,
// and "we're working on expanding this" is an invitation to re-check.

/** `owner/name`. The Hub allows letters, digits, `-`, `_` and `.` in both. */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const HOST_RE = /^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\//i;

// The Backend keys of @litert-lm/core 0.15.0, verified against
// `dist/wasm_binding_types.d.ts`, which declares exactly:
//   UNSPECIFIED, CPU_ARTISAN, GPU_ARTISAN, CPU, GPU, GOOGLE_TENSOR_ARTISAN, NPU
//
// Only three of those mean anything in a browser, and this file accepts only
// those three. That is validation rather than policy: `Backend[name]` resolves
// for all seven, so passing NPU or GOOGLE_TENSOR_ARTISAN through would not
// throw here — it would fail somewhere inside the WASM module, a gigabyte
// later, with an error that says nothing about the id that caused it.
//
// GPU is accepted and warned about rather than hidden. The adapter declines to
// LIST it because a reader should not stumble into a backend reported to take
// the tab down; typing it into this field is the deliberate act that reservation
// was protecting, so the field honours it.
const BACKENDS = {
  GPU_ARTISAN: {
    note: "streams the file into the runtime (`ModelAssets.createStreaming`), which is the path the `-web` packaging exists for",
    warning: null,
  },
  CPU: {
    note: "stages the file through the WASM filesystem (`loadModelToVfs`), which needs no WebGPU adapter and no `-web` packaging",
    warning:
      "The CPU backend needs no GPU adapter and accepts packagings the streaming path rejects, at a large cost in speed.",
  },
  GPU: {
    note: "the non-Artisan GPU path",
    warning:
      "Backend.GPU is not offered in the list above because it is reported to take the tab down, and that report is untested here. Nothing on this page has run it. Expect to lose the tab.",
  },
};

const DEFAULT_BACKEND = "GPU_ARTISAN";

// The two files Google's own documentation names. A `-web` file that is not one
// of these is the interesting case — it is what the docs say they are working
// toward — so it is called out as untested rather than treated as fine.
const DOCUMENTED_FILES = [
  "gemma-4-E2B-it-web.litertlm",
  "gemma-4-E4B-it-web.litertlm",
];

const fileNameOf = (url) => {
  const path = url.split("?")[0];
  return path.slice(path.lastIndexOf("/") + 1);
};

const fail = (error) => ({ ok: false, error });

const warningsFor = ({ backendName, url }) => {
  const out = [];
  const file = fileNameOf(url);
  const isWeb = /-web\.litertlm$/i.test(file);

  if (backendName === "GPU_ARTISAN" && !isWeb) {
    out.push(
      "This file is not a `-web.litertlm`. Google documents the JS API as supporting web-compatible models only, and the streaming path this backend uses is what that packaging is for — expect the load to fail rather than to run slowly.",
    );
  } else if (isWeb && !DOCUMENTED_FILES.includes(file)) {
    out.push(
      `Google documents two supported files — ${DOCUMENTED_FILES.join(" and ")} — and says support for general \`.litertlm\` files is still being expanded. A \`-web\` name is the right shape but not a guarantee, so this may download in full and then refuse to load.`,
    );
  }

  const backendWarning = BACKENDS[backendName]?.warning;
  if (backendWarning) out.push(backendWarning);
  return out.length ? out.join(" ") : null;
};

/** `BACKEND|url`, always — the shape the adapter and the curated list share. */
const idFor = ({ backendName, url }) => `${backendName}|${url}`;

const labelFor = ({ backendName, url }) =>
  `${fileNameOf(url).replace(/\.litertlm$/i, "")} — ${backendName}`;

const noteFor = ({ backendName, url }) => {
  const where = HOST_RE.test(url)
    ? "From the Hub"
    : "From a non-Hub origin, which has to send CORS headers of its own for the fetch to succeed";
  return `${where}: \`${fileNameOf(url)}\`, on Backend.${backendName} — ${BACKENDS[backendName].note}. The size is not known until the download starts, so this entry does not carry one; every published file is over a gigabyte.`;
};

/**
 * Parse a LiteRT-LM model specifier.
 *
 * Accepts, in order of how likely it is to be what someone pasted:
 *
 *   - `owner/repo/model-web.litertlm`          — a Hub path
 *   - `https://huggingface.co/owner/repo/resolve/main/model-web.litertlm`
 *   - `CPU|owner/repo/model-web.litertlm`      — either of the above, with a
 *     `GPU_ARTISAN|https://…/model-web.litertlm`  backend chosen explicitly
 *   - any absolute `http(s)` URL ending `.litertlm`, self-hosted included
 *
 * With no backend named, GPU_ARTISAN — the one Google's sample uses, and the
 * one the `-web` packaging exists for.
 *
 * A Hub `/blob/` URL is rewritten to `/resolve/`. That rewrite is load-bearing
 * rather than tidy: unlike wllama, which is handed a repo and builds its own
 * URL, this adapter fetches the URL it is given, and `/blob/` serves the Hub's
 * HTML file-viewer page. Without it a reader pastes the address bar and the
 * runtime is handed a web page to parse as model weights.
 *
 * Returns `{ ok: true, id, backendName, url, fileName, label, note, warning,
 * detail }` or `{ ok: false, error }`.
 */
export const parseLitertlmSpec = (raw) => {
  const input = String(raw ?? "").trim();
  if (!input) return fail("Enter a `.litertlm` file.");
  if (/\s/.test(input)) return fail("A specifier contains no spaces.");

  let rest = input;
  let backendName = DEFAULT_BACKEND;

  // The backend prefix, split on the FIRST `|` and only when the left side
  // looks like one. Testing before committing is what lets the rest of this
  // function stay unaware of the prefix, and what keeps a stray `|` in a URL
  // from being read as a backend.
  const bar = rest.indexOf("|");
  if (bar > 0) {
    const head = rest.slice(0, bar).trim();
    if (/^[A-Z_]+$/.test(head)) {
      if (!BACKENDS[head]) {
        return fail(
          `\`${head}\` is not a usable backend. One of: ${Object.keys(BACKENDS).join(", ")}.`,
        );
      }
      backendName = head;
      rest = rest.slice(bar + 1).trim();
    }
  }

  if (!rest) return fail("A backend on its own names no file.");

  // Checked before the shapes below rather than after them. A `ftp://` or
  // `file://` URL would otherwise fall through to the Hub-path branch and be
  // reported as a malformed `owner/repo`, which sends a reader looking in
  // entirely the wrong place.
  const scheme = rest.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//);
  if (scheme && !/^https?$/i.test(scheme[1])) {
    return fail(
      `\`${scheme[1]}:\` is not a usable scheme. Use \`http\` or \`https\`.`,
    );
  }

  let url;
  if (/^https?:\/\//i.test(rest) || HOST_RE.test(rest)) {
    // A Hub URL, with or without its scheme. Normalised through the same path
    // as the bare form below so that `/blob/` is rewritten either way.
    if (HOST_RE.test(rest)) {
      const path = rest.replace(HOST_RE, "").replace(/[?#].*$/, "");
      const onHub = path.match(/^(.+?)\/(?:blob|resolve)\/([^/]+)\/(.+)$/);
      if (onHub) {
        const [, repo, revision, file] = onHub;
        if (!REPO_RE.test(repo))
          return fail(`\`${repo}\` is not an \`owner/repo\` name.`);
        url = `https://huggingface.co/${repo}/resolve/${revision}/${file}`;
      } else {
        // `huggingface.co/owner/repo/file.litertlm` — no `/blob/` or
        // `/resolve/` segment, so the same Hub-path shape as the bare form.
        const cut = path.indexOf("/", path.indexOf("/") + 1);
        if (cut === -1) return fail(`\`${path}\` names no file inside a repo.`);
        const repo = path.slice(0, cut);
        if (!REPO_RE.test(repo))
          return fail(`\`${repo}\` is not an \`owner/repo\` name.`);
        url = `https://huggingface.co/${repo}/resolve/main/${path.slice(cut + 1)}`;
      }
    } else {
      // Somewhere else entirely. Kept rather than rejected: a self-hosted file
      // is a legitimate thing to point this at, and the fetch will say plainly
      // enough if the origin sends no CORS headers.
      url = rest.replace(/[?#].*$/, "");
    }
  } else if (rest.includes("/")) {
    // `owner/repo/path/to/model-web.litertlm` — the repo is the first two
    // segments, everything after is the path inside it.
    const path = rest.replace(/[?#].*$/, "");
    const cut = path.indexOf("/", path.indexOf("/") + 1);
    if (cut === -1) {
      return fail(
        `\`${path}\` is a repo but names no file. LiteRT-LM is handed a URL, not a repo, so the \`.litertlm\` filename is required.`,
      );
    }
    const repo = path.slice(0, cut);
    if (!REPO_RE.test(repo))
      return fail(`\`${repo}\` is not an \`owner/repo\` name.`);
    url = `https://huggingface.co/${repo}/resolve/main/${path.slice(cut + 1)}`;
  } else {
    return fail(
      `\`${rest}\` is neither a URL nor an \`owner/repo/file\` path.`,
    );
  }

  if (!/^https?:\/\//i.test(url)) {
    return fail("A model URL must be `http` or `https`.");
  }
  if (!/\.litertlm$/i.test(url)) {
    return fail(
      `\`${fileNameOf(url)}\` is not a \`.litertlm\` file. The \`.task\` files from the older MediaPipe API are a different format.`,
    );
  }

  const spec = { backendName, url };
  return {
    ok: true,
    ...spec,
    fileName: fileNameOf(url),
    id: idFor(spec),
    label: labelFor(spec),
    note: noteFor(spec),
    warning: warningsFor(spec),
    detail: { backendName, url, fileName: fileNameOf(url) },
  };
};

/**
 * The `{ backendName, url }` the adapter loads from. Kept as a function of its
 * own so that providers/litert.js has one definition of what an id means rather
 * than a second `split("|")` that could drift from this one.
 */
export const litertlmLoadParams = (id) => {
  const spec = parseLitertlmSpec(id);
  if (!spec.ok) throw new Error(`Unusable model id "${id}": ${spec.error}`);
  return { backendName: spec.backendName, url: spec.url };
};
