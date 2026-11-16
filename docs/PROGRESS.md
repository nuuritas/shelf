# Project knowledge — Shelf

Last updated: 2026-11-13
Repository: <https://github.com/nuuritas/shelf>

This document describes the maintainer's deployment. Domain names, provider
choices, and measured quotas refer to that instance; your deployment will differ.

This file is the long-form memory of the project: what exists, why it works
this way, what was tried, and what is still open. `AGENTS.md` is the short
operating guide for coding agents; this is the context behind it.

## 1. What the product is

A single-user archive for X (Twitter) and LinkedIn posts. A link is shared from Android —
one tap, no app window — and the post is saved, read, and explained by an AI.
Over time the archive organizes itself into topics and writes its own rolling
syntheses, so it behaves less like a list of bookmarks and more like a small
knowledge base.

The maintainer instance is served at <https://shelf.nuritas.tr>. An earlier
host was retired on 2026-11-13; old links are not redirected any more, so
clients and PWAs must use the shelf host.

Non-goals: multi-user accounts and public sharing. The iOS app and Android v2
now exist (§7).

## 2. Architecture

```
Android share sheet / iOS share sheet
      │  ACTION_SEND / NSExtension
      ▼
Shelf app ──POST /api/bookmarks (session cookie or bearer token)──┐
(Android + iOS, published build)                                  │
Browser / PWA ──session cookie──► Worker (src/worker.ts) ◄────────┘
                                      │
                                      │ env.BOOKMARKS
                                      ▼
                          Durable Object "library"
                          SQLite: bookmarks, topics,
                          item_topics, summary_versions, settings,
                          push_subscriptions, notifications
                                      │
                                      ├─ FxTwitter / official X API (read post)
                                      ├─ LinkedIn guest page (read public post)
                                      ├─ GitHub API + readability (read links)
                                      ├─ Workers AI binding (summaries, topics,
                                      │  versions; no API key, text only)
                                      └─ OpenAI-compatible endpoint (key; same
                                         jobs, plus up to four images)
```

- **Worker** is stateless: auth, routing, server-rendered HTML.
- **Durable Object** `library` is the whole database. One instance by design:
  single user, serialized writes, local SQL joins, no extra binding.
- **Static assets** live in `public/` and are served by Cloudflare.
- **SSR was chosen deliberately**: one rendering path, no client framework,
  works without JS, auth checked before any HTML is produced. Client JS only
  enhances (expand cards, fold synthesis, copy refs).
- **AI providers are presets over three wire paths**: `AI_PROVIDER` selects
  `opencode`, `claude` (Anthropic Messages), `openai`, `cloudflare`, or
  `custom`; `AI_BASE_URL` and `AI_MODEL` override the preset. With no provider
  named, a key means OpenAI-compatible HTTP and no key means the `AI` binding,
  which runs `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. The base
  `cloudflare.config.ts` names no provider, so a fresh clone uses Workers AI. That
  path is text-only (images go only over HTTP, up to four) and shares the 10,000
  free neurons/day with Whisper transcription. Subscriptions are not API access:
  Claude Max and ChatGPT Plus tokens from their CLIs cannot be used here.

### Data model

| Table | Purpose |
|---|---|
| `bookmarks` | One row per saved post (X or LinkedIn): text, author, media JSON, quote JSON, article JSON, links JSON, transcripts JSON, metrics, `summary`, `summary_en`, `archived_at`, topic/version/translation job state |
| `topics` | AI-induced areas of interest: `slug`, `name`, `description`, `overview` (rolling synthesis), `overview_count` |
| `item_topics` | Many-to-many filing, with confidence |
| `labels` | The reader's own tags, keyed by slug, holding the spelling first typed. A label on no post is dropped |
| `bookmark_labels` | Many-to-many tags on a post, up to twelve |
| `summary_versions` | v2+ summaries, each with the instruction that produced it. v1 lives in `bookmarks.summary` |
| `settings` | Per-deployment preferences: the summary prompt override and the default summary language; also holds the VAPID key pair |
| `push_subscriptions` | Browser push endpoints (HTTPS only, capped at ten) |
| `notifications` | Finished-summary rows waiting for a service worker or the Android job, capped at fifty |

Schema evolution is idempotent: `CREATE TABLE IF NOT EXISTS` plus `ALTER TABLE`
inside `try { } catch { }` in the DO constructor.

### Jobs

Everything asynchronous runs through one DO alarm queue, one unit of work per
pass, in priority order:

1. summarize a pending bookmark (`summary_status = 'pending'`)
2. generate a requested summary version (`version_status = 'pending'`)
3. write a missing English version (`summary_en_status = 'pending'`)
4. if the archive has ≥3 summarized items and no topics, bootstrap topics
5. file a summarized item into topics (`topics_status = 'pending'`)
6. rewrite one stale topic synthesis (`overview_count` ≠ item count)

Each step re-arms the alarm if more work remains. AI calls wait on network, so
wall-clock is long but CPU stays low.

## 3. Features that exist

- Silent Android share (translucent activity, Toast, auto-finish)
- PWA shell with service worker (share target works on Chrome, not Brave)
- AI summary: natural prose in the configured summary language (English unless
  the deployment sets `SUMMARY_LANGUAGE` or an override on `/settings`),
  3–5 paragraphs; reads images as base64, X Article bodies, quoted posts, up to
  two external links, and video transcripts
- LinkedIn posts: a public post URL is collapsed to its `activity` id, the
  canonical page is read without cookies, and the post text comes from the
  `description`/`og:description` meta tag (falling back to the article body).
  Author, image, and canonical URL come from the same tags. A login wall, a
  deleted post, or a members-only post saves the row with no text and the
  summary works from the URL; nothing throws. There is no LinkedIn API key and
  no session to configure
- Agent notes (`kind=note`): markdown or HTML posted through `/api/posts` or
  `shelf add`. The card's author line is the agent, the note title is the card
  lede, and the abstract is plain body copy; the title is the way into
  `/p/:ref`, which holds the document itself inside the sandboxed frame, because
  a card must not embed it. That page is a reading view:
  a slim back bar, one provenance line, then the note. An HTML note folds its
  abstract and shows the document immediately
- Video transcripts: the smallest MP4 of an X video goes to Workers AI
  `@cf/openai/whisper-large-v3-turbo` (no key, ~214 free audio minutes/day).
  YouTube links read captions from public Piped instances with no key at all
  (two are tried by default), fall back to Supadata native captions when
  `SUPADATA_API_KEY` is set, and can also be filled by `shelf youtube` from the
  Mac's residential IP (it runs the optional `out/yt/fetch.sh` yt-dlp wrapper,
  which caches per video id, falls back to `get-youtube-transcript`, and posts
  through `/api/bookmarks/:id/transcripts`).
  Results are stored in `bookmarks.transcripts_json`, fed to the summarizer, and
  shown in a fold. Two videos per bookmark, 20 MB each; a failure never blocks
  the summary
- Topic induction + per-item filing + rolling per-topic synthesis
- Summary versions: "New version" with an optional instruction; original is
  never overwritten
- Folder view is one click away, not the landing page: `/` still lists every save
  latest-first, and `?layout=folders` swaps in the AI topics as flat folder cards
  (name, description, active/archived counts). Clicking a card opens `/t/:slug`
  and a breadcrumb returns to the folder grid. There is no horizontal tab strip.
  A search or day view always uses the save list. Folders are the existing topic
  model, so one bookmark can sit in more than one folder and a reindex can rename
  or merge them
- Calendar (`/calendar`): a month grid with the number of saves on each day,
  previous/next month navigation, and a link from every non-empty day to
  `/?day=YYYY-MM-DD`. The day view reuses the normal cards, archive toggle,
  language toggle, and search, so it needs no separate rendering path. Counts
  include archived items and use UTC dates, matching the cards
- Archive instead of delete: `archived_at` removes a card from the default
  Active view but keeps the row, summary, topics, and searchability. Active and
  Archived are a toggle on the library and on topic pages; re-sharing an
  archived post puts it back in the inbox
- English board, only while the primary summary language is Turkish: the
  Turkish summary is primary; when it finishes, an English translation is queued
  automatically into `summary_en`. The `Türkçe / English` switch re-renders the
  same page; missing translations show a per-card button, and one banner button
  queues every missing one. With English as the primary language the second
  board and the translation job are off
- Notifications: a payload-less VAPID push wakes the service worker, which
  fetches the summary text from the Worker and shows a browser notification;
  the Android app polls the same endpoint in the background and posts a system
  notification. Settings has enable/disable and a test button.
- Settings (`/settings`, also reachable inside the Android WebView): edit the
  main summary prompt with an 8,000-character limit and a reset-to-default, and
  choose the summary language. Stored in the Durable Object, so new summaries
  follow it without a redeploy; existing summaries are not rewritten. The AI and
  Notifications sections are read-only/empty-state for now.
- Collapsed cards (3-line peek, expand on tap) and folded topic syntheses
- Labels: free text a person types on a save, many per post and one filter row.
  A chip on the card opens that label's list (`/?label=reading`), and a small
  editor under the chips rewrites the whole set without losing the search, day,
  archive or language view. Each chip takes one of six tones, hashed from its
  slug, so a word keeps the same colour in every view without a stored column.
  Labels the AI never writes and `POST /api/posts`
  accepts them, so an agent can tag what it files. Unused labels are dropped
  from the menu; the same word typed twice with different case is one label.
- Custom domain, with the workers.dev URL kept as a fallback
- `/api/stats` reports row counts and real SQLite database size
- Local access for AI work: `cli/shelf.ts` (search/show/topics/export/add) and
  `shelf mcp`, a stdio MCP server exposing `search_bookmarks`, `get_bookmark`,
  `list_topics`, `get_topic`, `create_post` and `get_authoring_guide`. The
  Worker stays the source of truth; reads and the one write go through the same
  API, and nothing is mirrored. `create_post` saves one agent note through
  `POST /api/posts` following `docs/AGENT-POSTS.md`. `shelf export` writes one
  markdown file per bookmark (YAML front matter) plus `bookmarks.jsonl` for
  local RAG.
- Search (`q`) spans text, author, AI summary, linked-page text, and topic
  names; whitespace-separated terms are ANDed.
- Short bookmark ids: every card shows a `#k7f3` chip (click to copy, with a
  `copied` flash). The id is stored in `bookmarks.ref`, generated on insert and
  backfilled for older rows. `GET/DELETE /api/bookmarks/:id` and `shelf show`
  accept a ref, a tweet id, or an x.com URL. Refs are 5 chars from an alphabet
  without `0/o/1/l/i` and always contain a letter, so they never look like the
  all-digit tweet ids.

### API

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/bookmarks?q=&topic=&label=&day=&view=&source=&limit=&offset=` | list; `day=YYYY-MM-DD` limits to one saved day; `label=<slug>` narrows to one label; `view=active|archived|all` (default active); `source=x|linkedin|youtube` (default `all`, unknown values fall back to `all`) filters on the canonical URL host; `q` terms are ANDed and match text, author, both summaries, links, topic names and label names |
| `POST` | `/api/posts` | `{ format: "markdown"\|"html", content, title?, summary?, sourceUrl?, clientId?, ref?, agent?, labels? }` creates an agent note (`kind=note`, no fetch, no AI summary job); the same `clientId` updates one row and `ref` updates an existing note in place; `labels` is an array or a comma-separated line and a re-post adds to the note's set rather than replacing it; content caps are 256 KB markdown / 1 MB HTML |
| `POST` | `/api/bookmarks` | `{ "url": ... }`; X, LinkedIn, YouTube, or any public http(s) page (`provider=web`, title and readable body stored in `article`); also accepts `SHARE_TOKEN` bearer |
| `GET` | `/api/bookmarks/:id` | one bookmark by short ref (`k7f3`) or tweet id |
| `DELETE` | `/api/bookmarks/:id` | delete by short ref or tweet id |
| `POST` | `/api/bookmarks/:id/archive` | `{ "archived": true }` archives; `false` restores. Accepts a ref |
| `POST` | `/api/bookmarks/:id/summarize` | `{ "mode": "version", "instruction": "..." }` adds a version; `{ "mode": "translate" }` queues English |
| `POST` | `/api/translations/en` | queue English for every finished summary that lacks it |
| `GET` | `/api/topics` | topics with syntheses and counts |
| `GET` | `/api/labels` | labels in use with counts, most carried first, capped at 24 |
| `PUT` | `/api/bookmarks/:id/labels` | `{ "labels": ["reading", "design"] }` or `{ "labels": "reading, design" }`; replaces the set, `[]` clears it. Returns `{ bookmark }` |
| `DELETE` | `/api/bookmarks/:id/labels/:slug` | removes one label from one post. Returns `{ bookmark }` |
| `GET` | `/api/calendar?month=YYYY-MM` | save counts per UTC day for one month (defaults to the current month) |
| `POST` | `/api/reindex` | re-induce the whole taxonomy |
| `GET` | `/api/stats` | `total`, `archived`, `summarized`, `translated`, `pending`, `topics`, `bytes`, `rows` |
| `GET` | `/healthz` | no auth |

## 4. Measured state (2026-11-07)

- 35 bookmarks, 7 topics, 45 topic links, 1 summary version
- SQLite database: 540 KB (~15 KB per bookmark)
- Free-tier ceilings: 100k Worker requests/day, 10 ms CPU, 100k DO requests/day,
  13,000 GB-s/day, 5 GB storage. Usage is far below all of them; the only real
  risk is the 10 ms CPU cap on very large pages.

## 5. Timeline / decisions

| When | What | Why |
|---|---|---|
| Nov 6 | Worker + SQLite DO + FxTwitter + OpenCode summaries | Minimum infra, no Docker/tunnel |
| Nov 6 | Silent share APK | Brave does not create WebAPKs, so PWA share targets never appeared |
| Nov 6 | External link reading (GitHub + readability) | Posts were mostly comments on links |
| Nov 7 | Topic engine + rolling syntheses | The archive should accumulate knowledge, not rows |
| Nov 7 | Summary versions | "Summarize again" was destructive |
| Nov 7 | UI: collapsed cards, tabs in library, in-place swap | Mobile usability |
| Nov 7 | TS migration (TS 7.0.2 native) | Type safety as state grew |
| Nov 7 | Custom domain | Cleaner URL, APK rebuilt against it |
| Nov 7–10 | Motion digest experiments (v1–v5) | Monthly/Offprint-style artifact, eventually narrated |
| Nov 10 | `shelf` CLI + MCP server | Saved posts must be usable inside local AI chats, not only in the browser |
| Nov 10 | Short `#ref` ids on cards, copy on click | "look at this one" needs a handle shorter than a 19-digit tweet id |
| Nov 10 | Archive toggle + bilingual summaries | Finished posts should leave the feed without being deleted; the same summaries should be readable in English |
| Nov 10 | Calendar + single-day library view | Finding what was saved on a date should not require scrolling the whole feed |
| Nov 11 | Workers AI as the default summarizer, any OpenAI-compatible endpoint as the upgrade | Deploying needed a third-party key before the first summary; the AI binding was already bound for Whisper |
| Nov 11 | Piped as the default YouTube caption source, no key | Supadata needs a signup and a 100-credit ceiling; a fresh deploy should read captions immediately |
| Nov 11 | README replaced by an agent install prompt + `INSTALL.md` | Nobody installs a Cloudflare Worker by hand; an agent needs a checklist it can execute |
| Nov 11 | LinkedIn posts saved through the guest page | The same share sheet should work for posts people send from LinkedIn, without a LinkedIn developer app |
| Nov 11 | Renamed to **Shelf** everywhere: UI, PWA, CLI, repo, Worker script, Android package | The archive already holds LinkedIn posts, and the name was narrower than the product. Durable Object storage belongs to the script, so the 52-bookmark archive moved through a temporary `GET /api/dump` -> `POST /api/restore` into the new `shelf` Worker (verified row for row) before the old script was deleted. The Android package id changed too, so the share APK installs as a new app |
| Nov 11 | Bookcase app icon; `shelf.nuritas.tr` | The old mark was an X bookmark. The new one is a bookcase with a leaning book, laid out for the maskable safe zone; the old hostname stays attached so installed apps and links keep working |
| Nov 11 | Android app opens in-app: launcher entry on a WebView, not a browser hop | The share APK had no `MAIN`/`LAUNCHER` filter at all, so tapping it did nothing. `MainActivity` now shows the library in a WebView, links to other sites go to the browser, and the share target still saves silently |
| Nov 11 | Android app follows the system theme and keeps the session | The WebView forced `Theme.Light`, so the site rendered light on a dark phone, and the launch window drew under the status bar. A `values`/`values-night` theme pair fixes the scheme, window insets keep the header clear, and the cookie jar is flushed after login and on pause |
| Nov 11 | Share saves silently again: one toast, no card | The card that replaced the toast was too heavy for a share action. The share keeps its own task affinity (so the library does not pop up), extracts any link, expands t.co, and reports with a single toast |
| Nov 11 | YouTube links save as bookmarks | Pasting `youtu.be/...?si=` failed because the save path only knew X and LinkedIn. `src/youtube.ts` reads oEmbed plus the watch page (title, channel, description, thumbnail) and stores `provider = 'youtube'`; the existing transcript ladder then feeds the summary |
| Nov 13 | Native apps moved to `nuuritas/shelf-cloud`; this repository ships published builds only | The maintainer signs and distributes every build, so the app trees, the keystore and the release workflow belong with the service that ships them; an MIT repository should not license the app source by accident. The clients stay dual-mode, so one published APK or TestFlight build still works against any self-hosted Worker |
| Nov 16 | Labels ported from Shelf Cloud (#183) | Topics are folders the AI fills; a label is a word a person types. The library reads the same shelf by that cut, cards link to it, and an agent can tag a note through `POST /api/posts` / `shelf add --label`. Slug-keyed in SQLite, unused labels dropped |
| Nov 16 | One control row per card, and coloured labels | The footer repeated the source link the head already carried and printed reply/repost/like/view counts nobody reads, plus a JSON link that the API still answers. Archive and Remove became buttons in the head beside the source link, and a label chip now takes one of six tones hashed from its slug |

### Video transcripts

X videos are read from the lowest-bitrate MP4 variant. Whisper accepts the MP4
directly, so the Worker does not need ffmpeg or a separate download service.
A 60-second Turkish clip transcribed in about 5 seconds; a 5.7-minute English
clip took about 40 seconds and produced 6.4k characters. The model auto-detects
the language, and the summary prompt treats the transcript as the record of what
was actually said.

YouTube is different: the watch page returns HTTP 429 to Worker IPs, and every
Innertube client (Android, iOS, TV, mobile web, desktop web, embedded) returns
`LOGIN_REQUIRED` with "Sign in to confirm you're not a bot". Direct timedtext is
empty without a signature. Supadata's `mode=native` returns existing captions
for 1 credit (100 free per month); generated transcripts at 2 credits/minute
are intentionally not used.

The keyless path arrived later: a public Piped instance returns the stream's
subtitle tracks, and `src/transcript.ts` fetches the chosen track as WebVTT
(`fmt=ttml` → `fmt=vtt`) and strips the cue markup. Piped publishes no quota and
sends no rate-limit headers; it is a volunteer-run server, so the code treats it
as best-effort and walks a short ladder of instances. Two defaults
(`api.piped.private.coffee`, `pipedapi.ducks.party`) worked on 2026-11-11;
several others tested were down. `PIPED_API_URL` overrides the ladder, and
`off` disables the path.

A `TRANSCRIPT_API_URL` template is tried first, so any third-party or
self-hosted caption source can be plugged in without touching the Worker: JSON
(`text`, `transcript`, `content`), WebVTT, SRT, and plain text are all accepted.
For a zero-cost path, `shelf youtube` reads captions on this Mac's residential
IP — through `out/yt/fetch.sh` (yt-dlp, no key or account, cached by video id)
when that wrapper is installed, otherwise through `get-youtube-transcript` — and
then posts the result to `/api/bookmarks/:id/transcripts`. The
DO stores it and re-queues the summary. It is manual or scheduled, not part of
the Worker request path. Without a key, captions, or a local sync, the summary
uses the post and page text.

Known limits: 20 MB per video (about 8 minutes at 256 kbps), two videos per
bookmark. Long videos would need an external transcoder. Re-summarizing an
existing bookmark backfills its transcript because `transcripts_json` starts
empty for rows saved before this feature.

### Video digest pipeline (experiments, not in the app yet)

1. Pull `/api/bookmarks`, pick items, write a narration (one continuous story).
2. Split into beats; synthesize each with `edge-tts --voice tr-TR-EmelNeural`
   (online, free, no key). Measure each clip with `ffprobe`.
3. Build one 1080×1920 HTML slide per beat, carrying the spoken paragraph.
4. Screenshot each slide with headless Brave over CDP.
5. Encode per-beat clips with `ffmpeg` `zoompan` (slow zoom), concat, pad each
   audio segment by 0.45 s, concat audio, mux with a `mov_text` subtitle track.
6. Artifacts land in `out/` (gitignored).

Iterations: v1 headline cards → v2 slides + macOS `say` → v3 Microsoft neural
voice → v4 single essay but too abstract → v5 factual narration (mechanisms,
dates, numbers). v5 is 101 s.

Lessons: the first failure mode is not voice quality but a script that sounds
like a keynote and explains nothing. Concrete nouns and numbers are the fix.

## 6. Known issues and traps

- **CSS caching**: `/style.css` used `max-age=3600`; new markup rendered with
  old CSS looked unstyled. Now `no-cache` plus a `?v=` query on the link — bump
  the version when the stylesheet changes.
- **DO type blow-up**: importing `SqlStorage`/`DurableObjectState` from
  `@cloudflare/workers-types` while extending `DurableObject` from
  `cloudflare:workers` makes tsc compare two recursive interfaces forever
  (GBs of RAM). Derive them from the base class instead
  (`ConstructorParameters<typeof DurableObject<Env>>`).
- **Local OpenCode key is expired**; the production secret still works. Local
  `cf dev` summaries fail while that expired key is set, because a set key
  selects the HTTP path; unset it and the `AI` binding takes over.
- **Topic singletons**: some topics hold one item, so their "synthesis" is a
  restatement. Candidate fix: merge or suppress single-item syntheses.
- **Some summaries open with "Özet:"**, the old robotic style. Re-summarizing
  fixes individual rows.
- **Video transcripts are capped at 20 MB and two per bookmark.** Whisper runs
  on the MP4 bytes; the Worker cannot extract audio from larger files. YouTube
  captions come from Piped by default (native captions only) and from Supadata
  when `SUPADATA_API_KEY` is set.
- **LinkedIn is guest-page only.** There is no post API without a LinkedIn app,
  so `src/linkedin.ts` reads the public HTML. Members-only, deleted, or
  logged-in-only posts save with empty text, and the meta tags can change
  without notice. Do not add cookie or session handling to read more.
- **YouTube proxy/VPS checks (2026-11-11)**: a VPS and several commercial
  proxy providers (direct and rotating) all return 429 or `LOGIN_REQUIRED`;
  some backbone ports refuse connections outright, and residential egress was
  not available from those providers. Only a residential connection works,
  which is what the hourly `shelf youtube` run uses.
- **Video pipeline is not committed** — it lived in `/tmp`, which this machine
  cleans. Recreate it under `video/` before relying on it.
- **TTS is online**: edge-tts sends the script to Microsoft. Local options
  evaluated: Piper (works, flatter), F5-TTS Turkish (needs a 5–10 s reference
  clip), Orpheus 3B (best, heavy).
- **`/tmp` is ephemeral** on this machine; put durable artifacts in `out/`.

## 7. Open work

- Daily digest: `/digest/YYYY-MM-DD` page with an AI "summary of summaries",
  grouped links, print CSS for PDF, and optionally the video.
- Monthly/Offprint-style compilation.
- Local TTS A/B: F5-TTS vs Emel (needs a reference recording).
- Music bed and sentence-level caption timing for the video.
- Optional `GET /api/export` for a full JSON backup.
- Merge or hide single-item topics.
- Topic syntheses are never translated: they are written in the summary
  language, and the English board translates bookmark summaries, not the rolling
  topic syntheses.
- Summary versions are written in the summary language and are not translated;
  only the primary summary has an English counterpart.
- iOS share extension: shipped. The app and the Android client live in the
  maintainer's private `nuuritas/shelf-cloud/apps` and are distributed as signed
  builds, so iPhone users share into **Shelf** exactly like Android users do.
  Both post to the same `POST /api/bookmarks` endpoint.

## 8. Repo conventions

- TypeScript strict, `.ts` import specifiers, no build step; `cf deploy` bundles
  (through Wrangler) and uploads.
- One feature per issue and PR, imperative commit subject, tests and
  `bun run typecheck` before pushing. The PR body starts with `Closes #N`; direct
  pushes to `main` are emergency-only.
- Never commit `.dev.vars`, `.cloudflare/`, or `out/`. Mobile builds and their
  signing material live in `nuuritas/shelf-cloud/apps`.
- The README stays short and leads with the agent install prompt; install
  details live in `INSTALL.md`, which must stay executable by an agent (exact
  commands, per-step acceptance checks).
