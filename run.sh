#!/usr/bin/env bash
# BugDesk — local bug tracker UI + bridge over a directory of markdown bug files
#
#   ./run.sh                          # serve on http://127.0.0.1:8766, bugs in ./bugs
#   ./run.sh --seed                   # + pre-seed an empty bug store with 10 example bugs
#   ASPNETCORE_URLS=http://127.0.0.1:9000 ./run.sh
#   BUGDESK_BUGS=/path/to/bugs ./run.sh
#   BUGDESK_HUMAN=alice BUGDESK_AGENT=claude ./run.sh
#
# The bridge serves the FlexDesk UI (ui/) AND the JSON API, and reads/writes the
# markdown bug files. Open the printed URL in a browser.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"

# Same resolution order as the server's own ResolveBugsDir (Program.cs):
# BUGDESK_BUGS if set, else <repo root>/bugs.
bugs_dir="${BUGDESK_BUGS:-$root/bugs}"

seed=0
args=()
for a in "$@"; do
    if [ "$a" = "--seed" ]; then seed=1; else args+=("$a"); fi
done

if [ "$seed" = "1" ]; then
    shopt -s nullglob
    existing=("$bugs_dir"/BUG-*.md)
    shopt -u nullglob
    if [ "${#existing[@]}" -gt 0 ]; then
        echo "BugDesk: $bugs_dir already has ${#existing[@]} bug(s) — skipping --seed (won't overwrite)."
    else
        mkdir -p "$bugs_dir"
        cp "$root/examples/bugs/"BUG-*.md "$bugs_dir/"
        echo "BugDesk: seeded $bugs_dir with 10 example bugs."
    fi
fi

cd "$root/server"
export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://127.0.0.1:8766}"
echo "BugDesk → ${ASPNETCORE_URLS}   (bugs: ${BUGDESK_BUGS:-./bugs})"
exec dotnet run "${args[@]}"
