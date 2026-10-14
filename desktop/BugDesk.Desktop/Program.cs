// BugDesk.Desktop — BugDesk in a native window.
//
// The server (server/Program.cs, BugDeskServer.Run) runs IN THIS PROCESS on a
// free loopback port, and a Photino.NET window shows its page — the layout
// SixShare.Desktop uses (../SixShare/SixShare.Desktop/Program.cs). One process
// per user and set of projects: a second launch brings the first window forward
// and exits (SingleInstance). Closing the window stops the server cleanly, so a
// record cache's pending write reaches the disk before the process ends.
//
// What is this app's own lives in the user's app-data folder (AppData.cs): its
// projects.toml, the server's state and WebView2's profile. Nothing is written
// beside the executable, which may be in a folder the user cannot write to.
//
// What the page can ask of the window goes over Photino's web messages as JSON
// (NativeBridge.cs); see docs/desktop.md.

using System.Text;
using Microsoft.AspNetCore.Builder;
using Photino.NET;

static class Desktop
{
    [STAThread]
    static int Main(string[] args)
    {
        var data = AppData.Prepare();
        using var instance = SingleInstance.Acquire(data.ProjectsFile);
        if (instance is null)
        {
            // Another window already serves these projects: bring it forward.
            if (SingleInstance.Activate(data.ProjectsFile)) return 0;
            // It holds the lock but did not answer — still starting, or hung.
            // Starting a second server on the same stores is exactly what the
            // lock is for, so say so rather than doing it.
            Console.Error.WriteLine("BugDesk is already running for these projects, and did not answer.");
            return 1;
        }
        if (OperatingSystem.IsWindows()) WindowsShell.SetAppUserModelId();

        var port = FreePort();
        var url = $"http://127.0.0.1:{port}/";
        Environment.SetEnvironmentVariable("ASPNETCORE_URLS", url.TrimEnd('/'));

        WebApplication? server = null;
        Exception? serverFault = null;
        var serverThread = new Thread(() =>
        {
            try { BugDeskServer.Run(args, app => server = app); }
            catch (Exception ex) { serverFault = ex; }
        }) { IsBackground = true, Name = "BugDesk server" };
        serverThread.Start();
        if (!WaitForServer(url, TimeSpan.FromSeconds(20), () => serverFault is not null || !serverThread.IsAlive))
        {
            Fail($"The BugDesk server did not start.\n\n{serverFault?.Message ?? "It did not answer within 20 seconds."}", data);
            return 1;
        }

        var window = new PhotinoWindow()
            .SetTitle("BugDesk")
            .SetSize(1400, 900)
            .SetMinSize(900, 600)
            .Center()
            .SetResizable(true)
            .SetTemporaryFilesPath(data.WebViewDir)
            .SetDevToolsEnabled(Environment.GetEnvironmentVariable("BUGDESK_DESKTOP_DEVTOOLS") == "1");
        var icon = FindIcon();
        if (icon is not null) window.SetIconFile(icon);
        // A test run (or a launch from a script) can start it out of the way.
        if (Environment.GetEnvironmentVariable("BUGDESK_DESKTOP_MINIMIZED") == "1") window.SetMinimized(true);

        NativeBridge.Attach(window);
        window.RegisterWindowCreatedHandler((_, _) =>
        {
            if (OperatingSystem.IsWindows() && icon is not null) WindowsShell.SetWindowIcon(window.WindowHandle, icon);
            instance.Listen(() => window.Invoke(() => BringForward(window)));
            if (data.FirstRun) new Thread(() => ChooseFirstProject(window, url)) { IsBackground = true }.Start();
        });

        if (data.FirstRun) window.LoadRawString(FirstRunPage);
        else window.Load(url);
        window.WaitForClose();

        // The clean stop: StopAsync ends the live-update streams and runs the
        // server's ApplicationStopped handlers, which flush the record caches;
        // then Run returns and the thread ends. The server's own shutdown timeout
        // is 5 s, so this waits a little longer than that and no more.
        try { server?.StopAsync().Wait(TimeSpan.FromSeconds(6)); }
        catch (Exception ex) { Console.Error.WriteLine($"BugDesk server stop: {ex.Message}"); }
        serverThread.Join(TimeSpan.FromSeconds(2));
        return 0;
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

    static void BringForward(PhotinoWindow window)
    {
        if (window.Minimized) window.SetMinimized(false);
        if (OperatingSystem.IsWindows()) WindowsShell.Foreground(window.WindowHandle);
        else { window.SetTopMost(true); window.SetTopMost(false); }
    }

    static void Fail(string message, AppData data)
    {
        Console.Error.WriteLine(message);
        try { File.AppendAllText(Path.Combine(data.Root, "desktop.log"), $"{DateTime.Now:O} {message}\n"); }
        catch (IOException) { /* nowhere left to say it */ }
        if (OperatingSystem.IsWindows()) WindowsShell.MessageBox("BugDesk", message);
    }

    static int FreePort()
    {
        var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        l.Start();
        var port = ((System.Net.IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    static bool WaitForServer(string url, TimeSpan limit, Func<bool> gaveUp)
    {
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(2) };
        var until = DateTime.UtcNow + limit;
        while (DateTime.UtcNow < until && !gaveUp())
        {
            // Any answer at all means it is listening — "no projects yet" is a 404.
            try { http.GetAsync(url + "api/projects").GetAwaiter().GetResult(); return true; }
            catch (Exception) { /* not up yet */ }
            Thread.Sleep(100);
        }
        return false;
    }

    static string? FindIcon()
    {
        // Windows wants the .ico, Linux a PNG. Beside the executable once
        // packaged (ui/ ships there); up the tree in a checkout.
        var names = OperatingSystem.IsWindows()
            ? new[] { "ui/assets/icons/bugdesk.ico" }
            : new[] { "ui/assets/icons/bugdesk-256.png" };
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var hops = 0; dir is not null && hops < 8; hops++, dir = dir.Parent)
            foreach (var name in names)
                if (Path.Combine(dir.FullName, name) is var p && File.Exists(p)) return p;
        return null;
    }
}
