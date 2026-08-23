import { html } from "../util/html.js";

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

const Turn = ({ turn, descriptor }) => {
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
    </div>
  `;
};

export const Chat = ({ rt }) => {
  const { descriptor, status } = rt;
  // Ask loads on demand, so it stays available when nothing is loaded — the only
  // things that block it are a load already in flight and a reply already
  // streaming. An "unavailable" or "error" status does NOT block it: pressing Ask
  // there re-runs the runtime's own check, which is the useful thing to do.
  const busy = rt.generating || status === "loading";
  const canAsk = !busy && rt.prompt.trim().length > 0;
  const loaded = status === "loaded";

  return html`
    <section className="panel panel--chat">
      <div className="panel-title">Conversation</div>
      <p className="panel-note">${descriptor.history.note}</p>

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
            html`<${Turn} key=${i} turn=${t} descriptor=${descriptor} />`,
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
        rt.generating
          ? html`<p className="control-note">
              Stop uses <code>${descriptor.cancel.api}</code>.
            </p>`
          : null
      }
    </section>
  `;
};
