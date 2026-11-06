#!/usr/bin/env bash
# Builds the signed APK with the bare SDK tools (aapt2, javac, d8, apksigner). No Gradle, so
# it takes seconds. Needs ANDROID_HOME (build-tools and a platform) and a JDK 17 on JAVA_HOME
# or PATH. The signing key is made on the first run. Keep it: without it Android refuses
# every later update.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_HOME:?set ANDROID_HOME to the SDK}"
[ -n "${JAVA_HOME:-}" ] && export PATH="$JAVA_HOME/bin:$PATH"
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
PLAT="$SDK/platforms/$(ls "$SDK/platforms" | sort -V | tail -1)/android.jar"
KS="${EXOSPHERE_KEYSTORE:-$HOME/.config/exosphere/android.jks}"
PASSF="${EXOSPHERE_KEYSTORE_PASS_FILE:-$HOME/.config/exosphere/android.pass}"
read -r VNAME VCODE < "$HERE/version"

if [ ! -f "$KS" ]; then
  echo "== first build: creating the release key at $KS"
  mkdir -p "$(dirname "$KS")"
  ( umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > "$PASSF" )
  keytool -genkeypair -keystore "$KS" -storepass:file "$PASSF" -alias exosphere \
    -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=exosphere" >/dev/null
  chmod 600 "$KS"
fi

OUT="$HERE/build"
rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" "$OUT/assets"
# The connect screen wears the site's own styles and fonts.
cp "$HERE"/assets/* "$HERE/../exosphere/static/style.css" "$OUT/assets/"
cp -r "$HERE/../exosphere/static/fonts" "$OUT/assets/"

echo "== resources"
"$BT/aapt2" compile --dir "$HERE/res" -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$PLAT" --manifest "$HERE/AndroidManifest.xml" \
  -A "$OUT/assets" --java "$OUT/gen" --min-sdk-version 30 --target-sdk-version 35 \
  --version-code "$VCODE" --version-name "$VNAME" "$OUT/res.zip"
echo "== java"
find "$HERE/src" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
javac -source 8 -target 8 -bootclasspath "$PLAT:$BT/core-lambda-stubs.jar" -Xlint:-options -encoding UTF-8 \
  -d "$OUT/classes" @"$OUT/sources.txt"
"$BT/d8" --release --min-api 30 --lib "$PLAT" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -j "$OUT/base.apk" classes.dex)
echo "== sign"
"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks "$KS" --ks-pass "file:$PASSF" --ks-key-alias exosphere \
  --out "$OUT/exosphere-$VNAME.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify "$OUT/exosphere-$VNAME.apk"
echo "== built $OUT/exosphere-$VNAME.apk ($VCODE)"
