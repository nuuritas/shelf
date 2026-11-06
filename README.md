# X Bookmark Vault

A tiny Cloudflare-native app for saving X posts, their quoted posts, and their images — with an automatic AI summary.

No Docker, no Telegram bot, no tunnel, and no X API subscription. The app runs as a Worker with one SQLite-backed Durable Object.

## What it does

Paste an X link, or share one from Android:

1. The Worker reads the post through the public FxTwitter API (or the official X API if you add a bearer token).
2. It saves the text, author, quote, X Article content, images, video URLs, and metrics.
3. It reads the first external link(s) in the post: GitHub repos use the GitHub API + README; normal pages use a small readability extractor.
4. It sends the post, article, link text, and images to OpenCode Go for a natural-language explanation.
5. It renders a private, mobile-friendly library.

If no OpenCode key is configured, saving still works; the card simply says the summary is not configured.

## Deploy

Requirements: Node 20+ and a logged-in Wrangler.

```bash
wrangler whoami
wrangler deploy
```

Set the app password:

```bash
wrangler secret put APP_PASSWORD
```

Set the OpenCode key (optional, enables summaries):

```bash
wrangler secret put OPENCODE_API_KEY
```

Set the APK share token (only needed if you use the Android APK):

```bash
wrangler secret put SHARE_TOKEN
```

For higher GitHub API limits, optionally set a read-only GitHub token:

```bash
wrangler secret put GITHUB_TOKEN
```

The default AI settings are in `wrangler.jsonc`:

- Base URL: `https://opencode.ai/inference/go/openai/v1` (OpenCode Go)
- Model: `deepseek-v4.1-flash` (text + image input)

To use a different OpenAI-compatible endpoint or model, change `AI_BASE_URL` / `AI_MODEL` in `wrangler.jsonc`, or override them with Wrangler vars.

## Android: silent share APK (recommended)

Download and install:

```
https://x-bookmark-vault.nuuritas.workers.dev/BookmarkShare.apk
```

Then in X: **Share → Bookmarks**. The APK has no visible UI: it posts the link in the background, shows a short “Saved to Bookmarks” toast, and closes. The library itself stays in the PWA/web app.

Android will ask you to allow installs from the browser the first time.

### Rebuilding the APK

The APK embeds an add-only `SHARE_TOKEN`. The token can add bookmarks but cannot read or delete them.

```bash
# SHARE_TOKEN and KEYSTORE_PASS are read from .dev.vars
./android/build.sh
```

Set the matching Worker secret:

```bash
wrangler secret put SHARE_TOKEN
```

### PWA option

The web app is also installable. Brave currently installs it as a shortcut, not a WebAPK, so it does **not** appear in Android’s share sheet. Install from Chrome if you want the PWA share target. The APK is the reliable option.

## Local development

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars
wrangler dev
```

Then open `http://localhost:8787`.

Run the unit tests:

```bash
node --test
```

## API

All API routes require the session cookie or `Authorization: Bearer <APP_PASSWORD>`. The APK uses a separate add-only `SHARE_TOKEN` for `POST /api/bookmarks`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/bookmarks?q=&limit=` | List saved bookmarks |
| `POST` | `/api/bookmarks` | Save `{ "url": "https://x.com/..." }` |
| `GET` | `/api/bookmarks/:id` | Get one normalized bookmark |
| `DELETE` | `/api/bookmarks/:id` | Delete a bookmark |
| `POST` | `/api/bookmarks/:id/summarize` | Queue a new summary |
| `GET` | `/api/stats` | Counts |
| `GET` | `/healthz` | Health check, no auth |

A bookmark contains `text`, `author`, `media`, `quote`, `article`, `metrics`, `summary`, and `summaryStatus`. Images are returned as direct URLs; AI summaries receive the image bytes as base64 data URLs.

## Notes and limits

- FxTwitter is a public, unofficial reader. It works without a key, but has no SLA and can be rate-limited or broken by X changes. For a paid, official path, set `X_BEARER_TOKEN` and `X_PROVIDER=official` in Wrangler.
- Protected, deleted, age-restricted, or login-gated posts may not be readable.
- X native Articles (`x.com/i/article/...`) are read in full and included in the summary.
- External links are fetched, but JavaScript-heavy or paywalled sites may not expose readable text. GitHub repositories use the API and README.
- Images are downloaded and sent to the AI model as base64. Videos are saved as URLs/posters, but are not transcribed in this first version.
- Summaries are written as natural context-focused explanations, not a fixed sections template.
- Summaries are generated in Turkish by default (`SUMMARY_LANGUAGE=tr`). Set it to `en` for English.
- This is a single-user app: one password, one shared library.
