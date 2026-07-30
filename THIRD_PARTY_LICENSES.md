# Third-party licences

BugDesk itself is MIT (see `LICENSE`).

## FlexDesk

`ui/vendor/flexdesk/` vendors [FlexDesk](https://github.com/nor-os/FlexDesk)
(prebuilt `dist/`, not rebuilt here — no Node/build step for the UI). FlexDesk
is MIT, copyright nor-os, and has **zero runtime dependencies of its own** —
see its own `LICENSE` and `THIRD_PARTY_LICENSES.md`, copied alongside it in
`ui/vendor/flexdesk/`.

## Vendored runtime libraries (`ui/vendor/`)

| Library | Version | Licence | Copyright |
|---|---|---|---|
| [CodeMirror 6](https://github.com/codemirror/state) (state, view, commands, language, autocomplete, search, lint) | 6.x | MIT | Marijn Haverbeke and others |
| [Lezer](https://github.com/lezer-parser/common) (common, highlight, lr) | — | MIT | Marijn Haverbeke and others |
| [crelt](https://github.com/marijnh/crelt) | — | MIT | Marijn Haverbeke |
| [style-mod](https://github.com/marijnh/style-mod) | — | MIT | Marijn Haverbeke and others |
| [w3c-keyname](https://github.com/marijnh/w3c-keyname) | — | MIT | Marijn Haverbeke and others |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 0.16.10 | MIT | Khan Academy and other contributors |
| [Plotly.js](https://github.com/plotly/plotly.js) | 2.35.2 | MIT | Plotly, Inc. |
| [Material Symbols (Outlined)](https://github.com/google/material-design-icons) | — | Apache-2.0 | Google LLC |
| [Monaco Editor](https://github.com/microsoft/monaco-editor) | 0.52.2 | MIT | Microsoft Corporation |
| ↳ [DOMPurify](https://github.com/cure53/DOMPurify) (bundled in Monaco's `editor.main.js`) | 3.1.7 | Apache-2.0 (dual-licensed with MPL-2.0; Apache-2.0 elected) | Cure53 and other contributors |
| ↳ [TypeScript](https://github.com/microsoft/TypeScript) `lib.*.d.ts` (bundled in Monaco's `tsWorker.js`) | — | Apache-2.0 | Microsoft Corporation |
| ↳ [Codicon font](https://github.com/microsoft/vscode-codicons) (bundled in Monaco's `vs/base/...`) | — | CC-BY-4.0 | Microsoft Corporation |

Every entry above is committed under `ui/vendor/` and served as a static file
— see `ui/index.html`'s `<link>`/`<script>` tags and import map. `ui/vendor/`
has no build step; what's committed is what ships.

Version numbers are read from each package's own embedded license banner or
version string where one exists (CodeMirror/Lezer/crelt/style-mod/w3c-keyname
ship no such banner in their built form — the licence text itself was
confirmed against each project's upstream `LICENSE` file, all standard MIT
boilerplate under Marijn Haverbeke's copyright).

## Icons

`ui/assets/icons/` (`ecoagent-*.png`, `ecoagent.ico`) — no third-party
markers or embedded metadata found; these appear to be this project's own
assets, not pulled from a licensed icon set.

## Build-time only

Not shipped, not a dependency of anyone using the built UI.

| Package | Licence | Copyright |
|---|---|---|
| [.NET SDK](https://github.com/dotnet/sdk) (server) | MIT | .NET Foundation and Contributors |

---

Every licence above was read from the vendored file's own embedded banner
(where present) or cross-checked against the upstream project's `LICENSE`
file — not from memory. Nothing vendored under `ui/vendor/` is copyleft
(GPL/LGPL/AGPL/MPL) or unlicensed; everything is MIT, ISC, Apache-2.0, or
CC-BY-4.0, all compatible with BugDesk's MIT distribution.
