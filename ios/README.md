# Shelf for iOS

A native SwiftUI client for a Shelf library. It has two targets:

| Target | Bundle ID | What it does |
|---|---|---|
| `Shelf` | `tr.nuritas.shelf` | Onboarding, settings, and the library in a `WKWebView` |
| `ShelfShareExtension` | `tr.nuritas.shelf.share` | Saves the first link from the share sheet |

The deployment target is iOS 17.0, the language mode is Swift 5, and there are
no third-party dependencies. The project is committed at
`ios/Shelf.xcodeproj`; `ios/project.yml` is the XcodeGen source it was
generated from.

## Modes

Shelf can talk to a server in two ways. Neither mode ships a personal URL,
password, or token.

### Self-hosted

1. Enter the Worker base URL, for example `https://shelf.example.workers.dev`.
   Whitespace is trimmed, `https://` is added when the scheme is missing,
   trailing path slashes are removed, and plain HTTP is allowed only for
   `localhost` or `127.0.0.1`.
2. Enter the `APP_PASSWORD` set with `wrangler secret put APP_PASSWORD`.
3. The app validates `GET /healthz` (must be 200 with `{"ok":true}`), then
   `GET /api/stats` with `Authorization: Bearer <password>`.
4. For the WebView it posts `password=<...>&next=/` to `/login` as
   `application/x-www-form-urlencoded` with a URLSession that does **not**
   follow redirects, captures the `Set-Cookie` response, and injects the
   cookie into `WKWebsiteDataStore.default().httpCookieStore` before loading
   the library. If the login fails, the WebView still loads the base URL so
   the server's own login page can appear.
5. The share extension calls `POST /api/bookmarks` with
   `Authorization: Bearer <APP_PASSWORD>`.

`APP_PASSWORD` is stored in the iOS Keychain. The base URL and display name are
stored in the App Group's `UserDefaults`.

### Shelf Cloud

1. Enter the email and password.
2. The app posts JSON `{email, password}` to `POST /api/auth/login` on the
   cloud base URL. The default is `https://cloud.shelf.nuritas.tr`; change it
   in the onboarding **Advanced** section or override the `ShelfCloudBaseURL`
   key in `Shelf/Info.plist`.
3. The response is expected to contain `{token, user, tenant}` and, ideally,
   `Set-Cookie`. The token is stored in the Keychain and used as
   `Authorization: Bearer <token>` for API calls. Returned cookies are injected
   into the WebView. `{"error": "..."}` responses are shown in the form.

## Building

From the repository root:

```bash
xcodebuild -project ios/Shelf.xcodeproj -scheme Shelf -sdk iphoneos \
  -configuration Debug CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

If Xcode has no eligible destination because no iOS device is connected, add:

```bash
-destination 'generic/platform=iOS'
```

Xcode 26 compiles a thinned asset catalog even for a device build and asks
CoreSimulator for traits. If the build stops with
`No available simulator runtimes for platform iphonesimulator`, install the iOS
platform in **Xcode → Settings → Components** (or run
`xcodebuild -downloadPlatform iOS`), then retry.

To regenerate the project after editing `project.yml`:

```bash
brew install xcodegen        # or use any xcodegen 2.46+ binary
cd ios && xcodegen generate
```

The generated `.xcodeproj` is committed, so building does not require
XcodeGen.

## Signing and capabilities

An unsigned build is enough to verify that the code compiles, but the share
extension cannot read the app's Keychain item until both targets are signed
with the same team.

For a device or TestFlight build:

1. Select the `Shelf` project in Xcode and set your Team for both targets.
2. Keep the bundle IDs `tr.nuritas.shelf` and `tr.nuritas.shelf.share`.
3. Register the App Group `group.tr.nuritas.shelf` for both bundle IDs and
   enable **App Groups** in both targets' Signing & Capabilities. Both
   entitlements files already list it.
4. Enable **Keychain Sharing** in both targets with the group
   `$(AppIdentifierPrefix)group.tr.nuritas.shelf`. The matching
   `keychain-access-groups` entries are already in
   `Shelf/Shelf.entitlements` and
   `ShareExtension/ShelfShareExtension.entitlements`.
5. Make sure the extension is embedded in the app. The XcodeGen project adds
   the `ShelfShareExtension` target as an embedded dependency, so
   `Shelf.app/PlugIns/ShelfShareExtension.appex` is produced automatically.

The Keychain access group must include the team prefix at runtime. The code
derives that prefix from the app's default Keychain group, so no team ID is
hard-coded and no secret is generated into the project. If the shared group is
not available (for example an unsigned simulator build), secrets fall back to
the local Keychain; the extension then reports that the app must be set up
first. Signing fixes that.

## Share extension

The extension activates for one web URL and for text
(`NSExtensionActivationSupportsWebURLWithMaxCount = 1`,
`NSExtensionActivationSupportsText = YES`). It:

- reads a URL attachment, or the first `http(s)` URL in shared text or
  attachments, using `NSDataDetector` with a regex fallback;
- expands `t.co` links by stopping at the first redirect;
- posts to `POST /api/bookmarks` with the stored password or cloud token;
- shows one short confirmation and dismisses, or an alert when there is no
  link, no configuration, or the server rejects the request.

Shared content is never written to the console.

## Settings

The gear button opens Settings, which shows the mode, server address, account,
and app version. **Change server** and **Sign out** both remove the password
or token, clear all WebView cookies and cached responses, and return to
onboarding.

## Files

```
ios/
├── project.yml                  XcodeGen source
├── Shelf.xcodeproj              committed Xcode project and shared scheme
├── Shelf/
│   ├── ShelfApp.swift           app entry point and root phase switch
│   ├── AppModel.swift           connection state, sign-in flows, cookie handoff
│   ├── ServerConfig.swift       modes, URL normalization, App Group storage
│   ├── Keychain.swift           shared Keychain access with team-prefix lookup
│   ├── APIClient.swift          healthz/stats, /login, cloud login, save
│   ├── OnboardingView.swift     self-hosted and cloud forms
│   ├── LibraryView.swift        WKWebView wrapper and external-link handling
│   ├── SettingsView.swift       server details and disconnect
│   ├── Info.plist
│   ├── Shelf.entitlements
│   └── Assets.xcassets          app icon from public/icon-512.png
└── ShareExtension/
    ├── ShareViewController.swift
    ├── Info.plist
    └── ShelfShareExtension.entitlements
```
