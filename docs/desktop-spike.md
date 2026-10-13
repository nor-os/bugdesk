# Desktop app spike (STORY-0009)

BugDesk in a native window instead of a browser tab: what the spike built, what
it found, and the stories it leads to. Host chosen beforehand: **Photino.NET**,
as `../SixShare/SixShare.Desktop` uses.

## What was built

`desktop/BugDesk.Desktop/` is a Windows prototype, about 120 lines:

- The **BugDesk server runs in the same process.** The desktop app calls the
  server assembly's entry point (top-level statements compile to an ordinary
  `Main`) on a background thread. It sets `ASPNETCORE_URLS` to a free loopback
  port first, so it never collides with a BugDesk already running on 8766.
- It waits until the server answers, then opens a **Photino window** on that
  URL. Closing the window ends the process.
- A **native bridge** over Photino's web messages answers `host.describe`,
  `window.isMaximized` and `window.setMaximized`, which proves the round trip.

The server finds `ui/` by walking up from its own folder, so the app runs from
any build folder inside the checkout. The prototype was checked by starting it
minimised, against a scratch store, with WebView2's debug port open:

- the page loaded (`/p/<project>/`, title "BugDesk", the tiling shell up);
- `window.external.sendMessage({id:1, cap:'host', op:'describe'})` came back as
  `{"id":1,"ok":true,"value":{"host":"photino","version":"4.0.16.0",…}}`;
- `window.isMaximized` came back `false`.

Run it (Windows):

```
cd desktop/BugDesk.Desktop
dotnet run
```

Set `BUGDESK_DESKTOP_MINIMIZED=1` to start it out of the way, and
`BUGDESK_DESKTOP_DEVTOOLS=1` for the WebView2 dev tools. The usual
`BUGDESK_PROJECTS`, `BUGDESK_BUGS` and friends apply.

> While your own BugDesk runs, don't `dotnet run` the desktop project: it
> builds the server into `server/bin`, whose DLL the running server holds. Build
> to another folder with `dotnet build -o <dir>`.

## The host port: a Photino host for `@flexdesk/host`

FlexDesk's host port (`@flexdesk/host`) declares what a framework app may ask
of the window it runs in. Each capability is optional; if the host doesn't
offer it, the key is simply absent.

- `window`: chrome, minimize, close, isMaximized, setMaximized, isFullscreen,
  toggleFullscreen, getBounds, setBounds, and optionally startNativeDrag
- `dialogs`: saveFile
- `state`: read, write

`pywebview_host.js` is the reference adapter for pywebview. **A Photino host
belongs next to it in FlexDesk** (`src/host/photino_host.js`), so EcoSim and
any other FlexDesk app can use the same bridge when it moves to Photino.

**Wire protocol.** A Photino page can send and receive strings:
`window.external.sendMessage(text)` and `window.external.receiveMessage(fn)`.
The adapter puts a request/reply layer over them, matched by `id`:

```
page → host   {"id": 7, "cap": "window", "op": "setBounds", "args": [{"x":0,"y":0,"width":1200,"height":800}]}
host → page   {"id": 7, "ok": true, "value": null}
host → page   {"id": 8, "ok": false, "error": "no such op"}
host → page   {"event": "window.maximizedChanged", "value": true}      // unsolicited, no id
```

- `args` is an array, so a reply maps onto the port's positional methods the
  way pywebview's does.
- A request with no reply within 10 s rejects. A reply to an unknown `id` is
  dropped.

**The adapter** (sketch):

```js
// FlexDesk src/host/photino_host.js
import { createHost, NULL_HOST } from './host.js';

export function createPhotinoHost({ timeoutMs = 10000 } = {}) {
    const ext = typeof window !== 'undefined' && window.external;
    if (!ext || typeof ext.sendMessage !== 'function') return NULL_HOST;   // a browser tab
    const pending = new Map();
    let seq = 0;
    ext.receiveMessage((text) => {
        let m; try { m = JSON.parse(text); } catch { return; }
        const p = m && pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        m.ok ? p.resolve(m.value) : p.reject(new Error(m.error || 'host refused'));
    });
    const call = (cap, op, ...args) => new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        setTimeout(() => { if (pending.delete(id)) reject(new Error(`${cap}.${op}: no answer`)); }, timeoutMs);
        ext.sendMessage(JSON.stringify({ id, cap, op, args }));
    });
    return createHost({
        window: {
            chrome: () => 'native',            // Photino draws a native title bar
            minimize: () => call('window', 'minimize'),
            close: () => call('window', 'close'),
            isMaximized: () => call('window', 'isMaximized'),
            setMaximized: (on) => call('window', 'setMaximized', on),
            isFullscreen: () => call('window', 'isFullscreen'),
            toggleFullscreen: () => call('window', 'toggleFullscreen'),
            getBounds: () => call('window', 'getBounds'),
            setBounds: (b) => call('window', 'setBounds', b),
        },
        dialogs: { saveFile: (opts) => call('dialogs', 'saveFile', opts) },
        state: { read: (key) => call('state', 'read', key), write: (key, value) => call('state', 'write', key, value) },
    });
}
```

- **The browser fallback is the port's own.** With no `window.external`, the
  adapter returns `NULL_HOST`, and every FlexDesk consumer must already survive
  a host with no capabilities. BugDesk in a browser tab is unchanged.
- **The C# side** is one dispatcher on the window's web-message handler. The
  prototype's `Desktop.Handle` is its first three entries; the rest map onto
  Photino directly:

  | Request | Photino call |
  |---|---|
  | `minimize` | `Minimized = true` |
  | `setMaximized` | `Maximized` |
  | `toggleFullscreen` | `FullScreen` |
  | `getBounds` / `setBounds` | `Location` / `Size` |
  | `close` | `Close()` |
  | `saveFile` | `ShowSaveFile(title, defaultPath, filters)` |
  | `state.read` / `state.write` | a JSON file per key in the user's BugDesk folder |

  An unsolicited event (maximized, closing) is `SendWebMessage` with no `id`.

**Chrome.** Photino draws a native, decorated window on every OS, so
`chrome()` answers `native`. FlexDesk then doesn't draw its own min/max/close
buttons, the same decision pywebview's adapter makes on Linux and macOS.
Photino can't do a frameless window with a custom title bar as reliably as
pywebview on Windows, so the native frame is the simpler default.

## Linux and macOS

What SixShare needed and BugDesk would too:

- **Windows.**
  - WebView2 ships with Windows 10 and 11. Older systems need the Evergreen
    runtime installer.
  - The window and taskbar want an **`.ico`**; BugDesk only has an SVG glyph
    so far (`ui/assets/icons/bugdesk-glyph.svg`), so the spike shows the
    default icon.
  - SixShare also sets an AppUserModelID and refreshes the taskbar icon on
    the window handle, otherwise taskbar grouping and the pinned icon are
    wrong. That's about 60 lines of P/Invoke in `SixShare.Desktop/Program.cs`
    to reuse.
- **Linux.**
  - Photino uses WebKitGTK, so the package depends on `libwebkit2gtk-4.1`
    (Debian/Ubuntu) or `webkit2gtk4.1` (Fedora).
  - The icon has to be a **PNG**.
  - `PhotinoWindow.WindowHandle` throws on Linux, so anything handle-based
    (the tray) finds the GtkWindow by title; see `LinuxTrayService.cs`.
  - A `.desktop` file is needed for the launcher.
- **macOS.**
  - Photino uses WKWebView.
  - It must ship as an `.app` bundle with an `Info.plist` and an `.icns`, and
    be signed and notarised, or Gatekeeper blocks it.
  - SixShare has a `SixShare.Desktop.MacOS` project for the bundle layout.
- **The tray** is optional for BugDesk: it is not a background service. A
  single-instance guard is not optional. A second launch should bring the
  first window forward, not start a second server on the same store.

## Packaging and size

| Build | Size | Notes |
|---|---|---|
| Framework-dependent, `net10.0-windows10.0.19041.0` (the spike) | 26 MB | 24 MB of it is `Microsoft.Windows.SDK.NET.dll`, the WinRT projection the `-windows` target pulls in |
| Framework-dependent, plain `net10.0` | ~1.5 MB + `ui/` 12 MB | Photino works without the Windows SDK projection; the taskbar fixes only need P/Invoke |
| Self-contained, single file | ~70–80 MB + `ui/` | The .NET runtime. Trimming is risky with minimal APIs and reflection-built JSON, so expect little from it |

- **`ui/`** (12 MB, of which 9.7 MB is vendored FlexDesk) ships beside the
  executable, or as embedded resources served from memory. Beside it is
  simpler and keeps `ui/` patchable.
- **Installer:** a per-user MSI (WiX) or MSIX on Windows, the `.app` in a
  `.dmg` on macOS, and an AppImage or `.deb` on Linux. SixShare's
  `Installer/` folder is the starting point for Windows.
- **Data:** the store stays where it is (the repo). The desktop app only needs
  `projects.toml` and the state folder, which belong in the user's app-data
  folder rather than beside the executable.

## Risks found

- **The server entry point is invoked by reflection.** It works, but it depends
  on the server staying a top-level-statements app with a `Main`. A cleaner
  build would move the startup into a `BugDeskServer.Start(args)` method that
  both the console server and the desktop app call. It is a small refactor of
  `server/Program.cs`.
- **Shutdown.** `Environment.Exit` after the window closes runs the server's
  `ApplicationStopping` handlers (the caches are flushed), but it doesn't wait
  for an in-flight write. A `StopAsync()` on the host first would be the clean
  path, and the refactor above makes it reachable.
- **The free port** changes on every launch, so anything that remembers the URL
  (browser bookmarks of the desktop page) cannot. That's fine for a desktop
  app, and the reason it binds loopback only.

## Build stories

Filed for EPIC-0021:

- **STORY-0025:** Package BugDesk as a Windows desktop app. Server startup as a
  callable method, single instance, graceful stop, `.ico`, AppUserModelID,
  plain `net10.0`, installer.
- **STORY-0026:** BugDesk uses the native host: window state remembered, the
  native save dialog for exports. Depends on FlexDesk's Photino host.
- **STORY-0027:** Linux and macOS desktop builds (WebKitGTK and PNG icon; .app,
  signing and notarisation).
- In FlexDesk (`../FlexDesk/backlog/`): **STORY-0015**, a Photino host for
  `@flexdesk/host` (`photino_host.js`), with a reference C# dispatcher and a
  test against a fake `window.external`.
