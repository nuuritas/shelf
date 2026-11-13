# AGENTS.md

Operating guide for coding agents working in this repository. Read
`docs/PROGRESS.md` for product context and history; this file is about how to
change things without breaking them.

## What this is

Single-user bookmark archive for X, LinkedIn and YouTube posts plus saved web
pages. One Cloudflare Worker
(`src/worker.ts`) plus one SQLite-backed Durable Object (`src/bookmarks-do.ts`).
Server-rendered HTML, no client framework, no build step. TypeScript 7.0.2
(native compiler), bundled by Wrangler.

The repository is public; `main` deploys the maintainer's own instance, whose
domain and provider live in a gitignored `wrangler.personal.jsonc`. There is no
hosted demo: every deployment is password-gated, so a shared instance would only
show a login page. Anyone else deploys their own copy with `bun run setup`.

## Layout

```
src/worker.ts        routing, auth, redirects, HTML responses
src/bookmarks-do.ts  Durable Object: schema, queries, alarm queue, AI jobs
src/ai.ts            AI prompts + requests (summary, translation, topics, synthesis)
src/settings.ts      stored-preference validation and env fallbacks
src/push.ts          VAPID signing, endpoint validation, summary notification text
src/x.ts             X/FxTwitter normalization (posts, quotes, articles, media)
src/links.ts         external link reading (GitHub API, readability extractor)
src/markdown.ts      dependency-free markdown renderer for agent notes
src/notes.ts         agent-note validation, ids, limits, extracted text
src/linkedin.ts      public LinkedIn post reader (guest page meta tags)
src/youtube.ts       public YouTube video reader (oEmbed + watch page meta tags)
src/transcript.ts    video transcripts (Whisper for X, Piped by default for YouTube)
src/render.ts        SSR HTML + the entire stylesheet as a template string
src/util.ts          escaping, linkify, cookies, base64, slugs
src/types.ts         shared domain types
public/              static assets, PWA manifest/service worker, share APK
android/             share target + WebView app, no-Gradle build script
cli/shelf.ts         Bun CLI + stdio MCP server (search/show/export/mcp)
.github/workflows/   CI + maintainer push log
test/                node:test unit tests
docs/PROGRESS.md     long-form project knowledge
docs/AGENT-POSTS.md  contract for agents that write notes (shelf guide)
```

## Commands

```bash
bun install                 # package manager is bun; npm is not installed
bun run typecheck           # tsc --noEmit (TS 7.0.2, ~0.1 s)
node --test                 # unit tests, .ts directly on Node 26
bun run setup               # fresh deploy: write .dev.vars, push secrets, deploy
bunx wrangler dev           # local Worker (needs .dev.vars)
bun run deploy:personal     # deploy the maintainer instance (wrangler.personal.jsonc)
bunx wrangler deploy        # deploy with the public wrangler.jsonc
bunx wrangler tail          # production logs
./android/build.sh          # rebuild public/ShelfShare.apk
shelf add file.md --title "…"  # save an agent-written note
shelf guide                    # the agent-post contract (docs/AGENT-POSTS.md)
shelf search "claude code"  # CLI → ~/.local/bin/shelf symlink to cli/shelf.ts
shelf mcp                   # stdio MCP server for Claude/Codex/Cursor
shelf youtube [--limit 20]  # fetch missing YouTube transcripts from this Mac
```

`.dev.vars` (gitignored): `APP_PASSWORD` is required and `APP_SECRET` signs the
session cookie. `SHARE_TOKEN`, `SHARE_ENDPOINT`, and `KEYSTORE_PASS` are only
needed to build the APK. `AI_API_KEY` is optional: without it, summaries run on
the Workers AI binding. `OPENCODE_API_KEY` still works as an alias, and
`SUPADATA_API_KEY` is optional and only enables YouTube captions. `PUSH_CONTACT`
is the optional VAPID contact URI (defaults to the repository URL). The local
OpenCode key is currently expired; production has a working secret.

## Maintainer project board (forks can ignore this)

The maintainer's repository is linked to the user project **All work**
(<https://github.com/users/nuuritas/projects/1>); forks do not need it and can
delete `.github/workflows/project-push-log.yml`, which skips itself when the
`PUSH_LOG_ISSUE` variable is absent. GitHub Projects has no commit
item type, so `.github/workflows/project-push-log.yml` keeps one issue
(`XB · push log`) updated on every push to `main`: it prepends the pushed commits
to the issue body and sets the title to the newest commit. That issue is the
repository's card on the board (Workstream `XB`, Status `In Progress`).

The issue number is stored in the `PUSH_LOG_ISSUE` Actions repository variable.
If the log issue is recreated, update the variable; no workflow edit is needed.

The push log is a **feed**, not the task record. Normal work uses one issue per
change and a real PR; see **Delivery workflow** below. The push log still records
the merge commits that arrive on `main`.

## Maintainer delivery workflow

Public contributors follow `CONTRIBUTING.md` (fork → branch → PR). The
maintainer's own changes, including docs and chores, follow this loop:

1. Open an issue in `nuuritas/shelf` with the goal and an acceptance
   check.
2. Add the issue to **All work** (project 1), set Workstream `XB`, and move it to
   `Todo`/`In Progress` when work starts. The project's Auto-add workflow is not
   enabled for this repository, so add the item explicitly.
3. Branch from an up-to-date `main`: `git switch -c <type>/<slug>`.
4. Implement and verify on the branch.
5. Push the branch and open a PR against `main`. The body starts with
   `Closes #<issue>` and follows `.github/pull_request_template.md`.
6. Merge the PR (squash is fine). The linked issue closes and the project's
   built-in workflows move the card to Done. Deploy after the merge, not before.
7. Delete the branch.

Direct pushes to `main` are reserved for emergencies: they update the `XB · push
log` card but do not create a task card. The repository plan does not offer
branch protection or rulesets, so this loop is enforced by convention; do not
take the shortcut.

## Request flow

`fetch` → session check (`isAuthorized`) or `SHARE_TOKEN` for
`POST /api/bookmarks` → `doJson(env, path)` → DO stub (`library`) → JSON/HTML.

Pages: `/` (all saves, latest first), `?layout=folders` (folder grid), `/t/:slug`
(one folder), `/calendar`, `/settings`, `/login`, `/share` (PWA fallback). `/` is
the flat latest-first library by default; folders are an opt-in view, and a query
or `day` always renders the flat list.
The library and folder pages accept `view=active|archived`,
`source=x|linkedin|youtube` and `lang=tr|en`; the library also accepts
`day=YYYY-MM-DD` for a single saved day (linked from `/calendar`). Forms carry
a `returnTo` so a mutation keeps the current view, language, day, and layout. `/settings` also drives notification subscriptions.
API: see `docs/PROGRESS.md` §3.

## Durable Object rules

- There is exactly one instance: `env.BOOKMARKS.idFromName('library')`.
- Schema changes must be idempotent. Add `CREATE TABLE IF NOT EXISTS` and wrap
  `ALTER TABLE` in `try/catch`, because the constructor runs on every wake.
- **Never import `SqlStorage` or `DurableObjectState` from
  `@cloudflare/workers-types`.** The class extends `DurableObject` from
  `cloudflare:workers`; mixing the two copies of those recursive interfaces
  makes `tsc` allocate GBs and hang. Use:

  ```ts
  type DoContext = ConstructorParameters<typeof DurableObject<Env>>[0];
  type DoSql = DoContext['storage']['sql'];
  ```

- Asynchronous work goes through `alarm()`, one unit per pass, in this order:
  summary → version → English translation → topic bootstrap → filing → stale
  synthesis. Re-arm only if work remains (`scheduleNext`). Never loop inside one
  alarm.
- Writes are serialized; do not add background promises outside the queue.
- Row types come from `src/types.ts`; use `sql.exec<RowType>(...)` rather than
  casting results.
- Every bookmark carries a short `ref` (5 chars, alphabet without `0/o/1/l/i`).
  It is generated on insert, backfilled for older rows in the constructor, and
  resolves in `get`/`delete`/`archive` via `resolveId`: all-digit input is a
  tweet id, anything else is a ref. Refs always contain a letter so the two
  cannot collide.

## AI layer rules

- One prompt set, three wire paths: OpenAI-compatible HTTP, Anthropic Messages
  (`/v1/messages`, base64 image blocks, top-level `system`), and the Workers AI
  binding. `aiConfig()` resolves the path from `AI_PROVIDER` (presets: opencode,
  claude, openai, cloudflare, custom) with `AI_BASE_URL`/`AI_MODEL` overrides;
  with no provider named it keeps the old inference (key → http, else binding).
  The binding path is text-only: it never receives images, so `summarizePost`
  skips image downloads there.
- Provider *subscriptions* are not API access: a Claude Max or ChatGPT Plus
  token from Claude Code/Codex cannot be used, and their OAuth tokens are not a
  general API. Only console API keys, OpenCode Go, and Cloudflare work.
- All HTTP calls go to the OpenAI-compatible endpoint in `AI_BASE_URL` with model
  `AI_MODEL`, authorised by `AI_API_KEY` (`OPENCODE_API_KEY` is a legacy alias).
  Every request also sends `x-opencode-session` with a stable per-job value
  (`shelf-<tweetId>`, `shelf-<tweetId>-v<n>`, `shelf-topic-<slug>`). OpenCode Go
  requires that header; other endpoints ignore it, so keep sending it.
- Cloudflare's `@cf/` frontier models (DeepSeek, Kimi, GLM) need a Workers Paid
  billing method. On the binding path, select one by setting `AI_MODEL` to its
  `@cf/...` id; with a key, point `AI_BASE_URL` at the account's
  `/client/v4/accounts/<id>/ai/v1`. Do not claim they work on the free plan.
- Budget `max_tokens`/`max_completion_tokens` at 4096 for prose; smaller models
  otherwise spend the budget on reasoning and return empty text.
- Every AI request goes through `postJson` in `src/ai.ts`: 180 s timeout, and
  429/5xx/network errors are retried twice (1 s, 3 s, or `Retry-After` up to
  15 s). A timeout is not retried. A summary that still fails goes back to
  `pending` once after a minute (`summary_retry_at`, `summary_attempts`) before
  the row is marked `failed`; a manual re-summarize resets the counter.
- Structured calls (`bootstrapTopics`, `classifyPost`) parse JSON leniently:
  strip code fences, take the outermost `{...}`. Treat the result as untrusted
  and validate slugs/ids against the database before writing.
- Prompts are product decisions. The summary voice is natural Turkish prose
  (3–5 paragraphs, no headings, no "Özet/Ana noktalar"), not a template. Keep it
  that way unless explicitly asked.
- Video transcripts are read in `src/transcript.ts` before the summary call.
  X videos use the smallest MP4 variant from `video.twimg.com` and Workers AI
  `@cf/openai/whisper-large-v3-turbo` (binding `AI`; 10,000 free neurons/day is
  about 214 audio minutes). YouTube uses Supadata `mode=native` only when
  `SUPADATA_API_KEY` is set; never switch it to `auto`, which bills 2 credits
  per generated minute. A transcript failure must never fail the summary.
- Piped is the **default** YouTube caption source and needs no key: with no
  `PIPED_API_URL`, `DEFAULT_PIPED_INSTANCES` in `src/transcript.ts` is used.
  Set it to a comma/space separated ladder to override, or `off` to disable the
  path. Each instance returns `GET /streams/{id}` and its subtitle URL is read
  with `fmt=vtt`. Instances are volunteer-run and flaky, so the ladder moves on
  to the next base and every failure becomes an `unavailable` transcript, never
  an exception. Order: `TRANSCRIPT_API_URL`, Piped, then Supadata
  (`mode=native`) as the fallback when `SUPADATA_API_KEY` is set.
- `TRANSCRIPT_API_URL` (a template with `{videoId}`/`{url}`) is tried before
  Supadata and accepts JSON, VTT, SRT, or plain text; `parseTranscriptBody` is
  the only parser. Keep it forgiving: it is the integration point for any
  third-party or self-hosted caption source.
- YouTube is additionally reachable through `POST /api/bookmarks/:id/transcripts`
  and `shelf youtube`, which reads captions on the Mac's residential IP and
  re-queues the summary. It prefers the optional `out/yt/fetch.sh` wrapper
  (yt-dlp, cached by video id, no key or account) and falls back to
  `get-youtube-transcript` when that wrapper is absent; pacing is `--gap`, and a
  429 stops the run. This is the free path when no Supadata key is set; it is
  not part of the Worker request path.
- `SUMMARY_LANGUAGE` is the **initial default** for the main summary language
  (Turkish in production). The Settings page stores an override in the
  `settings` table, and the DO passes it to every AI helper through `aiEnv()`,
  so the language and prompt change without a redeploy.
- The summary system prompt comes from the `settings` table (empty means the
  built-in in `src/ai.ts`). `buildSummarySystemPrompt` replaces
  `{{language}}`; a custom prompt without that placeholder gets a
  `Write in <language>.` line in front. The per-item "different angle"
  instruction is still prefixed, so versions keep working with a custom prompt.
  Validated at 8,000 characters in `src/settings.ts`.
- When the main language is Turkish, a finished summary automatically queues an
  English version in `summary_en` (`translateSummary`, session `shelf-<tweetId>-en`).
  The UI's English board reads that column; `POST /translate-all` only queues
  missing translations, so it is safe to click repeatedly.

## Notifications

- Web Push is **payload-less** by design: the Worker sends a VAPID-signed tickle
  to each stored subscription, and `public/sw.js` fetches
  `/api/notifications/next` with the session cookie to get the text. This keeps
  notification content out of the push service and avoids RFC 8291 encryption.
- VAPID keys are generated once with Web Crypto and stored in the `settings`
  table (`push_vapid_*`), not in `StoredSettings`; the DO hands out only the
  public key. `src/push.ts` owns the JWT (`ES256`, raw `r || s` signature) and
  the endpoint validation (HTTPS, public host only).
- `push_subscriptions` is capped at ten, `notifications` at fifty. A 404/410
  from a push endpoint removes that subscription. A notification row is claimed
  once (`delivered_at`), so a browser and the Android app do not both show it.
- The Android WebView cannot receive Web Push. `NotificationJobService` uses
  `JobScheduler` (15-minute periodic plus a one-off after a share/launch) to poll
  the same endpoint with the WebView's session cookie and posts a system
  notification. No Firebase, no Google services dependency.
- A finished summary queues one notification in `summarizeRow`; a failed push
  must never fail the summary (`notifySummaryReady` catches its own errors).
- The Settings page's test button (`POST /api/notifications/test`) is the quick
  way to check the browser path and, after forcing the job, the Android path.

## Rendering and CSS

- HTML is built in `render.ts`; every interpolated value must go through
  `escapeHtml`, `safeHttpUrl`, or `linkifyText`.
- The stylesheet is the `CSS` template string in the same file, served at
  `/style.css`.
- **When you change CSS, bump the query in `pageShell`:**
  `<link rel="stylesheet" href="/style.css?v=N">`. The route serves CSS with
  `Cache-Control: no-cache`, but the versioned URL is what guarantees clients
  drop the old copy. Forgetting this makes new markup render unstyled.
- Client JS (`public/app.js`) is progressive enhancement only: card expand,
  synthesis fold, copy-to-clipboard refs. No framework, no build.
- Archive, day and source are presentation state: `view=archived`,
  `day=YYYY-MM-DD` and `source=x|linkedin|youtube` are query parameters, not
  stored columns. `archived_at` is the only archive state (`NULL` = active). Keep them when adding a link or a form redirect.
  Language has a stored default in `settings` (set on `/settings`); `lang=tr|en`
  stays a per-view override and is still kept on links and form redirects. Day
  grouping and the calendar use UTC, matching `formatDate`.
- Keep the no-JS fallback working (`<noscript>` overrides in `pageShell`).

## Security

- Auth: cookie session signed with `APP_SECRET`/`APP_PASSWORD`, or
  `Authorization: Bearer <APP_PASSWORD>`.
- The APK uses an add-only `SHARE_TOKEN` accepted only on `POST /api/bookmarks`.
  It is embedded in `public/ShelfShare.apk`, which is why the APK is
  gitignored and rebuilt by `android/build.sh` — never commit it.
- Never commit `.dev.vars`, `android/*.keystore`, `.wrangler/`, or `out/`.
- The CLI stores the vault password in `~/.config/shelf/config.json` (mode 0600,
  outside the repo). Rotating `APP_PASSWORD` on the Worker requires
  `shelf config --password <new>`; the CLI reports a stale password as a 401 hint.
- All outbound fetches must keep the SSRF guard in `links.ts`; do not fetch
  private hosts.

## Change checklist

1. `bun run typecheck` — must be clean.
2. `node --test` — must pass.
3. If CSS/markup changed: bump `?v=` and check the page with a session cookie.
4. If Worker code changed: `bun run deploy:personal -- --dry-run` on the branch, then
   deploy from `main` after the merge.
5. If AI behaviour changed: run one real save/reindex in production and inspect
   the resulting text, not just the HTTP status.
6. If notifications changed: send the Settings test in a browser, and run
   `adb shell cmd jobscheduler run -f com.shelf.share 7401` after queueing one
   for the APK.
7. Deliver through the issue → branch → PR → merge loop above. One feature per
   issue and PR, imperative commit subject. Do not push to `main` directly.

## Traps seen in this repo

- CSS cache (see above).
- `tsc` hang from duplicate DO storage types (see above).
- `/tmp` is wiped periodically on this machine. Put anything durable in
  `out/` (gitignored) or the repo, not `/tmp`.
- Brave installs the PWA as a shortcut, so its share target never appears;
  the APK is the supported share path.
- Keep `workers_dev: true`. Removing it makes the workers.dev URL return 404.
- The maintainer instance is `https://shelf.nuritas.tr`; an earlier host was
  retired on 2026-11-13. If the deployment moves again, keep both routes
  attached and set `CANONICAL_HOST` to the new host plus `REDIRECT_HOSTS` to the
  comma-separated old hosts: every other host 308-redirects, and `/healthz`
  answers on both.
- A custom domain lives in `wrangler.personal.jsonc`, not the tracked
  `wrangler.jsonc`. Deploying with the wrong config detaches the custom domain;
  use `bun run deploy:personal` for the maintainer instance.
- Summary rows can contain "Özet:" prefixes from older prompts; that is data,
  not a rendering bug.
- English translations are a second AI call; a failure must not change
  `summary_status`. The primary summary stays readable and the card offers retry.
- LinkedIn is guest-page only. `src/linkedin.ts` reads the public page's meta
  tags for a post's `activity` id; there is no post API without a LinkedIn app.
  Login walls, members-only posts, and deleted posts save with empty text
  instead of failing, and the tags can change without notice. Do not add cookies
  or session handling to read more.
- Video transcripts are part of the app; the separate video digest/TTS pipeline
  is still experimental. See `docs/PROGRESS.md` §5.
- Transcript caps: 20 MB and two videos per bookmark. Longer X videos need a
  transcoder (the Worker cannot run ffmpeg); Supadata's generated mode is the
  paid fallback, not the default.
- YouTube returns HTTP 429 to Worker IPs and every Innertube client returns
  `LOGIN_REQUIRED`, so do not try to scrape caption tracks in the Worker. Use
  the Piped default, `TRANSCRIPT_API_URL`, Supadata, `shelf youtube` from a
  residential connection, or accept the page-description fallback.
- A VPS and several commercial proxy providers were also tested and get the
  same 429/`LOGIN_REQUIRED`; backbone ports sometimes refuse connections. Do not
  retry datacenter egress for YouTube; only a residential IP or a managed API
  works.

## Autonomous agent (superagent)

This repository has its own `dsh-superagent` instance (`shelf`, panel `http://192.168.1.102:3083`).
It is not a chat bot you invoke: any issue opened on this repository by an allowed account
(`nuuritas`) is a work order — no mention and no label are required.

- It acknowledges once on the issue, works in its own clone on `agent/<ticket>`, opens one pull
  request against `main`, and merges it itself when the guardrails hold. An oversized change is split
  into consecutive scoped pull requests and merged, not asked about; it never leaves one open.
- Guardrails: one module, at most 200 changed lines, no dependency, lockfile, deployment or
  generated-file change. It never builds, tests, deploys, or reads secrets.
- The issue thread is the contract. Nothing in this repository calls operator scripts, and this
  repository has no dependency on them.
- Operator tooling — status, configuration and instance control — lives in `nuuritas/spl-hazirlik`:
  `scripts/superagent-status.sh`, `scripts/superagent-sync.sh`, `scripts/superagent-instance.sh`,
  and `plans/SUPERAGENT.md`.
