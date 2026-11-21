# AGENTS.md

Operating guide for coding agents working in this repository. Read
`docs/PROGRESS.md` for product context and history; this file is about how to
change things without breaking them.

## What this is

Single-user bookmark archive for X, LinkedIn and YouTube posts plus saved web
pages. One Cloudflare Worker
(`src/worker.ts`) plus one SQLite-backed Durable Object (`src/bookmarks-do.ts`).
Server-rendered HTML, no client framework, no build step. TypeScript 7.0.2
(native compiler), bundled by Wrangler and deployed with the `cf` CLI.

The repository is public; `main` deploys the maintainer's own instance, whose
domains and provider live in a gitignored `cloudflare.personal.json`. There is
no hosted demo: every deployment is password-gated, so a shared instance would
only show a login page. Anyone else deploys their own copy with `bun run setup`.

## Agent harnesses

Two harnesses work on this repository. They do different jobs, and the split is
deliberate.

**T3 Code is the main harness.** Work a person starts happens in a T3 thread:
one thread, one worktree, one branch, one pull request. It runs the gates in the
change checklist before the pull request opens, then links the pull request and
watches it, so a failed check, a new review, a comment or a conflict wakes the
same session that wrote the code. The thread owns its pull request through the
review and fixes what the reviewer asked for; `nt-agent-review` approves the
current head and merges it.

**`dsh-superagent` is the unattended lane.** It watches this repository's issues
and turns each one into a clone, a branch and one pull request, then requests
`nt-agent-review` and stops. It has its own GitHub account (`nuuritas-agent`),
which acts as the code account: it never approves and never merges. It runs on
the operator's Mac under launchd, with no window to close. See
**Autonomous agent (superagent)** below.

A person starts work in T3; an issue starts work in the superagent. Neither
waits for the other, so these rules keep one change from being done twice:

- Before a T3 thread starts, check for a live ticket: `gh issue list --state
  open` and `gh pr list`. An issue that already carries the agent's
  acknowledgement belongs to the superagent — review its pull request instead of
  opening a second one.
- A T3 thread never files an issue for something it is about to do itself. On
  this repository an issue is a work order, not a discussion channel.
- Changes to the agent contract itself — this file, the delivery rules, the
  superagent's scope — skip the issue step, because opening one would queue the
  same edit for the superagent. Ship them as a branch and a pull request whose
  body says why there is no `Closes #N`.
- Branches: `agent/<ticket>` belongs to the superagent. A T3 thread pushes to
  `<type>/<slug>`. Taking over an agent branch is a handoff: say so on the pull
  request and keep working on that same branch.
- One pull request per change. Two open pull requests for the same acceptance
  check is a bug in the process, not extra progress.
- Gates belong to T3. A superagent pull request states the gates it did not run;
  the operator runs them, and any failure is handed to T3 to fix.
- A T3 thread links its pull request with `link_pull_request`, watches it with
  `watch_pull_request`, and ends the turn. The watch stays armed across turns:
  do not poll, sleep, or run `gh pr checks --watch`. On a wake, read only what is
  new, fix it, push, reply on the pull request, and end the turn.
- A wake is not an approval. Only `nt-agent-review` merges, after approving the
  current head; an event that woke the thread says nothing about the review state.

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
src/mcp.ts           hosted MCP endpoint: POST /mcp, JSON-RPC over Streamable HTTP
src/linkedin.ts      public LinkedIn post reader (guest page meta tags)
src/youtube.ts       public YouTube video reader (oEmbed + watch page meta tags)
src/transcript.ts    video transcripts (Whisper for X, Piped by default for YouTube)
src/render.ts        SSR HTML + this Worker's own stylesheet rules
src/brand.ts         the cobalt palette, @font-face set, mark and asset version
src/util.ts          escaping, linkify, cookies, base64, slugs
src/labels.ts        label names, slugs and per-post limits (pure, no imports)
src/types.ts         shared domain types
public/              static assets, PWA manifest/service worker
cli/shelf.ts         Bun CLI + stdio MCP server (search/show/export/mcp)
.github/workflows/   CI
test/                node:test unit tests
docs/PROGRESS.md     long-form project knowledge
docs/AGENT-POSTS.md  contract for agents that write notes (shelf guide)
docs/DESIGN.md       the design system: tokens, type, mark, layout
```

The Android and iOS clients are not in this repository, and their source is not
public: they live in the maintainer's private `nuuritas/shelf-cloud` repository
and are published as a signed APK and a TestFlight build. Both stay dual-mode,
so one published build works against any self-hosted Worker as well. There is no
link to point contributors at, so do not add one.

## Commands

```bash
bun install                 # package manager is bun; npm is not installed
bun run typecheck           # tsc --noEmit (TS 7.0.2, ~0.1 s)
node --test                 # unit tests, .ts directly on Node 26
bun run setup               # fresh deploy: write .dev.vars, push secrets, deploy
bun run dev                 # local Worker (cf dev, needs .dev.vars)
bun run deploy:personal     # deploy the maintainer instance (cloudflare.personal.json)
bun run deploy              # deploy the public shape (workers.dev, English)
bun run deploy:personal:dry # build and check a personal deploy without uploading
bun run deploy:dry          # build and check without uploading (CI runs this)
cf o11y telemetry live-tail --script-id shelf  # production logs
shelf add file.md --title "…"  # save an agent-written note
shelf guide                    # the agent-post contract (docs/AGENT-POSTS.md)
shelf search "claude code"  # CLI → ~/.local/bin/shelf symlink to cli/shelf.ts
shelf mcp                   # stdio MCP server for Claude/Codex/Cursor
shelf youtube [--limit 20]  # fetch missing YouTube transcripts from this Mac
bun run changelog           # regenerate src/changelog-data.ts after editing CHANGELOG.md
```

All Cloudflare work goes through `cf` (1.0.0-beta), not Wrangler: deploy, dev,
secrets, logs and resources. Wrangler stays as a devDependency because `cf`
delegates bundling to it, and `wrangler.config.ts` is the file that names
`public/` as the asset directory. `cf` also loads `cloudflare.config.ts` with
Node, so it needs Node 22.18 or newer — run it through `bun run`, never as a Bun
script, and do not call `cf` from a Worker.

`bun run deploy` publishes `main` and nothing else. A deploy bundles the working
tree rather than a checkout of a commit — `src/` is bundled from disk and
`public/` is copied whole — so `scripts/deploy-check.ts` runs first and refuses a
branch other than `main`, an uncommitted change under `src/` or `public/`, and a
`main` that is behind `origin/main`. A dry run uploads nothing and skips the
check, which is why `deploy:dry` and `deploy:personal:dry` exist.

`.dev.vars` (gitignored): `APP_PASSWORD` is required and `APP_SECRET` signs the
session cookie. `SHARE_TOKEN` is optional: it adds an add-only bearer token for
`POST /api/bookmarks`, for scripts. The mobile apps do not use it; they sign in
with `APP_PASSWORD` or a cloud token at first launch. `AI_API_KEY` is optional:
without it, summaries run on the Workers AI binding. `OPENCODE_API_KEY` still
works as an alias, and `SUPADATA_API_KEY` is optional and only enables YouTube
captions. `PUSH_CONTACT` is the optional VAPID contact URI (defaults to the
repository URL). The local OpenCode key is currently expired; production has a
working secret.

## Maintainer project board (forks can ignore this)

The maintainer's repository is linked to the user project **All work**
(<https://github.com/users/nuuritas/projects/1>); forks do not need it. The board
holds issues and pull requests only: one card per change, moved to Done by the
board's built-in workflows when the issue closes. Pushes are not logged on the
board — a commit is visible in git and through the pull request that produced it.

## Maintainer delivery workflow

Public contributors follow `CONTRIBUTING.md` (fork → branch → PR). The
maintainer's own changes, including docs and chores, follow this loop:

1. Open an issue in `nuuritas/shelf` with the goal and an acceptance
   check. Two cases skip steps 1-2: a change to the agent contract itself, and
   work started in a T3 thread. See **Agent harnesses** above — an issue routes
   the change to the superagent, so T3 work opens no issue.
2. Add the issue to **All work** (project 1), set Workstream `XB`, and move it to
   `Todo`/`In Progress` when work starts. The project's Auto-add workflow is not
   enabled for this repository, so add the item explicitly.
3. Branch from an up-to-date `main`: `git switch -c <type>/<slug>`.
4. Implement and verify on the branch.
5. Push the branch and open a PR against `main`. The body starts with
   `Closes #<issue>` when step 1 applied, or says why there is no `Closes #N`
   when it was skipped, and follows `.github/pull_request_template.md`.
6. `nt-agent-review` approves the head commit and merges the PR (squash is
   fine) once that approval is on the head being merged. Changes requested go
   back to the author on the same branch, which pushes and requests the review
   again. A linked issue closes and the project's built-in workflows move the
   card to Done. Deploy after the merge, not before.
7. Delete the branch.

Direct pushes to `main` are reserved for emergencies: they leave no card at all,
so the change cannot be followed from the board. The repository plan does not
offer branch protection or rulesets, so this loop is enforced by convention; do
not take the shortcut.

## Request flow

`fetch` → session check (`isAuthorized`) or `SHARE_TOKEN` for
`POST /api/bookmarks` → `doJson(env, path)` → DO stub (`library`) → JSON/HTML.

Pages: `/` (all saves, latest first), `?layout=folders` (folder grid), `/t/:slug`
(one folder), `/calendar`, `/settings`, `/login`, `/share` (PWA fallback). `/` is
the flat latest-first library by default; folders are an opt-in view, and a query
or `day` always renders the flat list.
The library and folder pages accept `view=active|archived`,
`source=x|linkedin|youtube`, `lang=tr|en` and `label=<slug>`; the library also
accepts `day=YYYY-MM-DD` for a single saved day (linked from `/calendar`). A
`label` always renders the flat list. Forms carry a `returnTo` so a mutation
keeps the current view, language, day, label, and layout. `/settings` also
drives notification subscriptions.
API: see `docs/PROGRESS.md` §3.

## Durable Object rules

- There is exactly one instance: `env.BOOKMARKS.idFromName('library')`.
- The class is declared once, in `cloudflare.config.ts`:
  `exports: { Bookmarks: exports.durableObject({ storage: 'sqlite' }) }`, with
  the `BOOKMARKS` binding pointing at the same Worker. That replaces the old
  Wrangler `migrations` array. A Worker may use `exports` or `migrations`, never
  both, and once it has deployed with `exports` it cannot go back. Add a class
  by adding it to `exports`; never delete or rename the `Bookmarks` entry, which
  would drop every saved bookmark.
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
- Prompts are product decisions. The summary voice is natural prose in the
  summary language (3–5 paragraphs, no headings, no "Özet/Ana noktalar"), not a
  template. Keep it that way unless explicitly asked.
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
  (English unless set). The Settings page stores an override in the
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
- The Android WebView cannot receive Web Push. `NotificationJobService` in
  `nuuritas/shelf-cloud/apps/android` uses `JobScheduler` (15-minute periodic
  plus a one-off after a share/launch) to poll the same endpoint with the
  WebView's session cookie and posts a system notification. No Firebase, no
  Google services dependency. The endpoint contract is the same for the iOS
  app, so a change here needs the app checked too.
- A finished summary queues one notification in `summarizeRow`; a failed push
  must never fail the summary (`notifySummaryReady` catches its own errors).
- The Settings page's test button (`POST /api/notifications/test`) is the quick
  way to check the browser path and, after forcing the job, the Android path.

## Rendering and CSS

- HTML is built in `render.ts`; every interpolated value must go through
  `escapeHtml`, `safeHttpUrl`, or `linkifyText`.
- The stylesheet is the `CSS` template string in `render.ts`, served at
  `/style.css`. It starts with `BRAND_CSS` from `src/brand.ts`: the palette,
  both theme blocks, the legacy aliases and the `@font-face` set live there and
  nowhere else. Do not write a hex in `render.ts`; add a token instead.
- Brand assets (the favicon, the touch icon, the manifest) are linked through
  `assetUrl()` in `src/brand.ts`, which appends `?v=${ASSET_VERSION}`. Bump
  that constant in the same commit that redraws a file under `public/`.
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
- Labels are stored, unlike those: `labels(slug PK, name, created_at)` plus
  `bookmark_labels(tweet_id, slug)`. The slug is the key, so the first spelling
  wins (`ON CONFLICT(slug) DO NOTHING`), and `src/labels.ts` owns the name, slug
  and per-post limit rules. The DO parses labels once; the Worker forwards the
  raw array or comma string from a form, note or API call. A bookmark keeps its
  labels when it is re-posted, and a label that no post carries is pruned from
  the menu. A label row renders on post and note cards in the flat list only.
- Keep the no-JS fallback working (`<noscript>` overrides in `pageShell`).

## Security

- Auth: cookie session signed with `APP_SECRET`/`APP_PASSWORD`, or
  `Authorization: Bearer <APP_PASSWORD>`.
- `SHARE_TOKEN` is an add-only bearer token accepted only on
  `POST /api/bookmarks`, for scripts. The mobile apps do not use it: they sign
  in with `APP_PASSWORD` or a cloud session at first launch. No password or
  token is compiled into them; the only built-in host is the public Shelf Cloud
  default, which the user replaces for a self-hosted instance.
- Never commit `.dev.vars`, `.cloudflare/`, or `out/`.
- The CLI stores the vault password in `~/.config/shelf/config.json` (mode 0600,
  outside the repo). Rotating `APP_PASSWORD` on the Worker requires
  `shelf config --password <new>` — the scripted form, where the flag is the
  point; `shelf login` is the interactive one. The CLI reports a stale password
  as a 401 hint.
- All outbound fetches must keep the SSRF guard in `links.ts`; do not fetch
  private hosts.

## Change checklist

1. `bun run typecheck` — must be clean.
2. `node --test` — must pass.
3. If CSS/markup changed: bump `?v=` and check the page with a session cookie.
4. If Worker code changed: `bun run deploy:personal:dry` on the branch, then
   deploy from `main` after the merge (`bun run deploy:personal`; secrets come
   from `bun run setup`, which passes `.dev.vars` with the deploy).
5. If AI behaviour changed: run one real save/reindex in production and inspect
   the resulting text, not just the HTTP status.
6. If notifications changed: send the Settings test in a browser, and run
   `adb shell cmd jobscheduler run -f com.shelf.share 7401` after queueing one
   for the Android app (built from `nuuritas/shelf-cloud/apps/android`).
7. Deliver through the issue → branch → PR → merge loop above. One feature per
   issue and PR, imperative commit subject. Do not push to `main` directly.
8. If a reader can see the change: add a bullet to `CHANGELOG.md` under today's
   date and run `bun run changelog`, both in the same commit.

## Traps seen in this repo

- CSS cache (see above).
- `tsc` hang from duplicate DO storage types (see above).
- A dismissed review is not an approval. Dismissing a `CHANGES_REQUESTED`
  review empties `reviewDecision` and lets GitHub merge, which is exactly the
  state **The review gate** exists to forbid.
- `/tmp` is wiped periodically on this machine. Put anything durable in
  `out/` (gitignored) or the repo, not `/tmp`.
- Brave installs the PWA as a shortcut, so its share target never appears; the
  published Android app is the supported share path.
- The mobile apps are not here. `android/` and `ios/` moved to
  `nuuritas/shelf-cloud/apps` on 2026-11-13; this repository ships the web app
  and the PWA only. Do not re-add a build script or an APK to `public/` — the
  footer links the published download instead.
- Keep `workersDev: true`. Removing it makes the workers.dev URL return 404.
- The maintainer instance is `https://shelf.nuritas.tr`; an earlier host was
  retired on 2026-11-13. If the deployment moves again, keep both routes
  attached and set `CANONICAL_HOST` to the new host plus `REDIRECT_HOSTS` to the
  comma-separated old hosts: every other host 308-redirects, and `/healthz`
  answers on both.
- Custom domains live in the gitignored `cloudflare.personal.json`, not in the
  tracked `cloudflare.config.ts`. A deploy without `--mode personal` publishes
  the public shape and takes the maintainer's domains down; use
  `bun run deploy:personal` for the maintainer instance.
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
- Filing an issue to describe a change is the same as handing it to the
  superagent. Work on the agent contract itself goes straight to a branch and a
  pull request (see **Agent harnesses**), or two agents edit the same file.

## Agent structure

Every change in this repository follows the same structure, whoever makes it. Three accounts, one job
each; a T3 thread is the person's own session, not a fourth account.

| Role | Identity | May | Must not |
| --- | --- | --- | --- |
| Maintainer | `nuuritas` (person) | open issues, decide, review a diff by hand | merge a pull request it did not approve |
| Author | `nt-agent-code` (code account) | clone, branch, one pull request per issue, request the review | approve, merge, mark ready, push to `main`, build, test, deploy |
| Reviewer | `nt-agent-review` (review account) | read the diff, approve or request changes on the current head, merge after approving | push to that branch, edit the diff, review a pull request it authored |
| Interactive thread (T3 Code, where present) | the person's own session | implement, run the gates, answer the review | merge its own pull request, or any other |

The account that writes the code never clears it. Every merge is performed by `nt-agent-review` after
its own approval of the head being merged.

### The loop

1. An issue opened by `nuuritas` is a work order. No label and no mention are required.
2. `nt-agent-code` acknowledges within a minute, works in its own clone, and opens exactly one pull
   request against `main`. The body carries the evidence: one line per acceptance criterion marked
   **met** or **not met** with the file and line that proves it, the diff size and paths changed, the
   gates run and not run, and the risk.
3. In the same run it requests the review:
   `gh pr edit <number> --add-reviewer nt-agent-review`. Then it stops.
4. `nt-agent-review` reads the diff and the issue, posts one review, and — on approval of the current
   head — merges with `gh pr merge <number> --squash --delete-branch`. No approval means the pull
   request stays open; that is a result, not a failure.
5. **Changes requested is a task for the author**: it pushes the fix to the same branch, requests the
   review again, and reports the new head. It never opens a second pull request for the same issue.
6. `nt-agent-code` never approves and never merges, whatever approvals sit on the pull request; a
   merge by the code account is a defect. Merges that predate the cutoff in `nuuritas/superagents`
   (`policy/prompts/delivery.md`) are historical: report them, never invent or backdate an approval.

### The review gate

"Reviewed" means an `APPROVED` review from `nt-agent-review` on the pull request's current head, after
the last push. A new commit needs a new review; an approval of an earlier commit does not carry over,
addressing the findings is not a review, and green CI is not permission to merge. A pull request
carrying `CHANGES_REQUESTED`, or with no review at all, is not merged.

Never dismiss, clear or route around the review — not with the reviews/dismissals API, not with
`--admin`, and not by merging while `reviewDecision` is empty because you emptied it. The absence of
branch protection is not authority. Read the state immediately before merging, never from memory:

```bash
gh pr view <n> --json headRefOid,reviewDecision,mergeable
gh pr view <n> --json reviews --jq '.reviews[] | select(.state=="APPROVED") | {author: .author.login, commit: .commit.oid}'
```

When the approving review's `commit.oid` is not `headRefOid`, there is no approval. When
`nt-agent-review` is not yet a collaborator, the pull request stays open and names the step:

```bash
gh api -X PUT repos/nuuritas/shelf/collaborators/nt-agent-review -f permission=write
```

An approval or change request untouched for more than 30 minutes is a stall, not a state:
`bin/superagent-doctor.sh`'s `review-stall` check FAILs it naming `repo#pr`.

### Guardrails

One module, at most 200 changed lines, and no dependency, lockfile, deployment or generated-file
change. The agent never builds, tests, deploys, runs migrations, connects to production or reads
secrets — the operator runs the gates. When the work does not fit one module, it splits it into the
smallest sequence of consecutive mergeable pull requests, each reviewed and merged by
`nt-agent-review` in turn; it never asks how to split it.

### Where things live

- This repository's instance: `shelf`, panel `http://192.168.1.102:3083`.
- The contract and the operator tooling: `nuuritas/superagents` — `ARCHITECTURE.md`,
  `bin/superagent-status.sh`, `bin/superagent-activity.sh`, `bin/superagent-sync.sh`.
  Nothing in this repository depends on them.
- What the agents have been doing, per repository: `https://sa.nuritas.tr`.

## Default-branch health

The default branch is a deliverable, not just a base. Every agent working here is responsible for its
health, because a branch that quietly rots makes every later merge harder.

- After a merge, the author checks `main` itself: the latest CI run on `main`, or the
  documented gate when the repository has no CI.
- An open pull request that conflicts with `main` is a defect, not a merge candidate. The author
  rebases it before asking for review again.
- When `main` is failing or drifting, the finding becomes an issue titled
  `Default branch main is failing: <detail>` with the run, commit and failing job, instead of a
  comment nobody acts on.
- The 24-hour review audit must report the default branch's last commit, its CI conclusion and the
  number of conflicting open pull requests, so a rotting branch shows up on the record rather than in
  a surprise merge.

## Autonomous agent (superagent)

This repository has its own `dsh-superagent` instance (`shelf`, panel `http://192.168.1.102:3083`).
It is not a chat bot you invoke: any issue opened on this repository by an allowed account
(`nuuritas`) is a work order — no mention and no label are required.

It stays active and stays the only thing that picks up an issue, whether or not a T3 window is
open. T3 Code is the harness for work that needs a person in the loop and for the gates; the two
lanes are peers. **Agent harnesses** above is the contract for keeping them apart.

- It acknowledges once on the issue, works in its own clone on `agent/<ticket>`, opens one pull
  request against `main`, puts the acceptance evidence in the body, and requests `nt-agent-review` in
  the same run. It never approves and never merges: the review account does, on the current head. An
  oversized change is split into consecutive scoped pull requests, each reviewed on its own, not
  asked about.
- Guardrails: one module, at most 200 changed lines, no dependency, lockfile, deployment or
  generated-file change. It never builds, tests, deploys, or reads secrets.
- The issue thread is the contract. Nothing in this repository calls operator scripts, and this
  repository has no dependency on them.
- Operator tooling — status, configuration and instance control — lives in `nuuritas/superagents`:
  `bin/superagent-status.sh`, `bin/superagent-sync.sh`, `bin/superagent-instance.sh`,
  and `ARCHITECTURE.md`.
