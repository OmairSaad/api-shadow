# Contributing to API Shadow

This guide covers building, running, testing, packaging and publishing the extension. For how the analysis works, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- Node.js 18 or newer (developed on Node 24) and npm
- VS Code 1.85 or newer
- For the VS Code-based test suites: network access once (VS Code is downloaded into `.vscode-test/`) and a display. On headless Linux, use `xvfb-run -a`.
- For `npm run screenshots`: ImageMagick (`convert`) and ffmpeg

## Setup

```bash
npm install
npm run build          # bundle src/ into dist/extension.js with esbuild
npm run watch          # rebuild on change
```

## Run the extension (F5)

Open this folder in VS Code and press **F5**. The **Run Extension (fixture workspace)** launch configuration builds the extension and opens `test/fixtures`, which contains sample Express, NestJS and Spring Boot projects, in an Extension Development Host. Click the API Shadow icon in the Activity Bar.

**Run Extension (empty window)** starts without a folder, so you can open any project of your own.

## Checks and tests

| Command | What it runs |
|---|---|
| `npm run typecheck` | `tsc` over the sources, unit tests, integration tests, UI tests and the screenshot script |
| `npm run lint` | ESLint with typescript-eslint |
| `npm run test:unit` | Vitest: analyzers, linkers, engine (incremental runs, cancellation, limits, cache), exporters (OpenAPI validated with swagger-parser), secret-leak checks |
| `npm run test:integration` | Mocha inside a real VS Code Extension Development Host (`@vscode/test-cli`) |
| `npm run test:e2e` | Playwright drives the VS Code UI through Electron: clicks, quick picks, keyboard navigation, Problems panel, save dialog, live updates |
| `npm run test:e2e:vsix` | Packages the VSIX, installs it into a clean VS Code and runs the same UI tests against it |
| `npm run test:all` | typecheck, lint, unit, integration and UI tests |

Notes:

- Set `VSCODE_TEST_VERSION` to pin the VS Code version used by the integration and UI tests (default: `stable`).
- On a headless CI agent: `xvfb-run -a npm run test:integration` and `xvfb-run -a npm run test:e2e`.
- Starting the tests from a terminal inside VS Code is fine: the launcher removes the inherited `ELECTRON_RUN_AS_NODE` and `VSCODE_*` variables.
- UI test screenshots go to `test-results/screenshots/` and the HTML report to `playwright-report/`.

## Marketplace screenshots

The images in `media/` (shown on the Marketplace page) are generated, not hand-made:

```bash
npm run screenshots
```

This packages the VSIX, installs it into a clean VS Code, opens a demo copy of the fixtures and drives the real UI to capture each screenshot and the animated demo (`media/demo.gif`). Run it after UI changes and commit the updated images.

## Package

```bash
npm run package        # production build (vscode:prepublish), then vsce package
code --install-extension api-shadow-0.2.0.vsix
```

`vsce` rewrites the relative image links in `README.md` to `https://github.com/OmairSaad/api-shadow/raw/HEAD/...`, using the `repository` field in `package.json`. The images therefore only display once this repository is public on GitHub with `media/` on its default branch.

## Publish to the Visual Studio Marketplace

The extension is published under the existing publisher **`OmairSaad`** (display name "Omair Saad", the same publisher as SQLite Forge), so its Marketplace ID is `OmairSaad.api-shadow`. The `publisher` field in `package.json` must stay exactly `OmairSaad`.

1. Push this repository to <https://github.com/OmairSaad/api-shadow> and make sure it's public, so the README images resolve.
2. Publish using one of these two options.

   **Upload in the browser** (no token needed):

   ```bash
   npm run package        # creates api-shadow-0.2.0.vsix
   ```

   Then open <https://marketplace.visualstudio.com/manage/publishers/OmairSaad>, choose **New extension → Visual Studio Code**, and upload the `.vsix`.

   **Publish from the command line**: create an Azure DevOps Personal Access Token (<https://dev.azure.com> → User settings → Personal access tokens) with **Organization: All accessible organizations** and **Scopes: Marketplace → Manage**, then:

   ```bash
   npx vsce login OmairSaad
   npm run publish
   ```

3. The Marketplace verifies new extensions before listing them, which usually takes a few minutes.

To release a new version later, update `CHANGELOG.md` and bump `version` in `package.json` (`npm version patch`). Then either upload the new `.vsix` with **Update** on the extension's row in the publisher page, or run `npx vsce publish`.
