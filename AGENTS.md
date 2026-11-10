# AGENTS.md

Operating guide for coding agents working in this repository. Read
`docs/PROGRESS.md` for product context and history; this file is about how to
change things without breaking them.

## What this is

Single-user X bookmark archive. One Cloudflare Worker (`src/worker.ts`) plus one
SQLite-backed Durable Object (`src/bookmarks-do.ts`). Server-rendered HTML, no
client framework, no build step. TypeScript 7.0.2 (native compiler), bundled by
Wrangler.

Live: <https://bookmark.nuritas.tr>. Repo: private GitHub, `main` is deployed.

## Layout

```
src/worker.ts        routing, auth, redirects, HTML responses
src/bookmarks-do.ts  Durable Object: schema, queries, alarm queue, AI jobs
src/ai.ts            OpenCode prompts + requests (summary, bootstrap, filing, synthesis)
src/x.ts             X/FxTwitter normalization (posts, quotes, articles, media)
src/links.ts         external link reading (GitHub API, readability extractor)
src/render.ts        SSR HTML + the entire stylesheet as a template string
src/util.ts          escaping, linkify, cookies, base64, slugs
src/types.ts         shared domain types
public/              static assets, PWA manifest/service worker, share APK
android/             transparent share APK sources + no-Gradle build script
cli/xbv.ts           Bun CLI + stdio MCP server (search/show/export/mcp)
test/                node:test unit tests
docs/PROGRESS.md     long-form project knowledge
```

## Commands

```bash
bun install                 # package manager is bun; npm is not installed
bun run typecheck           # tsc --noEmit (TS 7.0.2, ~0.1 s)
node --test                 # 16 tests, runs .ts directly on Node 26
bunx wrangler dev           # local Worker (needs .dev.vars)
bunx wrangler deploy        # deploy to bookmark.nuritas.tr + workers.dev
bunx wrangler tail          # production logs
./android/build.sh          # rebuild public/BookmarkShare.apk
xbv search "claude code"    # CLI → ~/.local/bin/xbv symlink to cli/xbv.ts
xbv mcp                     # stdio MCP server for Claude/Codex/Cursor
```

`.dev.vars` (gitignored) needs `APP_PASSWORD`, `APP_SECRET`, `OPENCODE_API_KEY`,
`SHARE_TOKEN`, `KEYSTORE_PASS`. The local OpenCode key is currently expired;
production has a working secret.

## Request flow

`fetch` → session check (`isAuthorized`) or `SHARE_TOKEN` for
`POST /api/bookmarks` → `doJson(env, path)` → DO stub (`library`) → JSON/HTML.

Pages: `/` (library), `/t/:slug` (topic), `/login`, `/share` (PWA fallback).
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
  summary → version → topic bootstrap → filing → stale synthesis. Re-arm only
  if work remains (`scheduleNext`). Never loop inside one alarm.
- Writes are serialized; do not add background promises outside the queue.
- Row types come from `src/types.ts`; use `sql.exec<RowType>(...)` rather than
  casting results.
- Every bookmark carries a short `ref` (5 chars, alphabet without `0/o/1/l/i`).
  It is generated on insert, backfilled for older rows in the constructor, and
  resolves in `get`/`delete` via `resolveId`: all-digit input is a tweet id,
  anything else is a ref. Refs always contain a letter so the two cannot
  collide.

## AI layer rules

- All calls go to OpenCode Go (`AI_BASE_URL`) with model `AI_MODEL`
  (`deepseek-v4.1-flash`) and **must** send `x-opencode-session`. Use a stable
  per-job value (`xbv-<tweetId>`, `xbv-<tweetId>-v<n>`, `xbv-topic-<slug>`).
- Budget `max_tokens`/`max_completion_tokens` at 4096 for prose; smaller models
  otherwise spend the budget on reasoning and return empty text.
- Structured calls (`bootstrapTopics`, `classifyPost`) parse JSON leniently:
  strip code fences, take the outermost `{...}`. Treat the result as untrusted
  and validate slugs/ids against the database before writing.
- Prompts are product decisions. The summary voice is natural Turkish prose
  (3–5 paragraphs, no headings, no "Özet/Ana noktalar"), not a template. Keep it
  that way unless explicitly asked.
- `SUMMARY_LANGUAGE` switches Turkish/English.

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
4. If Worker code changed: `bunx wrangler deploy --dry-run` then deploy.
5. If AI behaviour changed: run one real save/reindex in production and inspect
   the resulting text, not just the HTTP status.
6. Commit one feature at a time, imperative subject, then push `main`.

## Traps seen in this repo

- CSS cache (see above).
- `tsc` hang from duplicate DO storage types (see above).
- `/tmp` is wiped periodically on this machine. Put anything durable in
  `out/` (gitignored) or the repo, not `/tmp`.
- Brave installs the PWA as a shortcut, so its share target never appears;
  the APK is the supported share path.
- `wrangler.jsonc` keeps `workers_dev: true` next to the custom domain. Removing
  it makes the workers.dev URL return 404.
- Summary rows can contain "Özet:" prefixes from older prompts; that is data,
  not a rendering bug.
- Video/TTS work is experimental and not part of the app; see
  `docs/PROGRESS.md` §5.
