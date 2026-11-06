#!/usr/bin/env bash
# Tests the parts of offline reading that don't need a phone: the Shelf and the Syncer.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -n "${JAVA_HOME:-}" ] && export PATH="$JAVA_HOME/bin:$PATH"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
P=com/ieatfood314/exosphere
javac -Xlint:-options -encoding UTF-8 -d "$OUT" "$HERE/src/$P/Shelf.java" "$HERE/src/$P/Syncer.java" "$HERE/test/$P/OfflineCheck.java"
java -cp "$OUT" com.ieatfood314.exosphere.OfflineCheck
