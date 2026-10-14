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

## Packaging (Windows)

```
powershell -ExecutionPolicy Bypass -File desktop\build-windows.ps1 [-Version 0.2.1]
```

builds, into `desktop/out/` (git-ignored):

| File | What it is |
|---|---|
| `BugDesk-<version>-win-x64.msi` | per-user install to `%LocalAppData%\Programs\BugDesk`, no administrator prompt; a Start-menu shortcut with the app's AppUserModelID; an entry in Installed apps |
| `BugDesk-<version>-win-x64-portable.zip` | one self-contained `BugDesk.exe` (Photino's native libraries inside, compressed) and `ui\` beside it; unzip anywhere and run |

Both carry the .NET runtime, so nothing has to be installed first; both
leave out `ui/`'s source maps. The version defaults to `package.json`'s; the
MSI's `MajorUpgrade` replaces an older install in place, so a new MSI needs a
higher version. Uninstalling removes the program folder and the shortcut, and
leaves the user's `%AppData%\BugDesk` alone. The script also publishes the
framework-dependent app once and prints its size (about 1.4 MB without `ui/`).

The MSI is `desktop/installer/` (WiX 5, as `../SixShare/Installer`). It
suppresses the ICEs that want every per-user component keyed on an HKCU value
(ICE38, ICE64, ICE91) and ICE60 (versioned non-font files). Neither package is
signed, so SmartScreen warns on the first run.

## Linux

```
desktop/linux/build.sh [version]
```

builds, into `desktop/out/`:

| File | What it is |
|---|---|
| `bugdesk_<version>_amd64.deb` | the app in `/opt/bugdesk`, `bugdesk` on `PATH`, a launcher entry (`desktop/linux/bugdesk.desktop`) and its icon in `hicolor` |
| `bugdesk-<version>-linux-x64.tar.gz` | the same app as a folder; run `./BugDesk` |

Both are self-contained. What they need from the system is WebKitGTK 4.1 and
GTK 3, which the `.deb` declares (`libwebkit2gtk-4.1-0`). Started without
WebKitGTK, the app says which package to install and exits, rather than dying
in Photino's native-library load. Run the script on a Linux file system or under
WSL; it stages the package in a temporary folder because `dpkg-deb` refuses
the permissions a Windows drive reports.

The app is the same as on Windows, with these differences:

- Its folder is `~/.config/BugDesk`.
- Nothing touches the window handle (Photino's `WindowHandle` throws on
  Linux); the shell fixes are Windows-only.
- The single-instance mutex is `Global\` rather than `Local\`: on Linux,
  `Local\` means the POSIX session, and every terminal is its own.
- SIGTERM (a logout, `kill`) stops the server, and the window closes with it.
- It runs through XWayland: under a Wayland session Photino hangs while
  creating the window, so the app sets `GDK_BACKEND=x11` unless one is
  already set. It sets it with libc's `setenv`, because .NET's
  `SetEnvironmentVariable` does not reach native code on Unix.
- Under WSLg the window opens at its minimum size (900 × 600). WSLg's window
  manager refuses resizes, from Photino and from plain X11 alike.

## The icon

`ui/assets/icons/bugdesk.ico` (16–256 px) and `bugdesk-256.png` (Linux) are
rendered from the SVGs beside them: `bugdesk-glyph.svg` for 16–32 px,
`bugdesk-icon-detailed.svg` above that. They were rendered with headless Edge
(`--default-background-color=00000000` keeps the corners transparent) and packed
with Pillow; re-render them the same way if the SVGs change.

## The native bridge

The page talks to the window over Photino's web messages as JSON:
`{id, cap, op, args}` in, `{id, ok, value | error}` out. FlexDesk's
`createPhotinoHost` (`@flexdesk/host`, FlexDesk 0.14.0) is the page's side, and
its `photino_host.md` is the contract `desktop/BugDesk.Desktop/NativeBridge.cs`
answers:

- `window`: minimize, close, isMaximized, setMaximized, isFullscreen,
  toggleFullscreen, getBounds, setBounds. `chrome()` is `native`, so FlexDesk
  draws no window buttons of its own.
- `dialogs.saveFile`: the native Save dialog, then the write (text for csv,
  base64 bytes for png). Photino's dialog starts in a folder (Documents) and
  cannot suggest a file name, so the name is in its title, and the extension is
  added when the one typed has none. Cancelling answers `{ok:false,
  cancelled:true}`, and the page says nothing.
- `state` is not offered. `ui/js/tiling/install.js` keeps the server's adapter
  for it, so layouts and table state stay per user on the server, as in a tab.

`install.js` picks the Photino host only when `isPhotinoWindow()` is true; in a
browser tab nothing changes.

**The window's place** (`WindowPlacement.cs`) is kept in `window.json` in the
app's folder: the normal bounds, followed as the window moves, and whether it was
maximised. A window whose title bar would be on no monitor's work area opens
centred. Photino needs `UseOsDefaultSize`/`UseOsDefaultLocation` switched off
before it uses a size or place, and a minimum set before the window exists makes
it open at that minimum. So the minimum is set once the window is created.
