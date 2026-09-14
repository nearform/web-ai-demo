/* global navigator:false */

import { useEffect, useRef, useState } from "react";
import { html } from "../util/html.js";
import { formatWire } from "../util/wire.js";
import { DEFAULT_TOOL_PROMPT } from "../providers/descriptors.js";

// Whether the reply parses as JSON. Three of the five constrain the grammar; on
// the other two the schema is only a request in the prompt. Showing the parse
// result makes that difference observable rather than asserted.
const tryParse = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
};

// What the toggle promises. Three states rather than two, because "the
// declarations were sent and nothing can read a call back out" is neither of the
// other two — see the Tool calling row in the comparison table.
const TOOL_BADGE = {
  parsed: { text: "runs your function", tone: "ok" },
  template: { text: "template only — nothing runs", tone: "bad" },
  none: { text: "sent and ignored", tone: "bad" },
};

// …but on web-llm the runtime's answer and this model's answer are different
// questions: `tools` is accepted for five Hermes ids and throws for every other
// entry in the catalog. The comparison table is about the runtime and says
// "yes"; a badge sitting beside a loaded 135M model has to be about the model.
const toolBadgeFor = (descriptor, model) => {
  const allowlist = descriptor.tools.modelAllowlist;
  if (allowlist && model && !allowlist.includes(model)) {
    return { text: "not on this model", tone: "bad" };
  }
  return TOOL_BADGE[descriptor.tools.kind];
};

const toolsReachTheModel = (descriptor, model) =>
  !descriptor.tools.modelAllowlist ||
  !model ||
  descriptor.tools.modelAllowlist.includes(model);

// The reader's function, and the declaration derived from it.
//
// Both are shown, and that is the point rather than a debugging aid: the JSON
// Schema is what actually goes to the model, the types in it were inferred from
// text that carries no types, and a reader who cannot see the result has no way
// to tell a tool that was never called from one that was declared wrong.
const ToolEditor = ({
  descriptor,
  source,
  setSource,
  tool,
  setPrompt,
  disabled,
}) => html`
  <div className="tool-editor">
    <textarea
      className="control-input control-input--area control-input--code"
      rows="3"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      value=${source}
      onChange=${(e) => setSource(e.target.value)}
      disabled=${disabled}
      aria-label="Tool function source"
    ></textarea>
    ${
      tool.ok
        ? html`
            <p className="control-note">
              Declared as <code>${tool.signature}</code>${" "}
              ${
                tool.params.some((p) => !p.annotated)
                  ? html`— a parameter with no annotation is declared
                      a${" "}<code>number</code>; write${" "}
                      <code>(name: string)</code> for anything else.`
                  : null
              }
            </p>
            <details className="tool-schema">
              <summary>The declaration that will be sent</summary>
              <pre className="wire-body">
${JSON.stringify(
  {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
  null,
  2,
)}</pre>
            </details>
          `
        : html`<p className="control-note control-note--bad">${tool.error}</p>`
    }
    <div className="btn-row">
      <button
        type="button"
        className="btn btn--small"
        onClick=${() => setPrompt(DEFAULT_TOOL_PROMPT)}
        disabled=${disabled}
      >
        Ask a question this tool answers
      </button>
    </div>
    <p className="control-note">
      A model reaches for a tool when it knows it cannot answer without one, so
      the tool and the question have to match — that button puts
      <em>“${DEFAULT_TOOL_PROMPT}”</em> in the prompt box. The default function
      is a stub that returns the same string for every city; what is worth
      watching is whether the call appears above the reply, not the forecast.
    </p>
    <p className="control-note">
      ${descriptor.tools.note} This page evaluates what you type, here in this
      tab. Nothing is sent anywhere.
    </p>
  </div>
`;

// The calls that happened, between the question and the answer. Rendered from
// the run record rather than the reply, because a model that described calling
// a tool and a model that called one look identical in prose.
const ToolCalls = ({ calls }) => {
  if (!calls?.length) return null;
  return html`
    <div className="tool-calls">
      ${calls.map(
        (c, i) => html`
          <div
            className=${`tool-call${c.error ? " tool-call--bad" : ""}`}
            key=${i}
          >
            <span className="tool-call-name"
              >${c.name}(${Object.entries(c.args ?? {})
                .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                .join(", ")})</span
            >
            <span className="tool-call-arrow" aria-hidden="true">→</span>
            <span className="tool-call-result">
              ${c.error ? c.error : JSON.stringify(c.result)}
            </span>
            <span className="tool-call-ms">${c.ms}ms</span>
          </div>
        `,
      )}
    </div>
  `;
};

// Per-turn numbers, as a strip under the reply. Figures the runtime reported and
// figures this page counted are labeled differently, because they are not the
// same claim.
const RunStats = ({ run }) => {
  if (!run) return null;
  const s = run.runtimeReportedStats ?? {};
  const cells = [
    ["total", `${(run.totalMs / 1000).toFixed(2)}s`],
    [
      "first chunk",
      run.timeToFirstChunkMs === null ? "—" : `${run.timeToFirstChunkMs}ms`,
    ],
    ["chars", run.replyChars],
    [
      "chunks/s",
      run.chunksPerSecondWithheld
        ? "n/a — does not stream"
        : (run.chunksPerSecond ?? "—"),
    ],
  ];
  // Only shown when the runtime reports them. A null here would read as zero.
  if (s.prefillTokensPerSecond != null) {
    cells.push([
      "prefill tok/s",
      s.prefillTokensPerSecond.toFixed?.(1) ?? s.prefillTokensPerSecond,
    ]);
  }
  if (s.decodeTokensPerSecond != null) {
    cells.push([
      "decode tok/s",
      s.decodeTokensPerSecond.toFixed?.(1) ?? s.decodeTokensPerSecond,
    ]);
  }
  if (s.tokensPerSecondCountedByUs != null) {
    cells.push(["tok/s (we counted)", s.tokensPerSecondCountedByUs]);
  }
  if (s.cachedPromptTokens != null) {
    cells.push(["cached prompt tok", s.cachedPromptTokens]);
  }
  if (s.contextUsageAfter != null) {
    cells.push([
      "context used",
      `${s.contextUsageAfter}${s.contextWindow ? ` / ${s.contextWindow}` : ""}`,
    ]);
  }
  if (s.conversationTokenCount != null) {
    cells.push(["conversation tok", s.conversationTokenCount]);
  }

  return html`
    <div className="run-stats">
      ${cells.map(
        ([k, v]) => html`
          <span className="run-stat" key=${k}>
            <span className="run-stat-key">${k}</span>
            <span className="run-stat-val">${v}</span>
          </span>
        `,
      )}
      ${
        run.aborted
          ? html`<span className="run-stat run-stat--flag">stopped</span>`
          : null
      }
      ${
        run.quality?.looksDegenerate
          ? html`<span className="run-stat run-stat--bad"
              >degenerate:
              ${
                run.quality.degenerateReason ??
                `distinct-3 ${run.quality.distinct3}`
              }</span
            >`
          : null
      }
    </div>
  `;
};

// What was sent and what came back, verbatim.
//
// The conversation panel shows a *processed* reply: web-llm's leading think block
// is stripped before display, and every runtime resends (or does not resend) a
// history the reader never sees. Both of those are the subject of the demo rather
// than an implementation detail, so there is one place to read the unedited pair.
//
// A native <dialog> rather than a hand-rolled overlay: showModal() brings the
// focus trap, the Escape key and the inert backdrop with it, none of which are
// worth reimplementing.
const WireModal = ({ wire, descriptor, turn, shownChars, onClose }) => {
  const ref = useRef(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    node.showModal();
    // Escape closes a <dialog> without going through the close button, so the
    // parent's "which turn is open" state has to follow the element, not the
    // other way round.
    const onCancel = () => onClose();
    node.addEventListener("close", onCancel);
    return () => node.removeEventListener("close", onCancel);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        formatWire({ provider: descriptor.id, turn, ...wire }),
      );
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const stripped = wire.rawReported ? wire.raw.length - shownChars : 0;

  return html`
    <dialog className="wire" ref=${ref}>
      <div className="wire-head">
        <div className="wire-title">
          Turn ${turn} — ${descriptor.name}, verbatim
        </div>
        <button
          type="button"
          className="btn btn--small"
          onClick=${onClose}
          aria-label="Close"
        >
          Close
        </button>
      </div>

      ${wire.note ? html`<p className="wire-note">${wire.note}</p>` : null}

      <div className="wire-section">
        <div className="wire-label">Sent to the runtime</div>
        ${
          wire.request === null
            ? html`<p className="wire-empty">
                This adapter reported no request.
              </p>`
            : html`<pre className="wire-body">${formatWire(wire.request)}</pre>`
        }
      </div>

      <div className="wire-section">
        <div className="wire-label">
          Received
          ${
            stripped > 0
              ? html`<span className="turn-flag"
                  >${stripped} chars stripped before display</span
                >`
              : null
          }
        </div>
        <pre className="wire-body">${wire.raw || "(nothing)"}</pre>
      </div>

      <div className="btn-row">
        <button type="button" className="btn" onClick=${copy}>
          ${copied ? "Copied" : "Copy both"}
        </button>
      </div>
    </dialog>
  `;
};

const Turn = ({ turn, descriptor, model, onShowWire }) => {
  if (turn.role === "user") {
    return html`
      <div className="turn turn--user">
        <div className="turn-role">
          you (turn ${turn.turn})
          ${
            turn.jsonMode
              ? html`<span className="turn-flag">JSON requested</span>`
              : null
          }
          ${
            turn.toolsActive
              ? html`<span className="turn-flag">tool declared</span>`
              : null
          }
        </div>
        <div className="turn-text">${turn.text}</div>
      </div>
    `;
  }

  const jsonRequested = turn.run?.jsonRequested;
  const parsed = jsonRequested ? tryParse(turn.text) : null;

  return html`
    <div className="turn turn--model">
      <div className="turn-role">${descriptor.name}</div>
      ${
        parsed
          ? html`
              <div
                className=${`json-verdict json-verdict--${parsed.ok ? "ok" : "bad"}`}
              >
                ${
                  parsed.ok
                    ? `Valid JSON.${descriptor.json.supported ? " Grammar-constrained." : " Not enforced — requested in the prompt only."}`
                    : `Not valid JSON: ${parsed.reason}${descriptor.json.supported ? "" : " Not enforced — requested in the prompt only."}`
                }
              </div>
            `
          : null
      }
      <${ToolCalls} calls=${turn.run?.toolCalls} />
      ${
        // Declared and not called. Worth its own line because on three of the
        // five that is the expected outcome and on the other two it is the
        // interesting one, and a reply that merely *talks* about adding two
        // numbers looks the same either way.
        turn.run?.toolRequested && !turn.run?.toolCalls?.length
          ? html`<div className="json-verdict json-verdict--bad">
              ${
                !toolsReachTheModel(descriptor, model)
                  ? "The declaration was not sent: this runtime accepts tools for a fixed list of models and this is not one of them."
                  : descriptor.tools.kind === "parsed"
                    ? "A tool was declared and the model did not call it."
                    : descriptor.tools.kind === "template"
                      ? "The declaration went into the chat template. Nothing here parses a call back out, so nothing ran."
                      : "The declaration was sent and dropped — this runtime ships no tool option to receive it."
              }
            </div>`
          : null
      }
      <div className="turn-text">
        ${parsed?.ok ? JSON.stringify(parsed.value, null, 2) : turn.text}
      </div>
      ${
        turn.run?.failed
          ? html`<div className="turn-error">
              failed: ${turn.run.failed.message}
            </div>`
          : null
      }
      <${RunStats} run=${turn.run} />
      ${
        turn.wire
          ? html`
              <button
                type="button"
                className="wire-open"
                onClick=${onShowWire}
                title="Show what was sent and what came back, verbatim"
                aria-label=${`Show the verbatim request and reply for turn ${turn.turn}`}
              >
                <span aria-hidden="true">⇅</span> verbatim
                ${
                  turn.wire.rawReported &&
                  turn.wire.raw.length !== turn.text.length
                    ? html`<span className="turn-flag"
                        >${turn.wire.raw.length - turn.text.length}
                        stripped</span
                      >`
                    : null
                }
              </button>
            `
          : null
      }
    </div>
  `;
};

export const Chat = ({ rt }) => {
  const { descriptor, status } = rt;
  // Index into rt.turns rather than the turn object: a new chat replaces the
  // array, and an index that no longer exists closes the modal by itself instead
  // of holding a stale payload open.
  const [wireIndex, setWireIndex] = useState(null);
  const wireTurn = wireIndex === null ? null : (rt.turns[wireIndex] ?? null);
  // Ask loads on demand, so it stays available when nothing is loaded — the only
  // things that block it are a load already in flight and a reply already
  // streaming. An "unavailable" or "error" status does NOT block it: pressing Ask
  // there re-runs the runtime's own check, which is the useful thing to do.
  const busy = rt.generating || status === "loading";
  const canAsk = !busy && rt.prompt.trim().length > 0;
  const loaded = status === "loaded";
  // Nothing to start over from when the transcript is already empty. Blocked
  // while a turn is running for a reason the controller enforces too: the reply
  // in flight would land in the new conversation.
  const canReset = !busy && (rt.turns.length > 0 || rt.streaming);
  const toolBadge = toolBadgeFor(descriptor, rt.model);

  return html`
    <section className="panel panel--chat">
      <div className="panel-head">
        <div className="panel-title">Conversation</div>
        <button
          type="button"
          className="btn btn--small"
          onClick=${rt.newChat}
          disabled=${!canReset}
        >
          New chat
        </button>
      </div>
      <p className="panel-note">
        ${descriptor.history.note} ${descriptor.history.reset}
      </p>

      <div className="output">
        ${
          rt.turns.length === 0 && !rt.streaming
            ? html`<p className="output-empty">
                ${loaded ? "Loaded." : "Ask loads the model first."}
              </p>`
            : null
        }
        ${rt.turns.map(
          (t, i) =>
            html`<${Turn}
              key=${i}
              turn=${t}
              descriptor=${descriptor}
              model=${rt.model}
              onShowWire=${() => setWireIndex(i)}
            />`,
        )}
        ${
          rt.streaming
            ? html`
                <div className="turn turn--model">
                  <div className="turn-role">
                    ${descriptor.name}
                    <span className="turn-flag turn-flag--live">streaming</span>
                  </div>
                  <div className="turn-text">${rt.streaming.text || "…"}</div>
                </div>
              `
            : null
        }
      </div>

      <label className="control">
        <span className="control-label">Prompt</span>
        <textarea
          className="control-input control-input--area"
          rows="2"
          placeholder="Ask something…"
          value=${rt.prompt}
          onChange=${(e) => rt.setPrompt(e.target.value)}
          onKeyDown=${(e) => {
            // Enter sends, shift+enter newlines. On a phone the on-screen
            // keyboard's return key is the only send affordance that does not
            // require scrolling back to a button.
            if (e.key === "Enter" && !e.shiftKey && canAsk) {
              e.preventDefault();
              rt.ask();
            }
          }}
        ></textarea>
      </label>

      ${
        wireTurn?.wire
          ? html`<${WireModal}
              wire=${wireTurn.wire}
              descriptor=${descriptor}
              turn=${wireTurn.turn}
              shownChars=${wireTurn.text.length}
              onClose=${() => setWireIndex(null)}
            />`
          : null
      }

      <div className="btn-row">
        <button
          type="button"
          className="btn btn--primary"
          onClick=${rt.ask}
          disabled=${!canAsk}
        >
          ${status === "loading" ? "Loading…" : loaded ? "Ask" : "Load & ask"}
        </button>
        <button
          type="button"
          className="btn"
          onClick=${rt.stop}
          disabled=${!rt.generating}
        >
          Stop
        </button>
        <label className="control--inline json-toggle">
          <input
            type="checkbox"
            checked=${rt.jsonMode}
            onChange=${(e) => rt.setJsonMode(e.target.checked)}
          />
          <span>
            JSON
            ${
              descriptor.json.supported
                ? html`<span className="control-flag control-flag--ok"
                    >grammar-constrained</span
                  >`
                : html`<span className="control-flag control-flag--bad"
                    >not enforced</span
                  >`
            }
          </span>
        </label>
        <label className="control--inline json-toggle">
          <input
            type="checkbox"
            checked=${rt.toolsMode}
            onChange=${(e) => rt.setToolsMode(e.target.checked)}
          />
          <span>
            Tool
            <span className=${`control-flag control-flag--${toolBadge.tone}`}
              >${toolBadge.text}</span
            >
          </span>
        </label>
      </div>
      ${
        // Only while it is on. The badge beside the checkbox already says whether
        // the schema is enforced; the full explanation is only wanted once asked
        // for.
        rt.jsonMode
          ? html`<p className="control-note">${descriptor.json.note}</p>`
          : null
      }
      ${
        rt.toolsMode
          ? html`<${ToolEditor}
              descriptor=${descriptor}
              source=${rt.toolSource}
              setSource=${rt.setToolSource}
              tool=${rt.tool}
              setPrompt=${rt.setPrompt}
              disabled=${busy}
            />`
          : null
      }
      ${
        rt.generating
          ? html`<p className="control-note">
              Stop uses <code>${descriptor.cancel.api}</code>.
            </p>`
          : null
      }
    </section>
  `;
};
