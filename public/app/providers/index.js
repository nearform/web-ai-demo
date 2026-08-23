/* global performance:false */

// Provider registry.
//
// The whole point of this indirection is that picking a runtime in the chooser
// must not download it. Five libraries at CDN sizes is tens of megabytes, and a
// page that fetches all five to render five cards has already failed the thing
// this demo is about.
//
// So: `descriptors.js` imports nothing and carries everything the UI needs to
// render and compare all five. The adapter module — which does `import` its
// library at the top level, and therefore pulls the bundle the moment it is
// evaluated — is behind a dynamic import that fires only when the runtime is
// actually being used.
//
// One consequence worth naming, because it is visible in the UI: web-llm's model
// list lives INSIDE the web-llm bundle (`prebuiltAppConfig`), so populating its
// picker requires the download. That is why the model picker for web-llm has a
// "read the catalog" step of its own while the other three are instant, and why
// the cost is logged rather than hidden.

import { DESCRIPTORS, byId } from "./descriptors.js";

// Static map rather than a computed specifier: a bundler-free page still benefits
// from the import being statically analysable, and a typo becomes a load error
// at the one place that can report it rather than a 404 in the network tab.
const LOADERS = {
  "chrome-prompt-api": () => import("./chrome-prompt-api.js"),
  "web-llm": () => import("./web-llm.js"),
  wllama: () => import("./wllama.js"),
  "transformers-js": () => import("./transformers-js.js"),
  litert: () => import("./litert.js"),
};

// Evaluated adapters, by id. An adapter is stateful — several hold a module-level
// instance or a "what was baked in at load" value — so it must be the same object
// across a load/generate/unload cycle, not a fresh import each time.
const loaded = new Map();

export const listProviders = () => DESCRIPTORS;
export const getDescriptor = byId;

/**
 * Fetch and evaluate a runtime's adapter, downloading its library as a side
 * effect. Idempotent: the second call returns the same adapter object.
 */
export const loadAdapter = async (id, { log } = {}) => {
  if (loaded.has(id)) return loaded.get(id);
  const loader = LOADERS[id];
  if (!loader) throw new Error(`No adapter registered for provider "${id}"`);
  log?.info?.(`Fetching the ${id} adapter and its library bundle…`);
  const started = performance.now();
  const mod = await loader();
  const adapter = mod.default;
  if (!adapter) throw new Error(`Adapter "${id}" has no default export`);
  loaded.set(id, adapter);
  log?.info?.(`${id} library evaluated`, {
    ms: Math.round(performance.now() - started),
    // Which of the four optional hooks this runtime actually implements. Reported
    // because the absences are meaningful: no discoverModels means a static list,
    // no unload would mean nothing can be freed.
    implements: [
      "check",
      "discoverModels",
      "load",
      "generate",
      "unload",
    ].filter((k) => typeof adapter[k] === "function"),
  });
  return adapter;
};

/** Whether a runtime's library has already been downloaded this session. */
export const isAdapterResident = (id) => loaded.has(id);
