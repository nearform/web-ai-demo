# Web AI Demo

A tour of the different ways to run AI models directly in the browser.

Planned stops on the tour:

- [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api)
- [web-llm](https://github.com/mlc-ai/web-llm)
- [Hugging Face Transformers.js](https://huggingface.co/docs/transformers.js)
- [LiteRT.js](https://ai.google.dev/edge/litert/web)
- [wllama](https://github.com/ngxson/wllama)

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
