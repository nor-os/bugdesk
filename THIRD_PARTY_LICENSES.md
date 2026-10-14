# Third-party licences

BugDesk itself is MIT (see `LICENSE`).

## The UI (`ui/vendor/`)

Everything here is committed and served as static files, with no build step:
what's in the repository is what ships, in a browser tab and inside the desktop
app alike. See `ui/index.html`'s `<link>`/`<script>` tags and its import map.

| Library | Version | Licence | Copyright | Licence text |
|---|---|---|---|---|
| [FlexDesk](https://github.com/nor-os/FlexDesk) (`ui/vendor/flexdesk/`) | 0.14.1 | MIT | nor-os | `ui/vendor/flexdesk/LICENSE` |
| [Plotly.js](https://github.com/plotly/plotly.js) (`ui/vendor/plotly/`, loaded only when a dashboard opens) | 2.35.2 | MIT | Plotly, Inc. | `ui/vendor/plotly/LICENSE` |
| [Material Symbols (Outlined)](https://github.com/google/material-design-icons) (`ui/vendor/material-symbols/`) | — | Apache-2.0 | Google LLC | upstream `LICENSE` |
| [Marck Script](https://fonts.google.com/specimen/Marck+Script) (Latin subset, `ui/vendor/marck-script/`), the BugDesk wordmark | v22 | OFL-1.1 | Denis Masharov & Marck Fogel | `ui/vendor/marck-script/OFL.txt` |
| [Sonsie One](https://fonts.google.com/specimen/Sonsie+One) (Latin subset, `ui/vendor/sonsie-one/`), the TicketDesk wordmark | v22 | OFL-1.1 | Sorkin Type Co | `ui/vendor/sonsie-one/OFL.txt` |

FlexDesk is vendored from its npm package by `scripts/sync-flexdesk.mjs` (the
version is in `ui/vendor/flexdesk/VERSION`). It has **no runtime dependencies of
its own**: see its `THIRD_PARTY_LICENSES.md`, copied alongside it.

## The server

The server (`server/`) uses ASP.NET Core and references no NuGet packages.

| Component | Licence | Copyright |
|---|---|---|
| [.NET runtime and ASP.NET Core](https://github.com/dotnet/runtime) | MIT | .NET Foundation and Contributors |

When it runs from a checkout (`run.sh` / `run.ps1`), the server uses the .NET SDK
installed on the machine.

## The desktop app (`desktop/`)

The packages in `desktop/out/` (MSI, portable zip, `.deb`, `.tar.gz`) are
self-contained. Each one carries the UI above, the server, the .NET runtime and
ASP.NET Core, and:

| Component | Version | Licence | Copyright |
|---|---|---|---|
| [Photino.NET](https://github.com/tryphotino/photino.NET) (`Photino.NET.dll`) | 4.0.16 | Apache-2.0 | Tryphotino |
| [Photino.Native](https://github.com/tryphotino/photino.Native) (`Photino.Native.dll` / `Photino.Native.so`) | 4.0.22 | Apache-2.0 | Tryphotino |
| ↳ [WebView2 loader](https://www.nuget.org/packages/Microsoft.Web.WebView2) (`WebView2Loader.dll`, Windows only, bundled with Photino.Native) | — | BSD-style (the WebView2 SDK's `LICENSE.txt`) | Microsoft Corporation |
| [.NET runtime](https://github.com/dotnet/runtime) (including `msquic`) | 10.0 | MIT | .NET Foundation and Contributors |

The web views themselves are part of the operating system and are not shipped:

- **Windows:** the Microsoft Edge WebView2 Runtime.
- **Linux:** WebKitGTK 4.1 and GTK 3, which are LGPL. The `.deb` declares them as
  dependencies and links to them dynamically.

## Icons

`ui/assets/icons/`: the BugDesk and TicketDesk icons (`bugdesk-*`,
`bugdesk.ico`, `ticketdesk-*`) are this project's own. The `ecoagent-*` files are
leftovers from the project BugDesk was built out of. Nothing references them.

## Build-time only

These are not shipped and are not a dependency of anyone using BugDesk.

| Package | Licence | Copyright |
|---|---|---|
| [.NET SDK](https://github.com/dotnet/sdk) | MIT | .NET Foundation and Contributors |
| [WiX Toolset](https://github.com/wixtoolset/wix) 5.0.2 (builds the MSI) | MS-RL | .NET Foundation and contributors |
| [ESLint](https://github.com/eslint/eslint), [jsdom](https://github.com/jsdom/jsdom), [globals](https://github.com/sindresorhus/globals) (lint and tests) | MIT | their authors |

---

Every licence above was read from the vendored file's own licence file or
banner, or from the NuGet package's licence expression. None was written from
memory. Nothing that ships is copyleft. The LGPL WebKitGTK is a system library
the Linux app links to dynamically, and it is not bundled. All of it is
compatible with BugDesk's MIT distribution.
