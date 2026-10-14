// The Windows shell fixes SixShare.Desktop needed too (its Program.cs): an
// explicit AppUserModelID, so the window, its taskbar button and a pinned
// shortcut group as one app; the window's own icon set on its handle, because
// the taskbar takes it from there and Photino sets only the small one; and
// handing the foreground to the running window when a second launch asks.

using System.Runtime.InteropServices;
using System.Runtime.Versioning;

[SupportedOSPlatform("windows")]
static partial class WindowsShell
{
    /// <summary>The app's identity in the taskbar. The installer's shortcut carries the same one.</summary>
    public const string AppUserModelId = "BugDesk.Desktop";

    public static void SetAppUserModelId() => SetCurrentProcessExplicitAppUserModelID(AppUserModelId);

    public static void SetWindowIcon(nint hwnd, string icoPath)
    {
        if (hwnd == 0) return;
        var small = LoadImage(0, icoPath, IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_LOADFROMFILE);
        var big = LoadImage(0, icoPath, IMAGE_ICON, GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), LR_LOADFROMFILE);
        if (small != 0) SendMessage(hwnd, WM_SETICON, ICON_SMALL, small);
        if (big != 0) SendMessage(hwnd, WM_SETICON, ICON_BIG, big);
    }

    public static void Foreground(nint hwnd)
    {
        if (hwnd == 0) return;
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
        SetForegroundWindow(hwnd);
    }

    public static void AllowAnyForeground() => AllowSetForegroundWindow(ASFW_ANY);

    public static void MessageBox(string title, string text) => MessageBoxW(0, text, title, MB_ICONERROR);

    const uint IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10, WM_SETICON = 0x0080, MB_ICONERROR = 0x10;
    const int SM_CXICON = 11, SM_CYICON = 12, SM_CXSMICON = 49, SM_CYSMICON = 50, SW_RESTORE = 9, ASFW_ANY = -1;
    const nint ICON_SMALL = 0, ICON_BIG = 1;

    [LibraryImport("shell32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int SetCurrentProcessExplicitAppUserModelID(string appId);
    [LibraryImport("user32.dll", EntryPoint = "LoadImageW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint LoadImage(nint hInst, string name, uint type, int cx, int cy, uint load);
    [LibraryImport("user32.dll", EntryPoint = "SendMessageW")]
    private static partial nint SendMessage(nint hwnd, uint msg, nint wParam, nint lParam);
    [LibraryImport("user32.dll")]
    private static partial int GetSystemMetrics(int index);
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsIconic(nint hwnd);
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool ShowWindow(nint hwnd, int cmd);
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetForegroundWindow(nint hwnd);
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AllowSetForegroundWindow(int processId);
    [LibraryImport("user32.dll", EntryPoint = "MessageBoxW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int MessageBoxW(nint hwnd, string text, string caption, uint type);
}
