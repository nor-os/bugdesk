// One window per user and set of projects. The first launch takes a named mutex
// and listens on a named pipe; a second launch finds the mutex taken, says
// "activate" down the pipe, and exits — so it never starts a second server on
// the same stores. Both names carry a hash of the projects file, so a test run
// pointed at a scratch projects.toml is a different instance from the real one.

using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;

sealed class SingleInstance : IDisposable
{
    readonly Mutex _mutex;
    readonly string _pipe;
    readonly CancellationTokenSource _stop = new();

    SingleInstance(Mutex mutex, string pipe) { _mutex = mutex; _pipe = pipe; }

    static string Name(string projectsFile)
    {
        var key = OperatingSystem.IsWindows() ? projectsFile.ToLowerInvariant() : projectsFile;
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..16];
        return $"BugDesk.Desktop.{Environment.UserName}.{hash}";
    }

    /// <summary>The lock, or null when another process already holds it.</summary>
    public static SingleInstance? Acquire(string projectsFile)
    {
        var name = Name(projectsFile);
        var mutex = new Mutex(initiallyOwned: true, @"Local\" + name, out var created);
        if (!created)
        {
            // An abandoned mutex (the owner crashed) is ours for the taking.
            try { if (!mutex.WaitOne(0)) { mutex.Dispose(); return null; } }
            catch (AbandonedMutexException) { }
        }
        return new SingleInstance(mutex, name);
    }

    /// <summary>Ask the running instance to come forward. True when it answered.</summary>
    public static bool Activate(string projectsFile)
    {
        // The running window may only take the foreground if we, the process
        // the user just started (and so the foreground one), allow it to.
        if (OperatingSystem.IsWindows()) WindowsShell.AllowAnyForeground();
        try
        {
            using var client = new NamedPipeClientStream(".", Name(projectsFile), PipeDirection.Out);
            client.Connect(3000);
            client.Write("activate\n"u8);
            client.Flush();
            return true;
        }
        catch (Exception ex) when (ex is TimeoutException or IOException) { return false; }
    }

    /// <summary>Call <paramref name="activate"/> whenever a second launch asks.</summary>
    public void Listen(Action activate)
    {
        new Thread(() =>
        {
            while (!_stop.IsCancellationRequested)
            {
                try
                {
                    using var server = new NamedPipeServerStream(_pipe, PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    server.WaitForConnectionAsync(_stop.Token).GetAwaiter().GetResult();
                    using var reader = new StreamReader(server);
                    if (reader.ReadLine() == "activate") activate();
                }
                catch (OperationCanceledException) { return; }
                catch (IOException) { /* a caller that went away — wait for the next */ }
            }
        }) { IsBackground = true, Name = "BugDesk single instance" }.Start();
    }

    public void Dispose()
    {
        _stop.Cancel();
        try { _mutex.ReleaseMutex(); } catch (ApplicationException) { /* not ours on this thread */ }
        _mutex.Dispose();
    }
}
