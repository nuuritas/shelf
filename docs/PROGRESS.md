# Project knowledge — X Bookmark Vault

Last updated: 2026-11-10
Repository: <https://github.com/nuuritas/x-bookmark-vault> (private)
Live: <https://bookmark.nuritas.tr> (fallback: <https://x-bookmark-vault.nuuritas.workers.dev>)

This file is the long-form memory of the project: what exists, why it works
this way, what was tried, and what is still open. `AGENTS.md` is the short
operating guide for coding agents; this is the context behind it.

## 1. What the product is

A single-user archive for X (Twitter) posts. A link is shared from Android —
one tap, no app window — and the post is saved, read, and explained by an AI.
Over time the archive organizes itself into topics and writes its own rolling
syntheses, so it behaves less like a list of bookmarks and more like a small
knowledge base.

Non-goals so far: multi-user accounts, public sharing, a native iOS app.

## 2. Architecture

```
Android share sheet
      │  ACTION_SEND (text/plain)
      ▼
BookmarkShare.apk  ──POST /api/bookmarks (Bearer SHARE_TOKEN)──┐
                                                               │
Browser / PWA ──session cookie──► Worker (src/worker.ts) ◄─────┘
                                      │
                                      │ env.BOOKMARKS
                                      ▼
                          Durable Object "library"
                          SQLite: bookmarks, topics,
                          item_topics, summary_versions
                                      │
                                      ├─ FxTwitter / official X API (read post)
                                      ├─ GitHub API + readability (read links)
                                      └─ OpenCode Go (summaries, topics, versions)
```

- **Worker** is stateless: auth, routing, server-rendered HTML.
- **Durable Object** `library` is the whole database. One instance by design:
  single user, serialized writes, local SQL joins, no extra binding.
- **Static assets** live in `public/` and are served by Cloudflare.
- **SSR was chosen deliberately**: one rendering path, no client framework,
  works without JS, auth checked before any HTML is produced. Client JS only
  enhances (expand cards, fold synthesis, swap topic content in place).

### Data model

| Table | Purpose |
|---|---|
| `bookmarks` | One row per X post: text, author, media JSON, quote JSON, article JSON, links JSON, metrics, `summary`, `summary_status`, topic and version job state |
| `topics` | AI-induced areas of interest: `slug`, `name`, `description`, `overview` (rolling synthesis), `overview_count` |
| `item_topics` | Many-to-many filing, with confidence |
| `summary_versions` | v2+ summaries, each with the instruction that produced it. v1 lives in `bookmarks.summary` |

Schema evolution is idempotent: `CREATE TABLE IF NOT EXISTS` plus `ALTER TABLE`
inside `try { } catch { }` in the DO constructor.

### Jobs

Everything asynchronous runs through one DO alarm queue, one unit of work per
pass, in priority order:

1. summarize a pending bookmark (`summary_status = 'pending'`)
2. generate a requested summary version (`version_status = 'pending'`)
3. if the archive has ≥3 summarized items and no topics, bootstrap topics
4. file a summarized item into topics (`topics_status = 'pending'`)
5. rewrite one stale topic synthesis (`overview_count` ≠ item count)

Each step re-arms the alarm if more work remains. AI calls wait on network, so
wall-clock is long but CPU stays low.

## 3. Features that exist

- Silent Android share (APK, translucent activity, Toast, auto-finish)
- PWA shell with service worker (share target works on Chrome, not Brave)
- AI summary: natural Turkish prose, 3–5 paragraphs; reads images as base64,
  X Article bodies, quoted posts, and up to two external links
- Topic induction + per-item filing + rolling per-topic synthesis
- Summary versions: "New version" with an optional instruction; original is
  never overwritten
- Topic tabs that swap only the library region over `fetch`, preserving scroll
- Collapsed cards (3-line peek, expand on tap) and folded topic syntheses
- Custom domain `bookmark.nuritas.tr`, workers.dev kept as fallback
- `/api/stats` reports row counts and real SQLite database size
- Local access for AI work: `cli/xbv.ts` (search/show/topics/export) and
  `xbv mcp`, a stdio MCP server exposing `search_bookmarks`, `get_bookmark`,
  `list_topics`, `get_topic`. Read-only; the Worker stays the source of truth,
  nothing is mirrored. `xbv export` writes one markdown file per bookmark
  (YAML front matter) plus `bookmarks.jsonl` for local RAG.
- Search (`q`) spans text, author, AI summary, linked-page text, and topic
  names; whitespace-separated terms are ANDed.

### API

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/bookmarks?q=&topic=&limit=&offset=` | list; `q` terms are ANDed and match text, author, summary, links, and topic names |
| `POST` | `/api/bookmarks` | `{ "url": ... }`; also accepts `SHARE_TOKEN` bearer |
| `GET` | `/api/bookmarks/:id` | one bookmark |
| `DELETE` | `/api/bookmarks/:id` | delete |
| `POST` | `/api/bookmarks/:id/summarize` | `{ "mode": "version", "instruction": "..." }` adds a version |
| `GET` | `/api/topics` | topics with syntheses and counts |
| `POST` | `/api/reindex` | re-induce the whole taxonomy |
| `GET` | `/api/stats` | `total`, `summarized`, `pending`, `topics`, `bytes`, `rows` |
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
| Nov 10 | `xbv` CLI + MCP server | Saved posts must be usable inside local AI chats, not only in the browser |

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
  `wrangler dev` summaries will fail until `.dev.vars` gets a fresh key.
- **Topic singletons**: some topics hold one item, so their "synthesis" is a
  restatement. Candidate fix: merge or suppress single-item syntheses.
- **Some summaries open with "Özet:"**, the old robotic style. Re-summarizing
  fixes individual rows.
- **Videos are not transcribed**; only the poster image reaches the AI.
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

## 8. Repo conventions

- TypeScript strict, `.ts` import specifiers, no build step; Wrangler bundles.
- One feature per commit, imperative subject, tests and `bun run typecheck`
  before pushing.
- Never commit `.dev.vars`, the keystore, or `public/BookmarkShare.apk`
  (it embeds `SHARE_TOKEN`).
