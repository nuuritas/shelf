#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BUILD="$ANDROID_DIR/build"
KEYSTORE="$ANDROID_DIR/bookmark.keystore"

if [[ -n "${SHARE_TOKEN:-}" ]]; then
  TOKEN="$SHARE_TOKEN"
elif [[ -f "$ROOT/.dev.vars" ]]; then
  TOKEN="$(grep '^SHARE_TOKEN=' "$ROOT/.dev.vars" | cut -d= -f2- || true)"
else
  TOKEN=""
fi

if [[ -n "${KEYSTORE_PASS:-}" ]]; then
  PASS="$KEYSTORE_PASS"
elif [[ -f "$ROOT/.dev.vars" ]]; then
  PASS="$(grep '^KEYSTORE_PASS=' "$ROOT/.dev.vars" | cut -d= -f2- || true)"
else
  PASS=""
fi

if [[ -z "$TOKEN" || -z "$PASS" ]]; then
  echo "SHARE_TOKEN and KEYSTORE_PASS are required (env or .dev.vars)." >&2
  exit 1
fi

BUILD_TOOLS="$(find "$SDK/build-tools" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
PLATFORM_JAR="$(find "$SDK/platforms" -mindepth 2 -maxdepth 2 -name android.jar | sort | tail -1)"

if [[ ! -x "$BUILD_TOOLS/aapt2" || ! -f "$PLATFORM_JAR" ]]; then
  echo "Android SDK build-tools/platform not found under $SDK" >&2
  exit 1
fi

rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/dex" "$BUILD/res"

# The token is injected into a temporary source file, never the tracked source.
sed "s|__SHARE_TOKEN__|$TOKEN|g" \
  "$ANDROID_DIR/src/com/bookmarkvault/share/ShareActivity.java" \
  > "$BUILD/ShareActivity.java"

javac --release 11 \
  -classpath "$PLATFORM_JAR" \
  -d "$BUILD/classes" \
  "$BUILD/ShareActivity.java"

"$BUILD_TOOLS/d8" \
  --min-api 26 \
  --lib "$PLATFORM_JAR" \
  --output "$BUILD/dex" \
  "$BUILD"/classes/com/bookmarkvault/share/*.class

"$BUILD_TOOLS/aapt2" compile \
  --dir "$ANDROID_DIR/res" \
  -o "$BUILD/res.zip"

"$BUILD_TOOLS/aapt2" link \
  -o "$BUILD/unsigned.apk" \
  -I "$PLATFORM_JAR" \
  --manifest "$ANDROID_DIR/AndroidManifest.xml" \
  --min-sdk-version 26 \
  --target-sdk-version 36 \
  --version-code 1 \
  --version-name 1.0 \
  -R "$BUILD/res.zip" \
  --auto-add-overlay

(
  cd "$BUILD"
  cp dex/classes.dex classes.dex
  zip -q unsigned.apk classes.dex
)

if [[ ! -f "$KEYSTORE" ]]; then
  keytool -genkeypair \
    -keystore "$KEYSTORE" \
    -alias bookmark \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storepass "$PASS" \
    -keypass "$PASS" \
    -dname "CN=Bookmark Vault, O=Personal, C=TR" \
    >/dev/null 2>&1
fi

"$BUILD_TOOLS/zipalign" -f 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias bookmark \
  --ks-pass "pass:$PASS" \
  --key-pass "pass:$PASS" \
  --out "$BUILD/BookmarkShare.apk" \
  "$BUILD/aligned.apk"

"$BUILD_TOOLS/apksigner" verify "$BUILD/BookmarkShare.apk"
cp "$BUILD/BookmarkShare.apk" "$ROOT/public/BookmarkShare.apk"

echo "Built $BUILD/BookmarkShare.apk"
ls -lh "$BUILD/BookmarkShare.apk" "$ROOT/public/BookmarkShare.apk"
