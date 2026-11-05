// BugDesk.Desktop — BugDesk in a native window.
//
// The window, the frame, one instance per set of projects and the clean stop are
// DeskKit.Desktop's (desktop/packages, docs/desktop.md). What is left here is
// BugDesk's identity, its files in the app's folder (AppData.cs) and asking for
// the first project.

using System.Text;
using DeskKit.Desktop;
using Microsoft.AspNetCore.Builder;
using Photino.NET;

static class Desktop
{
    [STAThread]
    static int Main(string[] args)
    {
        var options = new DesktopOptions("BugDesk", "BUGDESK", "BugDesk.Desktop")
        {
            WindowsIcon = "ui/assets/icons/bugdesk.ico",
            PngIcon = "ui/assets/icons/bugdesk-256.png",
            // BugDesk keeps the page's state on its server, per user, as it does
            // in a browser tab (ui/js/tiling/install.js).
            NativeState = false,
        };
        var data = AppData.Prepare(options);
        WebApplication? server = null;
        return DesktopApp.Run(options, new DesktopRun
        {
            InstanceKey = data.ProjectsFile,
            RunServer = _ => BugDeskServer.Run(args, app => server = app),
            // StopAsync ends the live-update streams and runs the server's
            // ApplicationStopped handlers, which flush the record caches. The
            // server's own shutdown timeout is 5 s; ServerStopLimit waits 6.
            StopServer = () => server?.StopAsync() ?? Task.CompletedTask,
            StartPage = data.FirstRun ? FirstRunPage : null,
            WindowCreated = w =>
            {
                if (data.FirstRun) new Thread(() => ChooseFirstProject(w.Window, w.Url)) { IsBackground = true }.Start();
            },
        });
    }

    /// <summary>
    /// The very first launch has no projects. Ask for the folder of one — the
    /// repository whose <c>bugs/</c> and <c>backlog/</c> BugDesk should open —
    /// add it through the server's own API, and show it. Cancelling closes the
    /// window: with no project there is nothing to show.
    /// </summary>
    static void ChooseFirstProject(PhotinoWindow window, string url)
    {
        string[]? picked = null;
        window.Invoke(() => picked = window.ShowOpenFolder("Choose the project folder BugDesk should open (the repository with bugs/ and backlog/)"));
        var folder = picked?.FirstOrDefault(p => !string.IsNullOrWhiteSpace(p));
        if (folder is null) { window.Invoke(window.Close); return; }

        folder = Path.GetFullPath(folder).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        // Picking the store itself rather than the repository is an easy slip.
        if (Path.GetFileName(folder) is "bugs" or "backlog") folder = Path.GetDirectoryName(folder)!;
        var name = Path.GetFileName(folder) is { Length: > 0 } n ? n : "project";
        var body = System.Text.Json.JsonSerializer.Serialize(new
        {
            name,
            bugs = Path.Combine(folder, "bugs"),
            backlog = Path.Combine(folder, "backlog"),
        });
        try
        {
            using var http = new HttpClient();
            var resp = http.PostAsync(url + "api/projects", new StringContent(body, Encoding.UTF8, "application/json")).GetAwaiter().GetResult();
            if (!resp.IsSuccessStatusCode)
            {
                var why = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                window.Invoke(() => window.ShowMessage("BugDesk", $"{folder} could not be added:\n\n{why}", PhotinoDialogButtons.Ok, PhotinoDialogIcon.Error));
                ChooseFirstProject(window, url);
                return;
            }
        }
        catch (Exception ex)
        {
            window.Invoke(() => window.ShowMessage("BugDesk", ex.Message, PhotinoDialogButtons.Ok, PhotinoDialogIcon.Error));
            window.Invoke(window.Close);
            return;
        }
        window.Invoke(() => window.Load(url));
    }

    const string FirstRunPage = """
        <!doctype html><meta charset="utf-8"><title>BugDesk</title>
        <body style="font:15px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#334">
        <p>Choose the folder of the project BugDesk should open.</p>
        """;
}
