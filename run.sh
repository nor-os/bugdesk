#!/usr/bin/env bash
# BugDesk — local bug tracker UI + bridge over SharpGenerals/bugs/*.md
#
#   ./run.sh                 # serve on http://127.0.0.1:8766
#   ASPNETCORE_URLS=http://127.0.0.1:9000 ./run.sh
#   BUGDESK_BUGS=/path/to/bugs ./run.sh
#
# The bridge serves the FlexDesk UI (ui/) AND the JSON API, and reads/writes the
# markdown bug files. Open the printed URL in a browser.
set -euo pipefail
cd "$(dirname "$0")/server"
export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://127.0.0.1:8766}"
echo "BugDesk → ${ASPNETCORE_URLS}   (bugs: ${BUGDESK_BUGS:-../../SharpGenerals/bugs})"
exec dotnet run "$@"
