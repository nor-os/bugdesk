// What the desktop app keeps in its folder (DeskKit's AppHome: %AppData%\BugDesk
// on Windows, ~/.config/BugDesk on Linux, BUGDESK_DESKTOP_HOME for a test run that
// must not touch the real one). The server reads the same environment variables
// it always has (BUGDESK_PROJECTS, BUGDESK_STATE), pointed here before it
// starts — unless they are set already, which is how a test run or a second,
// separate set of projects gets its own.

using DeskKit.Desktop;

sealed record AppData(string ProjectsFile, bool FirstRun)
{
    public static AppData Prepare(DesktopOptions options)
    {
        var root = AppHome.Resolve(options).Root;

        var projects = Path.GetFullPath(options.Env("PROJECTS") ?? Path.Combine(root, "projects.toml"));
        var state = Path.GetFullPath(options.Env("STATE") ?? Path.Combine(root, "state"));
        Environment.SetEnvironmentVariable("BUGDESK_PROJECTS", projects);
        Environment.SetEnvironmentVariable("BUGDESK_STATE", state);
        Directory.CreateDirectory(state);

        // A missing projects.toml is seeded by the server with a project in the
        // folder it was started from — right for `./run.sh` in a checkout, wrong
        // for an app started from the Start menu, whose folder is its install
        // folder. So the desktop app writes it first, with no projects in it,
        // and asks for the first one itself (Desktop.ChooseFirstProject). A store
        // named explicitly (BUGDESK_BUGS / BUGDESK_BACKLOG) is left to the server.
        var firstRun = false;
        if (!File.Exists(projects) && options.Env("BUGS") is null && options.Env("BACKLOG") is null)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(projects)!);
            File.WriteAllText(projects, """
                # BugDesk projects — which stores this BugDesk serves, and where the global
                # tracker lives. Edit freely: BugDesk re-reads this file whenever it changes.
                # Written by the desktop app; projects are added from inside BugDesk.

                """.Replace("\r\n", "\n"));
            firstRun = true;
        }
        // An empty file left by a first run that was cancelled asks again.
        else if (File.Exists(projects) && !File.ReadAllText(projects).Contains("[projects.", StringComparison.Ordinal)
                 && options.Env("BUGS") is null && options.Env("BACKLOG") is null)
            firstRun = true;

        return new AppData(projects, firstRun);
    }
}
