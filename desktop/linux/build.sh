#!/usr/bin/env bash
# Build BugDesk's Linux desktop app (STORY-0027): a .deb and a .tar.gz.
#
#   desktop/out/bugdesk_<version>_amd64.deb         /opt/bugdesk, `bugdesk` on PATH,
#                                                   a launcher entry and its icon
#   desktop/out/bugdesk-<version>-linux-x64.tar.gz  the same app as a folder; run ./BugDesk
#
# Both are self-contained (the .NET runtime is inside) and carry ui/ beside the
# executable. What they need from the system is WebKitGTK 4.1 and GTK 3, which
# the .deb declares; the bare binary says what to install when they are missing.
#
#   desktop/linux/build.sh [version]      default: package.json's version
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
version="${1:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$repo/package.json" | head -1)}"
out="$repo/desktop/out"
# Built on a Linux file system: dpkg-deb refuses the permissions a Windows
# drive (/mnt/c under WSL) reports.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
echo "BugDesk $version (linux-x64)"

app="$work/app"
dotnet publish "$repo/desktop/BugDesk.Desktop/BugDesk.Desktop.csproj" -c Release -r linux-x64 --self-contained \
    -p:Version="$version" -p:DebugType=none -o "$app" --nologo -v q
# ui/ is served off disk; source maps are for a developer's devtools.
cp -r "$repo/ui" "$app/ui"
find "$app/ui" -name '*.map' -delete
# Everything reads as executable on a Windows drive; set the modes outright.
find "$app" -type d -exec chmod 755 {} +
find "$app" -type f -exec chmod 644 {} +
chmod 755 "$app/BugDesk" "$app/createdump"

mkdir -p "$out"
tarball="$out/bugdesk-$version-linux-x64.tar.gz"
tar -C "$work" --transform "s,^app,bugdesk-$version," --owner=0 --group=0 -czf "$tarball" app

root="$work/deb"
mkdir -p "$root/DEBIAN" "$root/opt" "$root/usr/bin" "$root/usr/share/applications" \
         "$root/usr/share/icons/hicolor/256x256/apps"
cp -r "$app" "$root/opt/bugdesk"
# A wrapper rather than a symlink: the app finds ui/ beside its real path.
printf '#!/bin/sh\nexec /opt/bugdesk/BugDesk "$@"\n' > "$root/usr/bin/bugdesk"
chmod 755 "$root/usr/bin/bugdesk"
install -m 644 "$repo/desktop/linux/bugdesk.desktop" "$root/usr/share/applications/bugdesk.desktop"
install -m 644 "$repo/ui/assets/icons/bugdesk-256.png" "$root/usr/share/icons/hicolor/256x256/apps/bugdesk.png"
cat > "$root/DEBIAN/control" <<CONTROL
Package: bugdesk
Version: $version
Section: devel
Priority: optional
Architecture: amd64
Depends: libwebkit2gtk-4.1-0, libgtk-3-0t64 | libgtk-3-0, libnotify4, libstdc++6, libgcc-s1, zlib1g
Installed-Size: $(du -sk "$root/opt" | cut -f1)
Maintainer: BugDesk <bugdesk@localhost>
Description: Bugs and backlog, kept as markdown files in your repository
 BugDesk in a native window: the server runs inside the app, and the
 window shows its page. Projects are folders of BUG-/STORY-/EPIC-*.md files.
CONTROL
chmod 755 "$root/DEBIAN"
deb="$out/bugdesk_${version}_amd64.deb"
dpkg-deb --root-owner-group --build "$root" "$deb" >/dev/null

echo
ls -sh "$deb" "$tarball" | sed "s,$out/,  ,"
