// One entry point for "a reader typed a JavaScript function", turned into the
// two things every tool-calling API wants: a JSON-Schema declaration to send,
// and something callable to run when the model asks for it.
//
// This is the same shape as util/custom-model.js — a pure string parser that
// imports no runtime library, so the control that renders its errors can live
// beside the picker without pulling a bundle down. The difference is that this
// one also has to produce a function, and the only way to get a function out of
// a string is to evaluate it.
//
// ON EVALUATING IT. `new Function` on text the reader typed into this page is
// the reader running their own code in their own tab, which is what a devtools
// console is. There is no server, nothing is transmitted, and the source never
// leaves the origin. It is worth naming rather than hiding, because a demo that
// quietly `eval`s something is a different thing from one that says it does —
// the page says so under the field.
//
// THE TYPES ARE THE HARD PART, and the reason this file is longer than the
// parse. A tool declaration needs a JSON Schema, and JavaScript parameter lists
// carry no types. So there are exactly two rules, both stated in the UI:
//
//   1. A TypeScript-style annotation wins — `(a: string, b: boolean)`.
//   2. Otherwise the parameter is a `number`.
//
// `number` rather than `string` as the fallback because the default tool is
// arithmetic and a string default would make `add(a, b)` return "12345678" — a
// wrong answer that looks like a right one. Guessing from the body was the
// other option and it is worse: a rule a reader cannot predict produces a
// schema they cannot check, and the derived declaration is rendered back to
// them precisely so they can.

/** JSON Schema types an annotation may name, mapped from what you would write. */
const TYPES = {
  number: "number",
  integer: "integer",
  int: "integer",
  string: "string",
  str: "string",
  boolean: "boolean",
  bool: "boolean",
};

const DEFAULT_PARAM_TYPE = "number";

/** More than this and the reader has stopped writing a demo tool. */
const MAX_PARAMS = 8;

// Three declaration forms, in the order a reader is likely to write them. All
// three capture (name, params); the third is the parenthesis-free single-arg
// arrow, whose "params" is one bare identifier.
// The `d` flag is load-bearing, not habit: `match.indices` is how the exact
// span of the parameter list is found, and that span is what gets rewritten to
// strip the type annotations before the source is evaluated.
const FORMS = [
  // const add = (a, b) => …   /   const add = function (a, b) { … }
  /(?:^|[\n;])\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*[\w$]*\s*)?\(([^)]*)\)\s*(?:=>|\{)/d,
  // function add(a, b) { … }
  /(?:^|[\n;])\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/d,
  // const double = x => …
  /(?:^|[\n;])\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/d,
];

// Leading `//` lines become the tool's description, which is the one field a
// small model actually leans on when deciding whether to call. Opt-in: the
// default source has no comment and gets the generated fallback below.
const leadingComment = (source) => {
  const lines = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("//")) break;
    lines.push(trimmed.slice(2).trim());
  }
  return lines.join(" ").trim() || null;
};

/**
 * Split a parameter list on top-level commas. Defaults can contain commas of
 * their own — `(a = f(1, 2), b)` — so depth is tracked rather than `.split(",")`.
 */
const splitParams = (list) => {
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((p) => p.trim()).filter((p) => p.length > 0);
};

/**
 * One parameter: `name`, `name: type`, `name = default`, or both.
 *
 * Returns the schema half AND `code` — the parameter as it must appear in the
 * source that gets evaluated. Those differ, because the annotation this file
 * reads types from is not JavaScript: `(name: string) => …` is a syntax error
 * in a browser, so the annotation has to come back out before the function is
 * built. A default value does not, and is preserved verbatim.
 */
const parseParam = (raw) => {
  // The default value is split off first. It is a JavaScript expression, not
  // schema information, and an `=` inside it would confuse the annotation split
  // below. `indexOf` rather than `split`, so an arrow function used as a default
  // keeps its own `=`.
  const eq = raw.indexOf("=");
  const defaultValue = eq === -1 ? null : raw.slice(eq + 1);
  const withoutDefault = (eq === -1 ? raw : raw.slice(0, eq)).trim();
  if (!withoutDefault) return { ok: false, error: `Cannot read "${raw}".` };

  // Destructuring and rest give a parameter no single name to put in a schema,
  // and a model has no way to address them. Refused rather than guessed.
  if (/^[{[]/.test(withoutDefault)) {
    return {
      ok: false,
      error: `Destructured parameters are not supported — a tool's parameters have to be named one by one. Got "${withoutDefault}".`,
    };
  }
  if (withoutDefault.startsWith("...")) {
    return {
      ok: false,
      error: `Rest parameters are not supported — a JSON Schema needs a fixed parameter list. Got "${withoutDefault}".`,
    };
  }

  const [namePart, typePart] = withoutDefault.split(":");
  const name = namePart.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    return { ok: false, error: `"${name}" is not a valid parameter name.` };
  }

  const code = defaultValue === null ? name : `${name} =${defaultValue}`;

  if (typePart === undefined) {
    return { ok: true, name, code, type: DEFAULT_PARAM_TYPE, annotated: false };
  }

  const annotation = typePart.trim().toLowerCase();
  const type = TYPES[annotation];
  if (!type) {
    return {
      ok: false,
      error: `"${typePart.trim()}" is not a type this page can put in a JSON Schema. Use one of: ${Object.keys(
        TYPES,
      ).join(", ")}.`,
    };
  }
  return { ok: true, name, code, type, annotated: true };
};

/**
 * Parse `source` into a tool the runtimes can be handed.
 *
 * Returns `{ ok: true, name, description, parameters, params, declaration,
 * signature, call }` or `{ ok: false, error }`. `parameters` is the JSON Schema
 * object every one of the five APIs wants under some field name of its own;
 * `call(args)` takes the model's named arguments and applies them positionally,
 * which is the one translation the schema does not do for us.
 */
export const parseToolFunction = (source) => {
  const text = String(source ?? "");
  if (!text.trim()) return { ok: false, error: "Nothing to parse." };

  let name = null;
  let paramList = null;
  // Where the parameter list sits in the source, so the annotations can be cut
  // back out of the exact span they occupy rather than by a second regex pass
  // over text that may contain the same characters in the body.
  let paramSpan = null;
  for (const form of FORMS) {
    const match = text.match(form);
    if (match) {
      name = match[1];
      paramList = match[2];
      paramSpan = match.indices[2];
      break;
    }
  }
  if (!name) {
    return {
      ok: false,
      error:
        "No named function found. Write `const add = (a, b) => a + b;` or `function add(a, b) { … }` — the name is what the model calls.",
    };
  }

  const parsed = splitParams(paramList).map(parseParam);
  const bad = parsed.find((p) => !p.ok);
  if (bad) return { ok: false, error: bad.error };
  if (parsed.length > MAX_PARAMS) {
    return {
      ok: false,
      error: `${parsed.length} parameters is more than this page will declare (max ${MAX_PARAMS}).`,
    };
  }

  // Evaluated AFTER the signature is read, because the wrapper has to name the
  // binding it is returning and there is no way to ask a function expression
  // what it was assigned to. A syntax error surfaces here, which is the right
  // place: the field can render it.
  // The annotated parameter list is replaced by a plain one before the source
  // is evaluated — see parseParam. Without this, the documented way to type a
  // parameter is also the way to make the field refuse to parse.
  const evaluable =
    text.slice(0, paramSpan[0]) +
    parsed.map((p) => p.code).join(", ") +
    text.slice(paramSpan[1]);

  let fn;
  try {
    fn = new Function(
      `"use strict";\n${evaluable}\n;return typeof ${name} === "function" ? ${name} : null;`,
    )();
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}` };
  }
  if (typeof fn !== "function") {
    return {
      ok: false,
      error: `The source ran, but \`${name}\` is not a function afterwards.`,
    };
  }

  const properties = {};
  for (const p of parsed) {
    properties[p.name] = {
      type: p.type,
      description: `Parameter \`${p.name}\` of ${name}().`,
    };
  }
  const parameters = {
    type: "object",
    properties,
    required: parsed.map((p) => p.name),
  };

  const signature = `${name}(${parsed
    .map((p) => `${p.name}: ${p.type}`)
    .join(", ")})`;

  return {
    ok: true,
    name,
    description:
      leadingComment(text) ??
      `Calls the JavaScript function ${signature}. Use it whenever the answer needs that computation.`,
    parameters,
    params: parsed.map(({ name: n, type, annotated }) => ({
      name: n,
      type,
      annotated,
    })),
    signature,
    /**
     * Run the function with the arguments the model produced. Named to
     * positional: every one of these APIs reports arguments as an object keyed
     * by parameter name, and a JavaScript function takes them in order.
     */
    call: async (args) => fn(...parsed.map((p) => args?.[p.name])),
  };
};

/**
 * The declaration alone, as three of the five APIs want it — a bare
 * `{ name, description, parameters }`. web-llm and wllama wrap it in
 * `{ type: "function", function: … }`; that wrapping is each adapter's
 * business, because the wrapper is where the two disagree.
 *
 * Separate from the parse so that the thing sent over the wire is provably the
 * thing shown on screen: the panel renders this, and so does every adapter.
 */
export const toolDeclaration = (tool) =>
  tool?.ok
    ? {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }
    : null;
