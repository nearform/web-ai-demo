/* global console:false, URLSearchParams:false, window:false */

const params = new URLSearchParams(window.location.search);
const DEBUG = params.has("debug");
const TIMINGS = params.has("timings");

export const debug = (tag, ...args) => {
  if (!DEBUG) return;
  console.log(`[${tag}]`, ...args);
};

debug.info = debug;

debug.warn = (tag, ...args) => {
  if (DEBUG) console.warn(`[${tag}]`, ...args);
};

debug.error = (tag, ...args) => {
  if (DEBUG) console.error(`[${tag}]`, ...args);
};

debug.timing = (label, durationMs) => {
  if (!TIMINGS) return;
  console.log(`[timing:${label}] ${(durationMs / 1000).toFixed(2)}s`);
};
