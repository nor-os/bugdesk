#!/usr/bin/env bash
# BugDesk — local bug tracker UI + bridge over a directory of markdown bug files
#
#   ./run.sh                          # serve on http://127.0.0.1:8766, stores in ./bugs + ./backlog
#   ./run.sh --seed                   # + pre-seed empty stores with the examples
#   ./run.sh --tracker                # TRACKER mode: follow-up tracker for work
#                                     #   you have handed to other people
#   BUGDESK_MODE=tracker ./run.sh     # the same, as an environment variable
#   ASPNETCORE_URLS=http://127.0.0.1:9000 ./run.sh
#   BUGDESK_BUGS=/path/to/bugs ./run.sh
#   BUGDESK_BACKLOG=/path/to/backlog ./run.sh
#   BUGDESK_USER=alice ./run.sh       # pick a per-user profile without the prompt
#   BUGDESK_HUMAN=alice BUGDESK_AGENT=claude ./run.sh
#
# The bridge serves the FlexDesk UI (ui/) AND the JSON API, and reads/writes the
# markdown files in both stores. Open the printed URL in a browser; the first
# run asks who you are and remembers it in a git-ignored .bugdesk/ beside the
# stores.
set -euo pipefail
# Captured BEFORE the cd into server/ below: in tracker mode the directory you
# started from names the tracker (see ResolveTrackerProject in Program.cs), and
# by the time the server runs its own working directory is server/.
export BUGDESK_INVOKED_FROM="${BUGDESK_INVOKED_FROM:-$PWD}"
root="$(cd "$(dirname "$0")" && pwd)"

# Same resolution order as the server's own ResolveBugsDir / ResolveBacklogDir
# (Program.cs): the env var if set, else <repo root>/bugs and its sibling
# backlog/ — which is why the backlog default is derived from the bug dir
# rather than from $root, so BUGDESK_BUGS alone moves both stores together.
bugs_dir="${BUGDESK_BUGS:-$root/bugs}"
backlog_dir="${BUGDESK_BACKLOG:-$(dirname "$bugs_dir")/backlog}"

# --tracker is consumed HERE and re-exported as BUGDESK_MODE rather than being
# forwarded: `dotnet run` treats an unrecognised leading flag as its own and
# would reject it before the app ever saw it. The server accepts the flag too,
# for anyone running `dotnet run -- --tracker` directly.
seed=0
args=()
for a in "$@"; do
    case "$a" in
        --seed) seed=1 ;;
        --tracker) BUGDESK_MODE=tracker ;;
        --mode=*) BUGDESK_MODE="${a#--mode=}" ;;
        # Forwarded, not consumed: the server reads it (ResolveTrackerProject).
        --project=*) args+=("$a") ;;
        *) args+=("$a") ;;
    esac
done
export BUGDESK_MODE="${BUGDESK_MODE:-bugs}"

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
    cd "$root/server"
    echo "BugDesk → tracker mode (the URL is printed below; the port is picked automatically)"
    exec dotnet run "${args[@]}"
fi

# Seed each store INDEPENDENTLY — see seed_store above.
if [ "$seed" = "1" ]; then
    seed_store "$bugs_dir"    'BUG-*.md'    "$root/examples/bugs"    "bug(s)"
    seed_store "$backlog_dir" '*-[0-9]*.md' "$root/examples/backlog" "backlog item(s)"
fi

cd "$root/server"
export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://127.0.0.1:8766}"
echo "BugDesk → ${ASPNETCORE_URLS}   (mode: ${BUGDESK_MODE}, bugs: ${bugs_dir}, backlog: ${backlog_dir})"
exec dotnet run "${args[@]}"
