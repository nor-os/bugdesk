// What the page can ask of the window, over Photino's web messages:
// `{id, cap, op, args}` in, `{id, ok, value | error}` out. FlexDesk's Photino
// host adapter is the other end (docs/desktop.md).

using System.Text.Json;
using Photino.NET;

static class NativeBridge
{
    public static void Attach(PhotinoWindow window) =>
        window.RegisterWebMessageReceivedHandler((sender, message) =>
        {
            var w = (PhotinoWindow)sender!;
            string reply;
            try { reply = Handle(w, message); }
            catch (Exception ex) { reply = JsonSerializer.Serialize(new { id = IdOf(message), ok = false, error = ex.Message }); }
            w.SendWebMessage(reply);
        });

    static JsonElement? IdOf(string message)
    {
        try { using var doc = JsonDocument.Parse(message); return doc.RootElement.TryGetProperty("id", out var i) ? i.Clone() : null; }
        catch (JsonException) { return null; }
    }

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
}
