# Shelf for Android

A small share target and WebView app for a Shelf instance. It is built with
`aapt2`, `javac`, `d8`, and `apksigner`; there is no Gradle project and no
third-party dependency. The same APK works with any self-hosted Shelf Worker
and with Shelf Cloud, because the server is chosen inside the app.

## Two modes

**Self-hosted** points the app at your own Worker (for example
`https://shelf.example.workers.dev`). The server password is used both for the
web session and for `POST /api/bookmarks` with a bearer token. `http://` is
accepted only for `localhost`, `127.0.0.1`, and `10.0.2.2`, so a local `wrangler dev` or the
Android emulator can be used during development; cleartext HTTP is allowed for
those hosts only by `res/xml/network_security_config.xml`.

**Shelf Cloud** uses the hosted service. The default URL is
`https://shelfcloud.nuritas.tr`, but the field can be changed to another cloud
deployment. Sign-in uses the email and password and exchanges them for a token
at `POST /api/auth/login`.

## First launch

A clean install has no server configured, so it opens setup instead of a
library:

1. Pick **Self-hosted** or **Shelf Cloud**.
2. Enter the server URL, password, and (for cloud) the account email.
3. Tap **Test connection**. Self-hosted tests run `GET /healthz` and then
   `GET /api/stats` with the password; cloud tests perform the login.
4. Tap **Save**. Setup signs in, stores the WebView cookie, and opens the
   library without a second login prompt.

The configuration can be changed later from the small settings button in the
bottom-right corner of the library (**Server settings**). Changing the server or
password clears the old session; you sign in again with the new credentials.

If a share arrives before setup is finished, the shared link is carried into
setup and posted immediately after a successful save.

## Storage and security

- Settings are app-private `SharedPreferences` (`shelf_share`).
- The password is encrypted with AES-256-GCM using a key generated in the
  Android Keystore. Only the IV and ciphertext are written to preferences.
- If the Keystore key is unavailable (for example after a broken restore on an
  old device), encryption and decryption fail closed with an error. The app
  never falls back to storing a plaintext password.
- `android:allowBackup="false"` keeps preferences out of device backups.
- The APK contains no server URL or share token. The only built-in host is the
  public Shelf Cloud default; rebuild with a different `Prefs.DEFAULT_CLOUD_URL`
  if you fork the cloud service.

## Build

Requirements:

- JDK 11 or newer (`javac` on `PATH`).
- Android SDK with `build-tools` and a `platforms/android-*` `android.jar`.
  Set `ANDROID_HOME` if the SDK is not in the default
  `~/Library/Android/sdk`.
- `KEYSTORE_PASS` in the environment or in the repository's `.dev.vars`.

`android/bookmark.keystore` is created automatically on the first build and is
gitignored, like the APK. To ship an update that Android accepts, keep using the
same keystore.

```bash
./android/build.sh
```

The script:

- compiles every file in `android/src` for Java 11 and `minSdk 23`, targeting
  API 36;
- builds version code `10`, version name `2.0`;
- signs with the keystore and verifies the signature;
- checks the dex for `SHARE_TOKEN`, `__SHARE_`, and the maintainer hosts
  (`shelf.nuritas.tr`, `bookmark.nuritas.tr`);
- writes `android/build/ShelfShare.apk` and copies it to
  `public/ShelfShare.apk`.

Both outputs are gitignored; do not commit the APK or the keystore. To install
manually:

```bash
adb install -r android/build/ShelfShare.apk
```

## Behaviour notes

- The library keeps working inside the WebView; links to other hosts open in the
  system browser.
- Cookies are flushed when the page finishes and when the app is paused.
- Returning to the app after more than a minute reloads the page.
- The back button walks the WebView history before leaving the app.
