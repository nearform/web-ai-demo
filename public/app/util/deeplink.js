/* global window:false, history:false, URLSearchParams:false */

// Deep links: `?runtime=<provider id>` and `?model=<model id>`.
//
// Why the URL and not a stored preference: the audience for this page is someone
// who has been told "open this on your phone and try wllama". That instruction
// has to survive being pasted into a chat window, and a localStorage preference
// does not travel. The same link is also how a bug report says which runtime it
// was about.
//
// Two rules the rest of the app leans on:
//
//   1. **A link selects; it does not load.** Landing on `?runtime=wllama` picks
//      wllama in the chooser and downloads nothing, exactly as clicking its card
//      does. The registry indirection in providers/index.js exists precisely so
//      that choosing a runtime is free, and a link that kicked off a 400 MB
//      download on page open would throw that away.
//
//   2. **A bad param is ignored, never fatal.** Model ids here carry pipes and
//      whole URLs, so they are the kind of string that arrives mangled. An
//      unknown runtime falls back to the default and an unknown model to the
//      runtime's first entry — but always with a log line, because silently
//      loading something other than what the link asked for is the one outcome
//      that would waste a reader's download.

import {
  DESCRIPTORS,
  byId,
  DEFAULT_PROVIDER_ID,
} from "../providers/descriptors.js";
import { parseGgufSpec } from "./hf-gguf.js";

export const RUNTIME_PARAM = "runtime";
export const MODEL_PARAM = "model";

const currentParams = () => new URLSearchParams(window.location.search);

/**
 * Read the runtime and model out of the query string, validated against the
 * descriptors.
 *
 * Returns `{ providerId, model, pendingModel, warnings }`:
 *   - `providerId` is always a real id.
 *   - `model` is a validated id, or null to mean "use this runtime's default".
 *     For a runtime with a `customModel` (wllama), an id outside its list is
 *     accepted if it parses as a specifier — the list is not a closed set there.
 *   - `pendingModel` is a model id that could NOT be validated yet because the
 *     runtime's catalog lives inside its library bundle (web-llm). Holding it
 *     rather than resolving it is what keeps rule 1 above true: validating it
 *     now would mean downloading the bundle on page load.
 *   - `warnings` are messages for the event log. This runs during state
 *     initialisation, before the hook has a logger, so they are returned rather
 *     than logged.
 */
export const readDeepLink = () => {
  const params = currentParams();
  const warnings = [];

  const requestedProvider = params.get(RUNTIME_PARAM);
  let providerId = DEFAULT_PROVIDER_ID;
  if (requestedProvider) {
    if (byId(requestedProvider)) {
      providerId = requestedProvider;
    } else {
      warnings.push(
        `Ignoring ?${RUNTIME_PARAM}=${requestedProvider}: no such runtime. Known ids: ${DESCRIPTORS.map((d) => d.id).join(", ")}.`,
      );
    }
  }

  const descriptor = byId(providerId);
  const requestedModel = params.get(MODEL_PARAM) || null;
  let model = null;
  let pendingModel = null;

  if (requestedModel) {
    if (descriptor.modelChoice?.kind === "builtin") {
      // Chrome supplies the model and does not report which variant, so there is
      // nothing a model id could select.
      warnings.push(
        `Ignoring ?${MODEL_PARAM}=${requestedModel}: ${descriptor.name} chooses its own model.`,
      );
    } else if (descriptor.models) {
      if (descriptor.models.some((m) => m.id === requestedModel)) {
        model = requestedModel;
      } else if (descriptor.customModel) {
        // A runtime that takes an arbitrary repo has no closed set to validate
        // against, so "not in the list" is not an error here — it is the feature.
        // Only the shape of the specifier can be checked, and a link is the most
        // likely place for a mangled one to arrive: the ids carry pipes and
        // colons, which is exactly what a chat client mauls.
        const spec = parseGgufSpec(requestedModel);
        if (spec.ok) {
          model = spec.id;
        } else {
          warnings.push(
            `Ignoring ?${MODEL_PARAM}=${requestedModel}: ${spec.error} Falling back to the first entry.`,
          );
        }
      } else {
        warnings.push(
          `Ignoring ?${MODEL_PARAM}=${requestedModel}: not one of ${descriptor.name}'s models. Falling back to the first entry.`,
        );
      }
    } else {
      pendingModel = requestedModel;
    }
  }

  return { providerId, model, pendingModel, warnings };
};

/**
 * Point the address bar at the current selection, preserving every other param
 * (`?debug` and `?timings` in particular).
 *
 * replaceState rather than pushState: switching runtime is operating a control,
 * not navigating. With pushState, Back would walk a reader back through the four
 * runtimes they had already tried instead of leaving the page — and each of those
 * steps would be a no-op, since nothing here listens for popstate.
 */
export const writeDeepLink = ({ providerId, model }) => {
  const params = currentParams();
  params.set(RUNTIME_PARAM, providerId);
  if (model) {
    params.set(MODEL_PARAM, model);
  } else {
    params.delete(MODEL_PARAM);
  }

  const query = params.toString();
  const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== here) history.replaceState(null, "", next);
};
