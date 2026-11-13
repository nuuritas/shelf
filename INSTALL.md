# Install Shelf

This file is written so an AI agent can perform the install end to end, and so a
human can read it as a checklist. It takes about five minutes and stays on
Cloudflare's free plan.

If you are the agent: read **Rules** and **Ask first**, then work through the
steps in order. Every step ends with what "done" looks like. Do not say the
install is finished until step 6 has passed.

## Rules

1. Never commit or copy `.dev.vars`, `.wrangler/`, or `out/`. They hold
   secrets.
2. The free plan is enough. If something says Workers Paid, stop and ask the
   user instead of upgrading anything.
3. Do not invent credentials. `bun run setup` generates them; the user provides
   only a password if they want a specific one.
4. Do not create a public demo or share the app URL widely. It is a single-user
   vault behind one password.
5. At the end, report the app URL and the `APP_PASSWORD` from `.dev.vars`, plus
   any optional step left undone.

## Ask first

Ask these before changing anything, then continue:

1. **AI provider.** `cloudflare` needs no key and is the recommended start.
   `opencode`, `claude`, and `openai` need an API key. `custom` needs a base URL,
   a model id, and usually a key. A Claude or ChatGPT *subscription* is not an
   API key and cannot be used here.
2. **Domain.** The free `https://<worker>.<subdomain>.workers.dev` URL, or a
   domain already on their Cloudflare account.

Skip optional transcript keys unless the user asks; YouTube captions already
work without one.

## 1. Toolchain

```bash
bun --version && git --version
```

Bun missing: `curl -fsSL https://bun.sh/install | bash`, then reopen the shell.
Node 22+ is only needed for the tests, not the deploy.

**Done when:** both commands print a version.

## 2. Clone and install

```bash
git clone https://github.com/nuuritas/shelf.git
cd shelf
bun install
```

**Done when:** `bun install` finishes without errors.

## 3. Cloudflare login

```bash
bunx wrangler whoami
```

If it is not logged in, run `bunx wrangler login` and ask the user to approve the
browser prompt. On a headless machine, ask the user for a Cloudflare API token
with the *Edit Cloudflare Workers* template and use:

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
```

**Done when:** `whoami` prints the account name.

## 4. Password (and key)

`bun run setup` generates missing secrets but keeps the ones already in
`.dev.vars`, so write the password first. Generate one if the user has no
preference:

```bash
openssl rand -hex 16
```

```bash
cat > .dev.vars <<EOF
APP_PASSWORD=<that value>
EOF
```

If `.dev.vars` already exists, append the line instead of overwriting the file —
it may hold `SHARE_TOKEN`, `APP_SECRET`, or provider keys.

When the chosen provider needs a key, append it:

```bash
printf 'AI_API_KEY=%s\n' '<key>' >> .dev.vars
```

For `custom`, also add to `wrangler.jsonc` inside `"vars"`:

```jsonc
"AI_PROVIDER": "custom",
"AI_BASE_URL": "https://api.example.com/v1",
"AI_MODEL": "the-model-id"
```

`setup` writes `AI_PROVIDER` itself; the two `AI_*` extras are yours to add.

**Done when:** `.dev.vars` contains `APP_PASSWORD` (and `AI_API_KEY` when
needed).

## 5. Deploy

```bash
bun run setup --provider cloudflare
```

Use the chosen id in place of `cloudflare`. Without `--provider` the script asks
a menu question, which an agent should avoid. The run:

- writes `AI_PROVIDER` into `wrangler.jsonc` (or `wrangler.personal.jsonc` when
  that file exists),
- fills in `APP_SECRET` and `SHARE_TOKEN` in `.dev.vars`,
- uploads the secrets with `wrangler secret bulk`,
- deploys and prints the `https://…workers.dev` URL.

Copy that URL. If the output scrolled away, `bunx wrangler deploy` again is safe
and idempotent.

**Done when:** the deploy succeeds and you have the URL.

## 6. Verify (do not skip)

Set two shell variables:

```bash
BASE=https://<the workers.dev URL>
PASS=$(grep '^APP_PASSWORD=' .dev.vars | cut -d= -f2-)
```

a. The login page answers:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/login"   # expect 200
```

b. The API accepts the password:

```bash
curl -s -H "Authorization: Bearer $PASS" "$BASE/api/bookmarks" | head -c 200
```

Expect JSON, not `{"error":"Authentication required."}`.

c. Save a real post and wait for its summary. Use an X post the user names, or
any public post with text. An X link is the usual case; a public LinkedIn post
URL is also accepted:

```bash
curl -s -X POST "$BASE/api/bookmarks" \
  -H "Authorization: Bearer $PASS" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://x.com/<user>/status/<id>"}'
```

Expect `"created": true` and a `"ref"` in `bookmark`. Then poll:

```bash
curl -s -H "Authorization: Bearer $PASS" "$BASE/api/bookmarks/<ref>" \
  | jq -r '.bookmark.summary_status + " | " + (.bookmark.summary // "")[:120]'
```

`summary_status` moves `pending` → `working` → `done` in 10–60 seconds. On
`failed`, read `.bookmark.summary_error`: a key problem or the free AI quota.
Re-run with `POST /api/bookmarks/<ref>/summarize` after fixing it. Delete the
test bookmark when the user did not choose the post: `DELETE /api/bookmarks/<ref>`.

d. If the test post is a YouTube link, check that `bookmark.transcripts[0].provider`
is `piped` and its status is `done`. Piped is best-effort, so an `unavailable`
transcript is a warning, not a failed install.

**Done when:** a and b pass, and one bookmark reaches `summary_status: done` with
non-empty text.

## Custom domain (optional)

Add the route to the tracked `wrangler.jsonc` (or to a gitignored
`wrangler.personal.jsonc` copied from `wrangler.personal.example.jsonc` if the
domain must stay out of git):

```jsonc
"routes": [{ "pattern": "bookmarks.example.com", "custom_domain": true }]
```

Then `bunx wrangler deploy` (or `bun run deploy:personal` when using the personal
config) and repeat step 6 against the new hostname.

## Mobile apps (optional)

There is nothing to build. Install the published Android app
(`https://github.com/nuuritas/shelfcloud-apk/releases/latest/download/Shelf.apk`),
or the iOS app from TestFlight once it is public, and choose **Self-hosted** at
first launch:

1. Server URL: the Worker URL from step 6.
2. Password: the same `APP_PASSWORD`.

The app tests the connection with `GET /healthz` and `GET /api/stats`, stores
the session cookie, and opens the library in its own WebView. Sharing an X,
LinkedIn or YouTube link to **Shelf** saves it in the background; a short toast
reports the result. The Android build also polls for finished summaries and
posts a system notification.

The apps are dual-mode: no password or token is compiled in, and the one
built-in host is the public Shelf Cloud default, which the first launch screen
shows pre-filled and lets you replace with your Worker URL. The same published
build therefore works against any self-hosted instance. Their source is private
and lives with the hosted service; a fork cannot build its own binary from it,
so keep using the published build or the PWA.

## Notifications (optional)

Open **Settings** in the web app (or in the Android app) and turn on
notifications. The browser asks for permission; VAPID keys and the subscription
stay in the Durable Object. `PUSH_CONTACT` can be a `mailto:` or `https:` URI
that a push service can use to contact the owner; it defaults to the repository
URL.

The Android app cannot receive Web Push inside a WebView, so it polls the
Worker in the background (about every 15 minutes, plus a sooner check after a
share) and posts a system notification. Android 13+ asks for the notification
permission on first launch. The Settings page's **Send a test notification**
button checks the browser path; the Android path needs the app to be logged in.

## Transcripts (optional)

YouTube captions work out of the box through public Piped instances; there is
nothing to do. Only touch this after the install works:

| Want | Set | Notes |
| --- | --- | --- |
| A different Piped instance | `PIPED_API_URL` | One URL, a comma-separated ladder, or `off`. |
| Supadata as fallback | `SUPADATA_API_KEY` | 100 native-caption credits per month. |
| Any other service | `TRANSCRIPT_API_URL` + `TRANSCRIPT_API_KEY` | Template with `{videoId}` or `{url}`; add `TRANSCRIPT_API_HEADER=x-api-key` when needed. |
| Readings from the user's own IP | `shelf youtube` | Residential connection; not part of the Worker. |

Set secrets with `printf '%s' '<value>' | bunx wrangler secret put SUPADATA_API_KEY`
and vars in `wrangler.jsonc`, then redeploy.

## CLI and MCP (optional)

```bash
ln -sf "$PWD/cli/shelf.ts" ~/.local/bin/shelf
shelf config --url "$BASE" --password "$PASS"
shelf search "anything"
```

`shelf mcp` starts a stdio MCP server for Claude Code, Codex, or Cursor.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `wrangler whoami` fails | Not logged in: `bunx wrangler login`, or set `CLOUDFLARE_API_TOKEN`. |
| `workers.dev` returns 404 | Wrong account or a removed route. Keep `workers_dev: true` in `wrangler.jsonc` and deploy again. |
| `Authentication required.` | Password mismatch. Set `APP_PASSWORD` in `.dev.vars`, `printf '%s' "$PASS" \| bunx wrangler secret put APP_PASSWORD`, retry. |
| Summary fails immediately | Missing or bad `AI_API_KEY` for the chosen provider, or Workers AI not enabled on the account. |
| Summary fails after a few saves | Free AI quota for the day is spent (10,000 neurons, resets 00:00 UTC). Add a key or wait. |
| `bun install` fails | Bun missing or outdated; reinstall Bun. |
| App says the server did not answer | Wrong URL or a `http://` host: use the full `https://` Worker URL, and log in with `APP_PASSWORD`. |
| YouTube transcript `unavailable` | Piped instance down or the video has no captions. Retry later or configure Supadata. |
| LinkedIn post cannot be read | Only public posts work, through the guest page; members-only or deleted posts return a read error. Check the URL in a logged-out browser. |

## What to report

- App URL, and `APP_PASSWORD` from `.dev.vars`.
- Provider used, and whether a key was needed.
- Whether the mobile app was installed (Android APK or iOS TestFlight).
- Optional steps left out (domain, transcripts, CLI).
- The test bookmark's ref, or that it was deleted.
