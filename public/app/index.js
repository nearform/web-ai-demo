import { html } from "./util/html.js";
import { useRuntime } from "./hooks/useRuntime.js";
import { RuntimePicker } from "./components/RuntimePicker.js";
import { RuntimePanel } from "./components/RuntimePanel.js";
import { Guidance } from "./components/Guidance.js";
import { Chat } from "./components/Chat.js";
import { CrashBanner, Diagnostics } from "./components/Diagnostics.js";

const REPO_URL = "https://github.com/nearform/web-ai-demo";
const BANNER_URL =
  "https://www.nearform.com/contact/?utm_source=open-source&utm_medium=banner&utm_campaign=os-project-pages";

const ExtLink = ({ href, children }) =>
  html`<a href=${href} target="_blank" rel="noopener noreferrer"
    >${children}</a
  >`;

export const App = () => {
  const rt = useRuntime();

  return html`
    <div className="app-container">
      <header className="app-header">
        <h1>Web AI Demo</h1>
        <p className="intro">
          Five ways to run a language model in the browser. No server, no build
          step, and no data leaves the device. By${" "}
          <${ExtLink} href="https://nearform.com">Nearform<//>.${" "}
          <a
            href=${REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="intro-github-link"
            aria-label="View on GitHub"
          >
            <i className="ph ph-github-logo"></i>
          </a>
        </p>
      </header>

      <main className="content">
        <${CrashBanner}
          recovered=${rt.recoveredCrash}
          onCopy=${rt.copyDiagnostics}
        />
        <${RuntimePicker}
          activeId=${rt.providerId}
          onSelect=${rt.selectProvider}
          disabled=${rt.generating}
        />
        <${RuntimePanel} rt=${rt} />
        <${Chat} rt=${rt} />
        <${Guidance} descriptor=${rt.descriptor} />
        <${Diagnostics} rt=${rt} />
      </main>

      <footer className="footer">
        <${ExtLink} href=${BANNER_URL}>
          <img
            src="https://raw.githubusercontent.com/nearform/.github/refs/heads/master/assets/os-banner-green.svg"
            alt="Nearform Open Source"
            className="nearform-banner"
          />
        <//>
      </footer>
    </div>
  `;
};
