#!/usr/bin/env bash
# BugDesk — local bug tracker UI + bridge over a directory of markdown bug files
#
#   ./run.sh                          # serve on http://127.0.0.1:8766, stores in ./bugs + ./backlog
#   ./run.sh --seed                   # + pre-seed empty stores with the examples
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
root="$(cd "$(dirname "$0")" && pwd)"

# Same resolution order as the server's own ResolveBugsDir / ResolveBacklogDir
# (Program.cs): the env var if set, else <repo root>/bugs and its sibling
# backlog/ — which is why the backlog default is derived from the bug dir
# rather than from $root, so BUGDESK_BUGS alone moves both stores together.
bugs_dir="${BUGDESK_BUGS:-$root/bugs}"
backlog_dir="${BUGDESK_BACKLOG:-$(dirname "$bugs_dir")/backlog}"

seed=0
args=()
for a in "$@"; do
    if [ "$a" = "--seed" ]; then seed=1; else args+=("$a"); fi
done

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

if [ "$seed" = "1" ]; then
    seed_store "$bugs_dir"    'BUG-*.md'    "$root/examples/bugs"    "bug(s)"
    seed_store "$backlog_dir" '*-[0-9]*.md' "$root/examples/backlog" "backlog item(s)"
fi

cd "$root/server"
export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://127.0.0.1:8766}"
echo "BugDesk → ${ASPNETCORE_URLS}   (bugs: ${bugs_dir}, backlog: ${backlog_dir})"
exec dotnet run "${args[@]}"
