// BugDesk.Desktop — STORY-0009 spike.
//
// BugDesk in a native window: the bridge (server/Program.cs) runs IN THIS
// PROCESS on a free loopback port, and a Photino.NET window shows its page —
// the layout SixShare.Desktop uses (../SixShare/SixShare.Desktop/Program.cs),
// cut to what a spike needs. Closing the window ends the process, and the
// server's ApplicationStopping path flushes the record caches on the way.
//
// The native bridge — what the page can ask of the window (maximise, a native
// save dialog, its own window state) — goes over Photino's web messages as
// JSON, the shape FlexDesk's host port would wrap. This prototype answers two
// messages to prove the round trip; the design is in docs/desktop-spike.md.

using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text.Json;
using Photino.NET;

static class Desktop
{
    [STAThread]
    static void Main(string[] args)
    {
        var port = FreePort();
        var url = $"http://127.0.0.1:{port}/";
        Environment.SetEnvironmentVariable("ASPNETCORE_URLS", url.TrimEnd('/'));

        // The bridge's own entry point, on a thread of its own: top-level
        // statements compile to a Main this process can call. In-process means
        // one executable to ship and one process to end.
        // By name: the server's types are internal, only its entry point is ours to call.
        var server = Assembly.Load("BugDesk.Server");
        var entry = server.EntryPoint ?? throw new InvalidOperationException("the BugDesk server has no entry point");
        var serverThread = new Thread(() =>
        {
            try { entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { args }); }
            catch (TargetInvocationException ex) { Console.Error.WriteLine($"BugDesk server stopped: {ex.InnerException?.Message}"); }
        }) { IsBackground = true, Name = "BugDesk server" };
        serverThread.Start();
        WaitForServer(url, TimeSpan.FromSeconds(20));

        var window = new PhotinoWindow()
            .SetTitle("BugDesk")
            .SetSize(1400, 900)
            .SetMinSize(900, 600)
            .Center()
            .SetResizable(true)
            .SetDevToolsEnabled(Environment.GetEnvironmentVariable("BUGDESK_DESKTOP_DEVTOOLS") == "1");
        var icon = FindIcon();
        if (icon is not null) window.SetIconFile(icon);
        // A test run (or a launch from a script) can start it out of the way.
        if (Environment.GetEnvironmentVariable("BUGDESK_DESKTOP_MINIMIZED") == "1") window.SetMinimized(true);

        window.RegisterWebMessageReceivedHandler((sender, message) =>
        {
            var w = (PhotinoWindow)sender!;
            string reply;
            try { reply = Handle(w, message); }
            catch (Exception ex) { reply = JsonSerializer.Serialize(new { ok = false, error = ex.Message }); }
            w.SendWebMessage(reply);
        });

        window.Load(url);
        window.WaitForClose();
        Environment.Exit(0);
    }

    /// <summary>
    /// One request from the page, one reply: `{id, cap, op, args}` →
    /// `{id, ok, value | error}`. The spike answers `window.isMaximized`,
    /// `window.setMaximized` and `host.describe`; the full catalogue is in
    /// docs/desktop-spike.md.
    /// </summary>
    static string Handle(PhotinoWindow w, string message)
    {
        using var doc = JsonDocument.Parse(message);
        var root = doc.RootElement;
        var id = root.TryGetProperty("id", out var i) ? i.GetRawText() : "null";
        var cap = root.TryGetProperty("cap", out var c) ? c.GetString() : "";
        var op = root.TryGetProperty("op", out var o) ? o.GetString() : "";
        object? value = (cap, op) switch
        {
            ("host", "describe") => new { host = "photino", version = typeof(PhotinoWindow).Assembly.GetName().Version?.ToString(), capabilities = new[] { "window" } },
            ("window", "isMaximized") => w.Maximized,
            ("window", "setMaximized") => (object)(w.Maximized = root.GetProperty("args")[0].GetBoolean()),
            _ => throw new InvalidOperationException($"unknown request {cap}.{op}"),
        };
        return $"{{\"id\":{id},\"ok\":true,\"value\":{JsonSerializer.Serialize(value)}}}";
    }

    static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    static void WaitForServer(string url, TimeSpan limit)
    {
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(2) };
        var until = DateTime.UtcNow + limit;
        while (DateTime.UtcNow < until)
        {
            try { if ((int)http.GetAsync(url).GetAwaiter().GetResult().StatusCode < 500) return; }
            catch (Exception) { /* not up yet */ }
            Thread.Sleep(150);
        }
        throw new TimeoutException($"the BugDesk server did not answer on {url}");
    }

    static string? FindIcon()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var hops = 0; dir is not null && hops < 8; hops++, dir = dir.Parent)
        {
            // Windows wants an .ico (a PNG on Linux); BugDesk ships only an SVG
            // glyph so far — a finding of the spike.
            foreach (var name in new[] { "ui/assets/icons/bugdesk.ico", "ui/assets/icons/bugdesk.png" })
            {
                var p = Path.Combine(dir.FullName, name);
                if (File.Exists(p)) return p;
            }
        }
        return null;
    }
}
