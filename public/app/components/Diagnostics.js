import { html } from "../util/html.js";

// The crash banner, placed above the panels rather than in the log: on a phone
// the log is several scrolls down.
//
// crashbox delivers a record once and consumes it, so a reload loses the banner.
// The record stays in this session's diagnostics, hence the copy-first note.
export const CrashBanner = ({ recovered, onCopy }) =>
  !recovered
    ? null
    : html`
        <section className="recovery">
          <div className="recovery-title">
            Previous session crashed — ${recovered.reason}
          </div>
          <div className="recovery-detail">
            Last heartbeat ${new Date(recovered.lastSeen).toISOString()}.
            ${
              recovered.snapshot?.provider
                ? html` It was running
                    <strong>${recovered.snapshot.provider}</strong>${
                      recovered.snapshot.model
                        ? html` on <code>${recovered.snapshot.model}</code>`
                        : null
                    }${
                      recovered.snapshot.phase
                        ? html`, during
                            <strong>${recovered.snapshot.phase}</strong>`
                        : null
                    }.`
                : null
            }
            The breadcrumb trail and the last recorded state are in the log and
            in the copied diagnostics.
          </div>
          <button type="button" className="btn btn--small" onClick=${onCopy}>
            Copy diagnostics now
          </button>
          <div className="recovery-detail">
            Copy before reloading — the record is delivered once.
          </div>
        </section>
      `;

const LogLine = ({ entry }) => html`
  <div className=${`log-line log-line--${entry.level}`}>
    <span className="log-time">
      +${(entry.sinceStartMs / 1000).toFixed(2)}s
    </span>
    <span className="log-msg">${entry.message}</span>
    ${
      entry.data === undefined
        ? null
        : html`<pre className="log-data">
${JSON.stringify(entry.data, null, 2)}</pre>`
    }
  </div>
`;

export const Diagnostics = ({ rt }) => html`
  <section className="panel panel--diagnostics">
    <div className="panel-title">Diagnostics</div>
    <p className="panel-note">
      Nothing on this page is transmitted or collected. Copy writes the
      diagnostics to your clipboard.
    </p>

    <details className="detail-block">
      <summary>This device</summary>
      <pre className="probe">
${rt.device ? JSON.stringify(rt.device, null, 2) : "probing…"}</pre>
    </details>

    <details className="detail-block" open>
      <summary>Log (${rt.events.length})</summary>
      <div className="log">
        ${rt.events.map((e, i) => html`<${LogLine} key=${i} entry=${e} />`)}
      </div>
    </details>

    <details className="detail-block">
      <summary>Runs (${rt.runs.length})</summary>
      <pre className="probe">${JSON.stringify(rt.runs, null, 2)}</pre>
    </details>

    <div className="btn-row">
      <button type="button" className="btn" onClick=${rt.copyDiagnostics}>
        Copy diagnostics
      </button>
    </div>

    <p className="panel-note">
      A tab killed by an out-of-memory runs no JavaScript on the way out, so it
      cannot report anything. This page keeps breadcrumbs and a small state
      snapshot in <code>localStorage</code> as it goes, using${" "}
      <a
        href="https://github.com/nearform/crashbox"
        target="_blank"
        rel="noopener noreferrer"
        >crashbox</a
      >, and reports on the next visit if the previous session did not exit
      cleanly. Also local only.
    </p>
  </section>
`;
