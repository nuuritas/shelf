#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BUILD="$ANDROID_DIR/build"
KEYSTORE="$ANDROID_DIR/bookmark.keystore"

# Read a value from the environment first, then .dev.vars.
read_setting() {
  local name="$1" value="${!1:-}"
  if [[ -z "$value" && -f "$ROOT/.dev.vars" ]]; then
    value="$(grep "^${name}=" "$ROOT/.dev.vars" | cut -d= -f2- || true)"
  fi
  printf '%s' "$value"
}

PASS="$(read_setting KEYSTORE_PASS)"

if [[ -z "$PASS" ]]; then
  echo "KEYSTORE_PASS is required (environment or .dev.vars) to sign the APK." >&2
  echo "The server URL and password are entered in the app on first launch." >&2
  exit 1
fi

BUILD_TOOLS="$(find "$SDK/build-tools" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
PLATFORM_JAR="$(find "$SDK/platforms" -mindepth 2 -maxdepth 2 -name android.jar | sort | tail -1)"

if [[ ! -x "$BUILD_TOOLS/aapt2" || ! -f "$PLATFORM_JAR" ]]; then
  echo "Android SDK build-tools/platform not found under $SDK" >&2
  exit 1
fi

rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/dex"

# No Gradle and no dependencies: javac against android.jar, then d8.
find "$ANDROID_DIR/src" -name '*.java' -print0 |
  xargs -0 javac --release 11 -classpath "$PLATFORM_JAR" -d "$BUILD/classes"

"$BUILD_TOOLS/d8" \
  --min-api 23 \
  --lib "$PLATFORM_JAR" \
  --output "$BUILD/dex" \
  "$BUILD"/classes/com/shelf/share/*.class

"$BUILD_TOOLS/aapt2" compile \
  --dir "$ANDROID_DIR/res" \
  -o "$BUILD/res.zip"

"$BUILD_TOOLS/aapt2" link \
  -o "$BUILD/unsigned.apk" \
  -I "$PLATFORM_JAR" \
  --manifest "$ANDROID_DIR/AndroidManifest.xml" \
  --min-sdk-version 23 \
  --target-sdk-version 36 \
  --version-code 10 \
  --version-name 2.0 \
  -R "$BUILD/res.zip" \
  --auto-add-overlay

(
  cd "$BUILD"
  cp dex/*.dex .
  zip -q unsigned.apk ./*.dex
)

if [[ ! -f "$KEYSTORE" ]]; then
  keytool -genkeypair \
    -keystore "$KEYSTORE" \
    -alias shelf \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storepass "$PASS" \
    -keypass "$PASS" \
    -dname "CN=Shelf, O=Personal, C=TR" \
    >/dev/null 2>&1
fi

"$BUILD_TOOLS/zipalign" -f 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"
"$BUILD_TOOLS/apksigner" sign \
  --v1-signing-enabled true \
  --v2-signing-enabled true \
  --v3-signing-enabled true \
  --ks "$KEYSTORE" \
  --ks-key-alias shelf \
  --ks-pass "pass:$PASS" \
  --key-pass "pass:$PASS" \
  --out "$BUILD/ShelfShare.apk" \
  "$BUILD/aligned.apk"

# The APK is public and shared; make sure no build-time endpoint or token
# leaked into it. The hosted default shelfcloud.nuritas.tr is intentional and
# does not match these patterns.
SECRETS="$(
  for dex in $(cd "$BUILD" && unzip -Z1 ShelfShare.apk | grep -E '^classes[0-9]*\.dex$'); do
    (cd "$BUILD" && unzip -p ShelfShare.apk "$dex")
  done | strings -a | grep -E 'SHARE_TOKEN|__SHARE_|(^|[^A-Za-z0-9.-])shelf\.nuritas\.tr' || true
)"
if [[ -n "$SECRETS" ]]; then
  echo "Refusing to ship an APK with a baked-in endpoint or token:" >&2
  printf '%s\n' "$SECRETS" >&2
  exit 1
fi

"$BUILD_TOOLS/apksigner" verify "$BUILD/ShelfShare.apk"
cp "$BUILD/ShelfShare.apk" "$ROOT/public/ShelfShare.apk"

echo "Built $BUILD/ShelfShare.apk"
ls -lh "$BUILD/ShelfShare.apk" "$ROOT/public/ShelfShare.apk"
