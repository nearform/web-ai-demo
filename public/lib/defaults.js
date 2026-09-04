// The default system prompt and the default question, in one place.
//
// This lives in lib/ rather than in the app's descriptors or the spike harness
// because both tiers put the same two strings in a textarea, and the demo and the
// spikes are meant to be comparable: if a spike asks a different question than the
// app, a difference in the answers is no longer attributable to the runtime. Two
// copies drift — this file is the same category as probe.js and quality.js, shared
// apparatus rather than either side's implementation.
//
// Strings only. Nothing here imports a runtime library, so importing this costs a
// page nothing.

/** Applied wherever the runtime accepts a system prompt. */
export const DEFAULT_SYSTEM = "You are a concise, accurate assistant.";

/**
 * The question every page starts with. Deliberately old, widely documented and
 * short: a 0.5B model has read the answer many times, and "in one sentence" keeps
 * the reply brief enough that a single-threaded WASM runtime still finishes it.
 */
export const DEFAULT_PROMPT = "In one sentence, how do I exit vim?";
