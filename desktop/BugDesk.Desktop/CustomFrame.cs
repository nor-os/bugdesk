// The desktop window's custom frame (STORY-0042): frameless, but keeping what
// the native frame gives. Windows only; BUGDESK_DESKTOP_FRAME=native turns it off.
//
// The window keeps WS_CAPTION | WS_THICKFRAME, so Windows still treats it as a
// normal top-level window: Aero Snap, Win+arrows, the shadow, Windows 11's
// rounded corners, the minimise/restore animations. WM_NCCALCSIZE returns the
// whole window as client area, so the title bar and borders are not drawn and
// the page reaches the window's top edge.
//
// The WebView2 child covers the client area, so the window itself never sees the
// mouse. Drags and resizes start in the page: it asks for `startDrag` (or
// `startResize` with an edge), and this hands the gesture to Windows with
// WM_NCLBUTTONDOWN, exactly as a click on a real caption or border would. The
// OS runs its own move or size loop from there, which is what brings snapping
// and a resize that keeps up with the pointer.

using System.Runtime.InteropServices;
using System.Runtime.Versioning;

[SupportedOSPlatform("windows")]
static partial class CustomFrame
{
    // The page-side gesture, handed to the window's own thread: ReleaseCapture
    // only works on the thread that holds the capture.
    const uint WM_APP_GESTURE = 0x8001;

    static SubclassProc? _proc;   // kept alive: the window holds a pointer to it
    static nint _hwnd;

    public static void Install(nint hwnd)
    {
        _hwnd = hwnd;
        _proc = WndProc;
        SetWindowSubclass(hwnd, Marshal.GetFunctionPointerForDelegate(_proc), 42, 0);
        var style = GetWindowLongPtr(hwnd, GWL_STYLE);
        SetWindowLongPtr(hwnd, GWL_STYLE, style | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU);
        // A one-pixel frame extension keeps DWM drawing the window's shadow with
        // no non-client area left.
        var margins = new MARGINS { Top = 1 };
        DwmExtendFrameIntoClientArea(hwnd, ref margins);
        var round = DWMWCP_ROUND;
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref round, sizeof(int));
        SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }

    /// <summary>
    /// Hand a drag (HTCAPTION) or a resize (HTLEFT … HTBOTTOMRIGHT) to Windows.
    /// Blocks until the OS loop ends, on mouse-up, so the caller learns the result.
    /// </summary>
    public static void Gesture(int hit) => SendMessage(_hwnd, WM_APP_GESTURE, hit, 0);

    /// <summary>A drag of the whole window, as a press on its caption.</summary>
    public const int Drag = HTCAPTION;

    /// <summary>The border an edge name stands for (n, s, e, w, ne, nw, se, sw); null for anything else.</summary>
    public static int? Edge(string? edge) => edge switch
    {
        "n" => HTTOP, "s" => HTBOTTOM, "e" => HTRIGHT, "w" => HTLEFT,
        "ne" => HTTOPRIGHT, "nw" => HTTOPLEFT, "se" => HTBOTTOMRIGHT, "sw" => HTBOTTOMLEFT,
        _ => null,
    };

    static nint WndProc(nint h, uint msg, nint wp, nint lp, nuint id, nuint data)
    {
        switch (msg)
        {
            case WM_NCCALCSIZE when wp != 0:
                // Maximised, Windows makes the window larger than the monitor by
                // the frame's thickness on every side; clamp the client area to the
                // work area so nothing is cut off and the taskbar stays visible.
                if (IsZoomed(h))
                {
                    var p = Marshal.PtrToStructure<RECT>(lp);
                    var mon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
                    var mi = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
                    if (GetMonitorInfo(mon, ref mi)) p = mi.rcWork;
                    Marshal.StructureToPtr(p, lp, false);
                }
                return 0;
            case WM_NCACTIVATE:
                // Don't let Windows repaint a caption that isn't there.
                return DefSubclassProc(h, msg, wp, -1);
            case WM_APP_GESTURE:
                ReleaseCapture();
                GetCursorPos(out var pt);
                SendMessage(h, WM_NCLBUTTONDOWN, wp, (pt.Y << 16) | (pt.X & 0xFFFF));
                return 0;
        }
        return DefSubclassProc(h, msg, wp, lp);
    }

    delegate nint SubclassProc(nint h, uint msg, nint wp, nint lp, nuint id, nuint data);

    const int GWL_STYLE = -16;
    const nint WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000, WS_MINIMIZEBOX = 0x00020000, WS_MAXIMIZEBOX = 0x00010000, WS_SYSMENU = 0x00080000;
    const uint WM_NCCALCSIZE = 0x0083, WM_NCACTIVATE = 0x0086, WM_NCLBUTTONDOWN = 0x00A1;
    const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20;
    const int HTCAPTION = 2, HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;
    const uint MONITOR_DEFAULTTONEAREST = 2;
    const int DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2;

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MARGINS { public int Left, Right, Top, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }

    [LibraryImport("comctl32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetWindowSubclass(nint hwnd, nint proc, nuint id, nuint data);
    [LibraryImport("comctl32.dll")]
    private static partial nint DefSubclassProc(nint hwnd, uint msg, nint wp, nint lp);
    [LibraryImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static partial nint GetWindowLongPtr(nint hwnd, int index);
    [LibraryImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static partial nint SetWindowLongPtr(nint hwnd, int index, nint value);
    [LibraryImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetWindowPos(nint hwnd, nint after, int x, int y, int cx, int cy, uint flags);
    [LibraryImport("user32.dll", EntryPoint = "SendMessageW")]
    private static partial nint SendMessage(nint hwnd, uint msg, nint wp, nint lp);
    [LibraryImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool ReleaseCapture();
    [LibraryImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetCursorPos(out POINT pt);
    [LibraryImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsZoomed(nint hwnd);
    [LibraryImport("user32.dll")]
    private static partial nint MonitorFromWindow(nint hwnd, uint flags);
    [LibraryImport("user32.dll", EntryPoint = "GetMonitorInfoW")] [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetMonitorInfo(nint mon, ref MONITORINFO mi);
    [LibraryImport("dwmapi.dll")]
    private static partial int DwmExtendFrameIntoClientArea(nint hwnd, ref MARGINS margins);
    [LibraryImport("dwmapi.dll")]
    private static partial int DwmSetWindowAttribute(nint hwnd, int attr, ref int value, int size);
}
