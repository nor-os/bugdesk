// The window comes back where it was: its size, position and maximised state,
// in window.json in the app's folder. The normal (restored) bounds are tracked
// while the window moves, so a window closed maximised still remembers the size
// it un-maximises to. A position on a monitor that is no longer there (a laptop
// off its dock) is dropped, and the window opens centred instead.

using System.Drawing;
using System.Text.Json;
using Photino.NET;

sealed class WindowPlacement
{
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public bool Maximized { get; set; }

    public static WindowPlacement? Load(string file)
    {
        try
        {
            var p = JsonSerializer.Deserialize<WindowPlacement>(File.ReadAllText(file));
            return p is null || p.Width < 200 || p.Height < 200 ? null : p;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException) { return null; }
    }

    /// <summary>Put the window back, before it is created.</summary>
    public void Apply(PhotinoWindow w)
    {
        w.SetSize(new Size(Width, Height)).SetLocation(new Point(X, Y));
        if (Maximized) w.SetMaximized(true);
    }

    /// <summary>
    /// Once the window knows its monitors: if its title bar is on none of their
    /// work areas, centre it on the primary one rather than leave it out of reach.
    /// </summary>
    public void KeepOnScreen(PhotinoWindow w)
    {
        var titleBar = new Rectangle(X, Y, Width, 40);
        if (w.Monitors.Count == 0 || w.Monitors.Any(m => m.WorkArea.IntersectsWith(titleBar))) return;
        if (w.Maximized) w.SetMaximized(false);
        w.Center();
        if (Maximized) w.SetMaximized(true);
    }

    /// <summary>Follow the window and write where it was when it closes.</summary>
    public static void Track(PhotinoWindow w, string file)
    {
        var p = Load(file) ?? new WindowPlacement();
        void Normal()
        {
            if (w.Maximized || w.Minimized || w.FullScreen) return;
            (p.X, p.Y, p.Width, p.Height) = (w.Left, w.Top, w.Width, w.Height);
        }
        Normal();
        w.RegisterLocationChangedHandler((_, _) => Normal());
        w.RegisterSizeChangedHandler((_, _) => Normal());
        w.RegisterWindowClosingHandler((_, _) =>
        {
            p.Maximized = w.Maximized;
            Normal();
            try { File.WriteAllText(file, JsonSerializer.Serialize(p)); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* next time it opens centred */ }
            return false;                                   // false: let it close
        });
    }
}
