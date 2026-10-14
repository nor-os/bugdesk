# The desktop app

`desktop/BugDesk.Desktop` opens BugDesk in a native window (Photino.NET:
WebView2 on Windows, WebKitGTK on Linux) instead of a browser tab. It is the same
BugDesk: the server runs inside the app's own process, on a free loopback port,
and the window shows its page. How it came about is in `desktop-spike.md`.

## Running it from a checkout

Windows:

```
dotnet build desktop\BugDesk.Desktop -o desktop\BugDesk.Desktop\bin\dev
desktop\BugDesk.Desktop\bin\dev\BugDesk.exe
```

Build into a folder of its own, as above: a plain `dotnet run` builds the server
into `server/bin`, whose DLL a BugDesk already running from `run.ps1` holds. The
server finds `ui/` by walking up from the executable, so any folder inside the
checkout works; a packaged app carries `ui/` beside the executable.

| Variable | Effect |
|---|---|
| `BUGDESK_DESKTOP_HOME` | the app's own folder (default `%AppData%\BugDesk`, `~/.config/BugDesk` on Linux) |
| `BUGDESK_PROJECTS`, `BUGDESK_STATE` | as for the server; default to `projects.toml` and `state/` in that folder |
| `BUGDESK_DESKTOP_MINIMIZED=1` | start minimised, out of the way of a test run |
| `BUGDESK_DESKTOP_DEVTOOLS=1` | allow the WebView's developer tools |

`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<n>` opens the
page to CDP on Windows, the way the app is tested.

## What it does

- **Its own folder.** `projects.toml`, the server's `state/` and the WebView's
  profile live in the app's folder, never beside the executable, which may be
  installed where the user cannot write. The stores themselves stay where they
  are, in their repositories.
- **First launch.** With no `projects.toml`, the app writes one with no projects
  in it and asks for a project folder with the native folder picker: the
  repository whose `bugs/` and `backlog/` it should open (picking `bugs/` or
  `backlog/` itself means its parent). The project is added through the
  server's `POST /api/projects`, under the folder's name, and opened.
  Cancelling closes the app and asks again next time. A store named with
  `BUGDESK_BUGS` / `BUGDESK_BACKLOG` skips this, as the console server would.
- **One window.** A named mutex per user and `projects.toml` keeps one instance;
  a second launch tells the first, over a named pipe, to come forward
  (restoring it if minimised) and exits. No second server starts on the same
  stores. A run against another `projects.toml` is a separate instance.
- **A clean stop.** Closing the window calls `StopAsync` on the server, which
  ends the live-update streams and flushes the record caches before the
  process exits (within the server's 5 s shutdown timeout).
- **Windows shell.** The process sets the AppUserModelID `BugDesk.Desktop`, so
  the window, its taskbar button and a pinned shortcut group as one app, and
  the window's small and large icons are set from `ui/assets/icons/bugdesk.ico`.
  The executable carries the same icon.

The server is `BugDeskServer.Run(args, built)` in `server/Program.cs`; the
console server's entry point (`server/Entry.cs`) calls it, and so does the app,
which keeps the `WebApplication` that `built` hands it in order to stop it.

## The icon

`ui/assets/icons/bugdesk.ico` (16–256 px) and `bugdesk-256.png` (Linux) are
rendered from the SVGs beside them: `bugdesk-glyph.svg` for 16–32 px,
`bugdesk-icon-detailed.svg` above that. They were rendered with headless Edge
(`--default-background-color=00000000` keeps the corners transparent) and packed
with Pillow; re-render them the same way if the SVGs change.

## The native bridge

The page talks to the window over Photino's web messages as JSON:
`{id, cap, op, args}` in, `{id, ok, value | error}` out
(`desktop/BugDesk.Desktop/NativeBridge.cs`). The protocol, and the FlexDesk host
adapter on the page's side, are described in `desktop-spike.md` under
*The host port*.
