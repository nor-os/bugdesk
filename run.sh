#!/usr/bin/env bash
# BugDesk — local bug tracker UI + bridge over a directory of markdown bug files
#
# Run `./run.sh --help` for the full usage; it is printed from one place below
# rather than kept in step with a copy in this header.
#
# The bridge serves the FlexDesk UI (ui/) AND the JSON API, and reads/writes the
# markdown files in both stores. Open the printed URL in a browser; the first
# run asks who you are and remembers it in a git-ignored .bugdesk/ beside the
# stores.
set -euo pipefail
# In tracker mode the directory you started from is what NAMES the tracker (see
# ResolveTrackerProject in Program.cs), so it is captured explicitly rather than
# left for the server to infer from its own working directory.
export BUGDESK_INVOKED_FROM="${BUGDESK_INVOKED_FROM:-$PWD}"
root="$(cd "$(dirname "$0")" && pwd)"

usage() {
    cat <<'__BUGDESK_HELP__'
BugDesk — a local UI and JSON bridge over a directory of markdown records.

USAGE
  ./run.sh [options]

OPTIONS
  --help, -h        Show this and exit.
  --seed            Copy the bundled examples into any store that is still
                    empty. Never overwrites: a store that already holds records
                    is skipped, and the two stores are considered separately.
  --tracker         Tracker mode — follow up work you handed to other people.
                    Its records live under ~/.bugdesk/<project>/, NOT in this
                    repo, and the port is chosen automatically.
  --project=NAME    Tracker mode only: which tracker to open. Defaults to the
                    name of the directory you ran this from.

WHERE THE RECORDS LIVE
  By default: ./bugs and ./backlog beside this script. Point them somewhere
  else with a flag or the matching variable — the server reads both, so the UI
  and an agent editing the files always agree.

    --bugs-dir DIR, --bugs-dir=DIR, BUGDESK_BUGS=DIR
        The bug store. The backlog defaults to a SIBLING of whatever you set
        here, so this one setting moves both stores together — which is what
        you want when BugDesk is tracking a different repo than it lives in.

    --backlog-dir DIR, --backlog-dir=DIR, BUGDESK_BACKLOG=DIR
        The backlog store, when it is not beside the bug store.

  Set both to place them independently. The FLAG WINS over the variable: it is
  typed for this one run, while a variable may have been exported into your
  shell hours ago and forgotten.

  The directories are created on demand, and both paths are printed at startup
  — check that line if you are not seeing the records you expected.

OTHER ENVIRONMENT VARIABLES
  ASPNETCORE_URLS   Where to listen. Default http://127.0.0.1:8766.
  BUGDESK_CONFIG    Where profiles and filters live. Default .bugdesk/ beside
                    the stores; it is git-ignored and per-person.
  BUGDESK_USER      Pick a profile by name and skip the first-run prompt.
  BUGDESK_HUMAN     Seed the two names on a store that has no profile yet.
  BUGDESK_AGENT     Ignored once a profile exists — the profile wins.
  BUGDESK_MODE      bugs (default) or tracker; --tracker is the same thing.

YOUR WORKING DIRECTORY
  This script does not change it. It used to cd into server/ before starting
  the bridge; it now passes that path to `dotnet run --project` instead, so the
  shell you started from is the shell you come back to when you stop the server
  with Ctrl+C. That also matters in tracker mode, where the directory you ran
  from is what names the tracker.

EXAMPLES
  ./run.sh                                   # this repo's own stores
  ./run.sh --seed                            # and fill them if they are empty
  ./run.sh --bugs-dir ~/work/acme/bugs       # track another repo, backlog follows
  ./run.sh --bugs-dir ~/acme/bugs --backlog-dir ~/plans/backlog
  BUGDESK_BUGS=~/work/acme/bugs ./run.sh     # the same, as a variable
  ASPNETCORE_URLS=http://127.0.0.1:9000 ./run.sh
  cd ~/work/acme && ~/bugdesk/run.sh --tracker
__BUGDESK_HELP__
}

for a in "$@"; do
    case "$a" in
        --help|-h) usage; exit 0 ;;
    esac
done

# --tracker is consumed HERE and re-exported as BUGDESK_MODE rather than being
# forwarded: `dotnet run` treats an unrecognised leading flag as its own and
# would reject it before the app ever saw it. The server accepts the flag too,
# for anyone running `dotnet run -- --tracker` directly.
#
# Everything in `args` goes after a literal `--` at the bottom, which is what
# makes forwarding safe: `--project=NAME` is BugDesk's tracker name, but it is
# also `dotnet run`'s own option for a project file. Without the separator the
# CLI swallowed it and answered "The provided file path does not exist", and the
# tracker quietly fell back to naming itself after the current directory.
seed=0
args=()
want_value=""
for a in "$@"; do
    # The token after a space-form `--bugs-dir` / `--backlog-dir` is its value,
    # not a flag of its own.
    if [ -n "$want_value" ]; then
        case "$want_value" in
            --bugs-dir) BUGDESK_BUGS="$a" ;;
            --backlog-dir) BUGDESK_BACKLOG="$a" ;;
        esac
        want_value=""
        continue
    fi
    case "$a" in
        --seed) seed=1 ;;
        --tracker) BUGDESK_MODE=tracker ;;
        --mode=*) BUGDESK_MODE="${a#--mode=}" ;;
        # Consumed, not forwarded: exported as the variable the server already
        # reads, so the flag and the variable cannot disagree, and so the seeding
        # and the startup line below see the same directories the server will.
        --bugs-dir=*) BUGDESK_BUGS="${a#--bugs-dir=}" ;;
        --bugs-dir) want_value="--bugs-dir" ;;
        --backlog-dir=*) BUGDESK_BACKLOG="${a#--backlog-dir=}" ;;
        --backlog-dir) want_value="--backlog-dir" ;;
        # Forwarded, not consumed: the server reads it (ResolveTrackerProject).
        --project=*) args+=("$a") ;;
        *) args+=("$a") ;;
    esac
done
if [ -n "$want_value" ]; then
    echo "BugDesk: $want_value needs a directory after it. See ./run.sh --help." >&2
    exit 2
fi
export BUGDESK_MODE="${BUGDESK_MODE:-bugs}"
# Exported only when actually set, so an unset variable still means "the
# default" to the server rather than an empty path it would have to special-case.
if [ -n "${BUGDESK_BUGS:-}" ]; then export BUGDESK_BUGS; fi
if [ -n "${BUGDESK_BACKLOG:-}" ]; then export BUGDESK_BACKLOG; fi

# Resolved AFTER the flags above, which feed the same two variables. Same order
# as the server's own ResolveBugsDir / ResolveBacklogDir (Program.cs): the flag,
# then the variable, else <repo root>/bugs and its sibling backlog/ — which is
# why the backlog default is derived from the bug dir rather than from $root, so
# --bugs-dir alone moves both stores together.
bugs_dir="${BUGDESK_BUGS:-$root/bugs}"
backlog_dir="${BUGDESK_BACKLOG:-$(dirname "$bugs_dir")/backlog}"

# Seed each store INDEPENDENTLY: a repo that already tracks bugs but has no
# backlog yet is the normal way into this feature, and refusing to seed the
# backlog because bugs already exist would be the wrong answer for exactly
# that case.
#
# $1 target dir, $2 glob identifying "already seeded", $3 source dir, $4 noun.
seed_store() {
    local dir="$1" glob="$2" src="$3" what="$4"
    shopt -s nullglob
    local existing=("$dir"/$glob)
    local incoming=("$src"/*.md)
    shopt -u nullglob
    if [ "${#existing[@]}" -gt 0 ]; then
        echo "BugDesk: $dir already has ${#existing[@]} $what — skipping --seed (won't overwrite)."
        return
    fi
    if [ "${#incoming[@]}" -eq 0 ]; then
        echo "BugDesk: no examples in $src — nothing to seed into $dir."
        return
    fi
    mkdir -p "$dir"
    cp "${incoming[@]}" "$dir/"
    echo "BugDesk: seeded $dir with ${#incoming[@]} example $what."
}

# A TRACKER does not live in the repo at all — its records go under the user's
# own BugDesk directory, one folder per project (see ResolveTrackerBase in
# Program.cs). So the paths computed above are simply not its business, and
# neither is a fixed port: the server takes the next free one, because a tracker
# is usually opened alongside a BugDesk already running on a repo.
if [ "$BUGDESK_MODE" = "tracker" ]; then
    if [ "$seed" = "1" ]; then
        # The server owns the tracker's paths, so ask it where they are rather
        # than recomputing them here and getting to disagree.
        echo "BugDesk: --seed is applied by the server in tracker mode; see the URL it prints."
        export BUGDESK_SEED_TRACKER=1
    fi
    echo "BugDesk → tracker mode (the URL is printed below; the port is picked automatically)"
    exec dotnet run --project "$root/server" -- "${args[@]}"
fi

# Seed each store INDEPENDENTLY — see seed_store above.
if [ "$seed" = "1" ]; then
    seed_store "$bugs_dir"    'BUG-*.md'    "$root/examples/bugs"    "bug(s)"
    seed_store "$backlog_dir" '*-[0-9]*.md' "$root/examples/backlog" "backlog item(s)"
fi

export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://127.0.0.1:8766}"
echo "BugDesk → ${ASPNETCORE_URLS}   (mode: ${BUGDESK_MODE}, bugs: ${bugs_dir}, backlog: ${backlog_dir})"
exec dotnet run --project "$root/server" -- "${args[@]}"
