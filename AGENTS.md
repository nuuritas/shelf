# AGENTS.md

Operating guide for coding agents working in this repository. Read
`docs/PROGRESS.md` for product context and history; this file is about how to
change things without breaking them.

## What this is

Single-user X bookmark archive. One Cloudflare Worker (`src/worker.ts`) plus one
SQLite-backed Durable Object (`src/bookmarks-do.ts`). Server-rendered HTML, no
client framework, no build step. TypeScript 7.0.2 (native compiler), bundled by
Wrangler.

The repository is public; `main` deploys the maintainer's own instance, whose
domain and provider live in a gitignored `wrangler.personal.jsonc`. There is no
hosted demo: every deployment is password-gated, so a shared instance would only
show a login page. Anyone else deploys their own copy with `bun run setup`.

## Layout

```
src/worker.ts        routing, auth, redirects, HTML responses
src/bookmarks-do.ts  Durable Object: schema, queries, alarm queue, AI jobs
src/ai.ts            AI prompts + requests (summary, translation, topics, synthesis)
src/x.ts             X/FxTwitter normalization (posts, quotes, articles, media)
src/links.ts         external link reading (GitHub API, readability extractor)
src/transcript.ts    video transcripts (Workers AI Whisper for X, Supadata for YouTube)
src/render.ts        SSR HTML + the entire stylesheet as a template string
src/util.ts          escaping, linkify, cookies, base64, slugs
src/types.ts         shared domain types
public/              static assets, PWA manifest/service worker, share APK
android/             transparent share APK sources + no-Gradle build script
cli/xbv.ts           Bun CLI + stdio MCP server (search/show/export/mcp)
.github/workflows/   CI + maintainer push log
test/                node:test unit tests
docs/PROGRESS.md     long-form project knowledge
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
./android/build.sh          # rebuild public/BookmarkShare.apk
xbv search "claude code"    # CLI → ~/.local/bin/xbv symlink to cli/xbv.ts
xbv mcp                     # stdio MCP server for Claude/Codex/Cursor
xbv youtube [--limit 20]    # fetch missing YouTube transcripts from this Mac
```

`.dev.vars` (gitignored): `APP_PASSWORD` is required and `APP_SECRET` signs the
session cookie. `SHARE_TOKEN`, `SHARE_ENDPOINT`, and `KEYSTORE_PASS` are only
needed to build the APK. `AI_API_KEY` is optional: without it, summaries run on
the Workers AI binding. `OPENCODE_API_KEY` still works as an alias, and
`SUPADATA_API_KEY` is optional and only enables YouTube captions. The local
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

1. Open an issue in `nuuritas/x-bookmark-vault` with the goal and an acceptance
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

Pages: `/` (library), `/t/:slug` (topic), `/calendar`, `/login`, `/share` (PWA fallback).
The library and topic pages accept `view=active|archived` and `lang=tr|en`;
the library also accepts `day=YYYY-MM-DD` for a single saved day (linked from
`/calendar`). Forms carry a `returnTo` so a mutation keeps the current view,
language, and day.
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
  (`xbv-<tweetId>`, `xbv-<tweetId>-v<n>`, `xbv-topic-<slug>`). OpenCode Go
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
- `PIPED_API_URL` is the keyless fallback: `GET /streams/{id}` then the
  subtitle URL with `fmt=vtt`. Instances are volunteer-run and flaky, so every
  failure becomes an `unavailable` transcript, never an exception.
- `TRANSCRIPT_API_URL` (a template with `{videoId}`/`{url}`) is tried before
  Supadata and accepts JSON, VTT, SRT, or plain text; `parseTranscriptBody` is
  the only parser. Keep it forgiving: it is the integration point for any
  third-party or self-hosted caption source.
- YouTube is additionally reachable through `POST /api/bookmarks/:id/transcripts`
  and `xbv youtube`, which runs `get-youtube-transcript` on the Mac's residential
  IP and re-queues the summary. This is the free path when no Supadata key is
  set; it is not part of the Worker request path.
- `SUMMARY_LANGUAGE` sets the main summary language (Turkish in production).
  When the main language is Turkish, a finished summary automatically queues an
  English version in `summary_en` (`translateSummary`, session `xbv-<tweetId>-en`).
  The UI's English board reads that column; `POST /translate-all` only queues
  missing translations, so it is safe to click repeatedly.

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
  synthesis fold, in-place topic swap. No framework, no build.
- Archive, language, and day are presentation state: `view=archived`, `lang=en`,
  and `day=YYYY-MM-DD` are query parameters, not stored columns. `archived_at` is
  the only archive state (`NULL` = active). Keep them when adding a link or a
  form redirect. Day grouping and the calendar use UTC, matching `formatDate`.
- Keep the no-JS fallback working (`<noscript>` overrides in `pageShell`).

## Security

- Auth: cookie session signed with `APP_SECRET`/`APP_PASSWORD`, or
  `Authorization: Bearer <APP_PASSWORD>`.
- The APK uses an add-only `SHARE_TOKEN` accepted only on `POST /api/bookmarks`.
  It is embedded in `public/BookmarkShare.apk`, which is why the APK is
  gitignored and rebuilt by `android/build.sh` — never commit it.
- Never commit `.dev.vars`, `android/*.keystore`, `.wrangler/`, or `out/`.
- The CLI stores the vault password in `~/.config/xbv/config.json` (mode 0600,
  outside the repo). Rotating `APP_PASSWORD` on the Worker requires
  `xbv config --password <new>`; the CLI reports a stale password as a 401 hint.
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
6. Deliver through the issue → branch → PR → merge loop above. One feature per
   issue and PR, imperative commit subject. Do not push to `main` directly.

## Traps seen in this repo

- CSS cache (see above).
- `tsc` hang from duplicate DO storage types (see above).
- `/tmp` is wiped periodically on this machine. Put anything durable in
  `out/` (gitignored) or the repo, not `/tmp`.
- Brave installs the PWA as a shortcut, so its share target never appears;
  the APK is the supported share path.
- Keep `workers_dev: true`. Removing it makes the workers.dev URL return 404.
- A custom domain lives in `wrangler.personal.jsonc`, not the tracked
  `wrangler.jsonc`. Deploying with the wrong config detaches the custom domain;
  use `bun run deploy:personal` for the maintainer instance.
- Summary rows can contain "Özet:" prefixes from older prompts; that is data,
  not a rendering bug.
- English translations are a second AI call; a failure must not change
  `summary_status`. The primary summary stays readable and the card offers retry.
- Video transcripts are part of the app; the separate video digest/TTS pipeline
  is still experimental. See `docs/PROGRESS.md` §5.
- Transcript caps: 20 MB and two videos per bookmark. Longer X videos need a
  transcoder (the Worker cannot run ffmpeg); Supadata's generated mode is the
  paid fallback, not the default.
- YouTube returns HTTP 429 to Worker IPs and every Innertube client returns
  `LOGIN_REQUIRED`, so do not try to scrape caption tracks in the Worker. Use
  `TRANSCRIPT_API_URL`, Supadata, `xbv youtube` from a residential connection,
  or accept the page-description fallback.
- A VPS and several commercial proxy providers were also tested and get the
  same 429/`LOGIN_REQUIRED`; backbone ports sometimes refuse connections. Do not
  retry datacenter egress for YouTube; only a residential IP or a managed API
  works.
