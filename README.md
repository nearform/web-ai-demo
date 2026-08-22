# Web AI Demo

A tour of the different ways to run AI models directly in the browser.

Planned stops on the tour:

- [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api)
- [web-llm](https://github.com/mlc-ai/web-llm)
- [Hugging Face Transformers.js](https://huggingface.co/docs/transformers.js)
- [LiteRT.js](https://ai.google.dev/edge/litert/web)
- [wllama](https://github.com/ngxson/wllama)

Everything runs locally in the browser. No backend, no build step, and no data
of any kind is collected or transmitted — the diagnostics these pages produce
stay on your device.

## Spikes

Before the unified demo, each runtime gets a throwaway page under
[`public/spikes/`](public/spikes/): latest version of the library, the smallest
model it offers, no shared abstraction. Each answers one question — does this
load and generate on this device, today — and captures the verbatim error when it
doesn't.

```sh
npm run dev     # then open http://localhost:4710/public/spikes/
```

The spikes deliberately share no provider code with each other. When one fails,
the failure is the runtime's and not an abstraction's.

## Development

```sh
nvm use
npm ci
npm run dev     # http://localhost:4710/public/
```

Checks and formatting:

```sh
npm run check   # lint + prettier, no writes
npm run format  # lint --fix + prettier --write
```

## Deployment

Pushes to `main` publish `public/` to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## License

[MIT](LICENSE.txt)
