#!/usr/bin/env bash
# Builds the APK and publishes it as a GitHub release, which is where Obtainium looks. Bump
# android/version first: "<name> <code>", with a higher code each time. The commit has to be
# on GitHub already, because the release tags it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
read -r VNAME _ < "$HERE/version"
"$HERE/build.sh"
gh release create "v$VNAME" "$HERE/build/exosphere-$VNAME.apk" \
  --target "$(git -C "$HERE" rev-parse HEAD)" --title "exosphere $VNAME" --generate-notes --latest
