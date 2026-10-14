// What the page can ask of the window, over Photino's web messages:
// `{id, cap, op, args}` in, `{id, ok, value | error}` out. FlexDesk's Photino
// host adapter (`createPhotinoHost`, @flexdesk/host) is the other end; its
// photino_host.md is the contract this answers. `state` is not offered: BugDesk
// keeps the page's state on its server, per user, as it does in a browser tab.

using System.Drawing;
using System.Text;
using System.Text.Json;
using Photino.NET;

static class NativeBridge
{
    public static void Attach(PhotinoWindow window) =>
        window.RegisterWebMessageReceivedHandler((sender, message) =>
        {
            var w = (PhotinoWindow)sender!;
            JsonDocument doc;
            try { doc = JsonDocument.Parse(message); }
            catch (JsonException) { return; }           // not ours
            using (doc)
            {
                var req = doc.RootElement;
                if (req.ValueKind != JsonValueKind.Object || !req.TryGetProperty("id", out var id)) return;
                string reply;
                try { reply = Reply(id, true, "value", Handle(w, req)); }
                catch (Exception ex) { reply = Reply(id, false, "error", ex.Message); }
                w.SendWebMessage(reply);
            }
        });

    static string Reply(JsonElement id, bool ok, string key, object? payload) =>
        $"{{\"id\":{id.GetRawText()},\"ok\":{(ok ? "true" : "false")},\"{key}\":{JsonSerializer.Serialize(payload)}}}";

    static object? Handle(PhotinoWindow w, JsonElement req)
    {
        var cap = req.TryGetProperty("cap", out var c) ? c.GetString() : "";
        var op = req.TryGetProperty("op", out var o) ? o.GetString() : "";
        var args = req.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Array ? a : default;
        JsonElement Arg(int i) => args.ValueKind == JsonValueKind.Array && args.GetArrayLength() > i ? args[i] : default;

        switch (cap, op)
        {
            case ("host", "describe"):
                return new { host = "photino", version = typeof(PhotinoWindow).Assembly.GetName().Version?.ToString(), capabilities = new[] { "window", "dialogs" } };
            case ("window", "minimize"): w.SetMinimized(true); return null;
            case ("window", "close"): w.Close(); return null;
            case ("window", "isMaximized"): return w.Maximized;
            case ("window", "setMaximized"): w.SetMaximized(Arg(0).ValueKind == JsonValueKind.True); return w.Maximized;
            case ("window", "isFullscreen"): return w.FullScreen;
            case ("window", "toggleFullscreen"): w.SetFullScreen(!w.FullScreen); return w.FullScreen;
            case ("window", "getBounds"): return new { x = w.Left, y = w.Top, width = w.Width, height = w.Height };
            case ("window", "setBounds"):
            {
                var b = Arg(0);
                int? Num(string k) => b.ValueKind == JsonValueKind.Object && b.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : null;
                if (Num("x") is not null || Num("y") is not null) w.SetLocation(new Point(Num("x") ?? w.Left, Num("y") ?? w.Top));
                if (Num("width") is not null || Num("height") is not null) w.SetSize(new Size(Num("width") ?? w.Width, Num("height") ?? w.Height));
                return null;
            }
            case ("dialogs", "saveFile"): return SaveFile(w, Arg(0));
            default: throw new InvalidOperationException($"unknown request {cap}.{op}");
        }
    }

    /// <summary>
    /// The native Save As dialog, then the write. <c>data</c> is the file's text
    /// for csv and its bytes, base64, for png. Cancelling is not an error: the
    /// page says nothing and downloads nothing.
    /// </summary>
    static object SaveFile(PhotinoWindow w, JsonElement opts)
    {
        string Str(string k) => opts.ValueKind == JsonValueKind.Object && opts.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        var kind = Str("kind").ToLowerInvariant();
        var filename = Path.GetFileName(Str("filename")) is { Length: > 0 } f ? f : $"export.{(kind.Length > 0 ? kind : "txt")}";
        var filters = kind switch
        {
            "csv" => new[] { ("CSV", new[] { "*.csv" }), ("All files", new[] { "*.*" }) },
            "png" => new[] { ("PNG image", new[] { "*.png" }), ("All files", new[] { "*.*" }) },
            _ => new[] { ("All files", new[] { "*.*" }) },
        };
        // Photino's dialog takes a folder to start in, not a file name, so the
        // suggested name goes in its title, and the extension is added when the
        // name typed has none.
        var folder = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        var path = w.ShowSaveFile($"Save {filename}", folder, filters);
        if (string.IsNullOrEmpty(path)) return new { ok = false, cancelled = true };
        if (Path.GetExtension(path).Length == 0 && kind.Length > 0) path += "." + kind;
        try
        {
            if (kind == "png") File.WriteAllBytes(path, Convert.FromBase64String(Str("data")));
            else File.WriteAllText(path, Str("data"), new UTF8Encoding(false));
            return new { ok = true, path };
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FormatException)
        {
            return new { ok = false, error = ex.Message };
        }
    }
}
