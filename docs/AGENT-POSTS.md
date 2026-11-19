# Agent posts: writing a note into Shelf

This is the contract for AI agents that add a research note to a Shelf archive.
A note is content **you wrote** and saved — not a URL you found. To save someone
else's page, use a normal link save (`POST /api/bookmarks`); Shelf fetches and
reads that page itself.

One source of truth: this file. `shelf guide` prints it, `shelf add --help`
points at it, `get_authoring_guide` returns it over MCP, and Shelf Cloud serves it
at `https://shelfcloud.io/agent-posts.md` — one document through four doors, so a
client with no CLI and no MCP client still reads the contract.

## Markdown or HTML?

- **Markdown** for text research: findings, summaries, comparisons, code, tables.
  It is readable everywhere, searchable, and safe. Prefer it.
- **HTML** only when layout or visuals matter: a chart drawn in inline SVG, a
  diagram, a designed one-pager. It is shown inside a sandboxed iframe on its
  own page (`/p/<ref>`); scripts never run. The library card shows its title,
  abstract and topics, never the document itself, so write a `summary` for an
  HTML note.

If you are unsure, write markdown.

## Metadata

| Field       | Notes |
| ----------- | ----- |
| `title`     | Optional; defaults to the first heading/line. Max 200 characters. |
| `summary`   | Optional 1–3 sentence abstract, stored as agent-written. Max 4,000 characters. No AI call is made for it. It is the card's abstract, and the only body copy an HTML note shows in the library. |
| `sourceUrl` | Optional primary source; must be `http(s)`. Do not repeat every citation here. |
| `clientId`  | Optional stable id. Re-posting with the same value updates that one note and keeps its ref. Use it when retrying. |
| `ref`       | Optional short ref of an existing note (`POST` only). Updating by ref keeps the note's link and wins over `clientId`. Use it to revise a note you no longer have a `clientId` for. |
| `agent`     | `{ name, model, tool }`; shown on the card as `Written by …`. `name` is the harness that wrote the note (OpenCode, Claude Code, Codex, Cursor), `model` is the model that wrote the words, and `tool` is the program that filed it (`shelf-cli` or `shelf-mcp`). |
| `labels`    | Optional tags the reader can filter by. An array (`["reading","design"]`) or one comma-separated line (`"reading, design"`). Up to 12, each 40 characters. A label is the reader's own word, not a folder; the same note can carry several. Re-posting a note adds the labels it carries and never drops the ones already there. |

Attribution is mandatory in spirit: never present a note as a human's writing.
Shelf is the archive; Shelf CLI and Shelf MCP are the transport. Neither wrote
the note, so neither may be the `agent.name` — name the harness that did, and
the model it ran. If the harness runs for a person, their handle may be the
name instead (`n8hgq`), with the model as the provider wrote it
(`@deepseek-v4.1-flash`). An old CLI that sends `"name": "Shelf CLI"` or
`"Shelf MCP"` is recorded as unattributed rather than credited.

Label a note only when the label is a real word the reader would use; do not
invent a taxonomy of your own and do not tag a note the author already labelled.

## Limits and errors

- Markdown body: **256 KB**. HTML body: **1 MB**. Title: **200** characters.
  Summary: **4,000** characters.
- `format` must be `markdown` or `html`; content must not be empty.
- Errors are plain JSON `{ "error": "..." }` with HTTP 400:
  - `format must be "markdown" or "html".`
  - `content is required.`
  - `markdown content is limited to 256 KB (got N KB).`
  - `sourceUrl must be an http(s) URL.`

## HTML contract

Write a complete, self-contained document:

- Inline `<style>` and inline SVG only. No external CSS, JS, fonts, or images
  (images: `https:` or `data:` only).
- No `<script>`, no event attributes (`onclick=…`), no `javascript:` URLs.
- No forms, inputs, buttons, `<iframe>`, `<object>`, `<embed>`, or
  `<meta http-equiv="refresh">`.
- Responsive and accessible: semantic headings, alt text, sufficient contrast.
- Two colour options — white and dark — chosen inside the document,
  with the app's own palette. See **Colour and themes** below.
- No invented citations. Link real sources and list them at the end.

Shelf stores the document after best-effort sanitation and serves it from
`/p/<ref>/frame` with a strict CSP inside `<iframe sandbox>`. The sandbox and CSP
are the security boundary; the sanitizer is defense in depth. A note that tries
to break out is still rendered inert, but it will look broken.

## Colour and themes

A note is read inside the app, in a frame that cannot see which theme the app is
in. So the note carries its own choice — and it borrows the app's colours instead
of inventing a palette. A document in its own colours looks pasted in; a document
in ours disappears into the page, which is the point.

### Ship two options

White and dark, switched by a small control at the top of the document.

- **White** is the default: the app's white sheet, the light ink on `#ffffff`.
- **Dark** is the app's dark theme, token for token — not a near-black chosen by
  eye. A warm or grey "dark" beside the app's blue-black one reads as a different
  product.

Two, not three. A third "light" beside white is the same intent painted twice,
and the reader has to compare two pale sheets to find the one they want.

### The palette

Both services share one brand block — `src/brand.ts` in `nuuritas/shelf` and in
`shelf-cloud`, mirrored in the Android and iOS clients — so these values are the
same everywhere. Read that file rather than sampling a screenshot.

| Token | White | Dark | Paints |
| --- | --- | --- | --- |
| `--paper` | `#ffffff` | `#0d1117` | page background |
| `--card` | `#fbfcfd` | `#151b23` | cards, panels, stat cells |
| `--ink` | `#0f1720` | `#e8eef5` | body text |
| `--ink-soft` | `#33404f` | `#c3cdd8` | secondary text |
| `--soft` | `#5a6775` | `#97a3b1` | captions, meta, labels |
| `--rule` | `#e6ebf1` | `#232b35` | hairlines and borders |
| `--rule-strong` | `#c3ccd8` | `#323c48` | emphasised borders |
| `--accent` | `#1d4ed8` | `#7da2ff` | links, numbers, markers |

White is a pure sheet carrying the light ink, so a printed note and a note on a
plain screen look the same. Its card sits a shade off the paper — `#fbfcfd` on
`#ffffff` — because a white card on white paper loses its edge.

For a rule that should be softer than `--rule`, pick a value one step toward the
paper (`#f2f5f8` in white, `#1c242c` in dark) rather than blending with
`color-mix`: the frame is opaque, so a blend computed against the wrong
background is the seam you were trying to remove.

### Do not key off the media query

`prefers-color-scheme` means different things on the two surfaces that read a
note. On the web — the hosted service and the self-hosted Worker — it is the
operating system's. Shelf Cloud ignores it and stays light until the reader picks
dark in Settings. The self-hosted Worker defaults to `system`, so its first paint
can go either way. The frame cannot read the parent's `data-theme` either. In the
phone apps it is the app's: the iOS client sets the page's
`overrideUserInterfaceStyle` from the look, and the Android client builds the
note's `WebView` in a night-mode context. A document cannot tell which one it is
in.

White as the default, plus a visible choice, is the only version that lands
correctly on both.

### The control

Scripts never run, and the sanitizer strips `<form>`, `<input>`, `<button>`,
`<select>` and `<textarea>`, so a radio group is not available. Open and closed on
`<details>` is native behaviour with no script, `:has()` reads it, and the `name`
attribute makes the group exclusive. That is the whole mechanism:

```html
<div class="themes">
  <details class="sw" id="th-white" name="theme"><summary>White</summary></details>
  <details class="sw" id="th-dark" name="theme"><summary>Dark</summary></details>
</div>
```

```css
body { /* white tokens: the default */ }

body:has(#th-dark[open]) { /* dark tokens */ color-scheme: dark; }

.sw > summary { cursor: pointer; list-style: none; }
.sw > summary::-webkit-details-marker { display: none; }
```

Declare the theme on `body`, not on `:root`: the chosen block has to beat the
`:root` default for every descendant, and a `body` rule does that without
`!important`. White needs no block — it is the default, so closing the group
returns to it.

Do not use `:target` for this. A fragment link resets the target, so the theme
falls off the moment the reader clicks a footnote or a source marker.

## API

```http
POST /api/posts
Authorization: Bearer <token>
Content-Type: application/json

{
  "format": "markdown",
  "content": "## Findings\n\n- …",
  "title": "How agent memory works",
  "summary": "Short abstract.",
  "sourceUrl": "https://example.com/primary-source",
  "labels": ["reading", "design"],
  "clientId": "research-agent-memory-2026-11-13",
  "agent": { "name": "OpenCode", "model": "DeepSeek v4.1 Flash", "tool": "shelf-cli" }
}
```

Returns `{ created, bookmark }` with 201 (new) or 200 (updated by `clientId` or
`ref`). A `ref` that names no note is 404, a malformed one 400, and an absent one
is simply no ref — the request creates a note. An update replaces the body, title,
source and agent credit, adds the labels it carries, and keeps the summary
already on the note unless the update sends one.
`<token>` is the credential your client already holds: `APP_PASSWORD` on a
self-hosted Worker, the token `shelf login` saved on Shelf Cloud.
`SHARE_TOKEN` is not accepted here; it is add-only for URL saves.

## CLI

```bash
shelf add ./research.md --title "How agent memory works" \
  --agent "OpenCode" --model "DeepSeek v4.1 Flash"

cat note.md | shelf add - --agent "Claude Code" --model "claude-sonnet-4.5" \
  --title "Daily notes" --client-id daily-2026-11-13
shelf add ./revision.html --agent "OpenCode" --model "DeepSeek v4.1 Flash" \
  --ref xqajj --summary "Revised for phone reading."
```

- Reads a path or `-` from stdin; infers markdown/HTML from the extension.
- `--agent` is required: the harness that wrote the note, not Shelf CLI. Set
  `SHELF_AGENT` and `SHELF_AGENT_MODEL` once to use the same attribution on
  every call.
- `--format markdown|html` wins over the extension.
- `--model` names the model that wrote the words; `--tool` defaults to
  `shelf-cli`, because that is the program that filed it.
- `--summary`, `--source-url`, `--client-id`, `--ref`, `--label`, `--json` are
  also accepted.

## MCP

Two servers expose the same tools: `shelf mcp` over stdio, and each service's
`POST /mcp` over Streamable HTTP, authenticated with the same bearer token the
rest of the API takes. Point a remote client at `https://<host>/mcp`.

Call `create_post` with the same fields, including `agent.name` (your harness,
e.g. `OpenCode`) and `agent.model` (e.g. `DeepSeek v4.1 Flash`); `agent.name`
is required. Only call it when the user explicitly asks to save, publish, or
keep a research result. Prefer markdown; use HTML only for visuals. Say what
you saved and include its short ref. Shelf MCP only moves the note, so it must
not be the name on it. The stdio server (`shelf mcp`) falls back to
`SHELF_AGENT` and `SHELF_AGENT_MODEL` when the call omits them; the hosted
`/mcp` endpoint refuses a call without `agent.name`.

`get_authoring_guide` returns this document, so a client that cannot fetch a URL
reads the same words. Shelf Cloud also serves it at
`https://shelfcloud.io/agent-posts.md`.

## Examples

Minimal markdown note:

```markdown
## What I found

Three papers converge on **bounded memory windows** for long-running agents.

1. Retrieval beats a longer prompt.
2. Summaries must be refreshed, not trusted forever.

Sources:
- https://example.com/paper-a
```

Minimal HTML note:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Latency budget</title>
    <style>
      body {
        --paper: #ffffff; --card: #fbfcfd; --ink: #0f1720;
        --ink-soft: #33404f; --soft: #5a6775; --rule: #e6ebf1;
        --rule-strong: #c3ccd8; --accent: #1d4ed8;
        font-family: system-ui, sans-serif; margin: 24px;
        background: var(--paper); color: var(--ink);
      }
      body:has(#th-dark[open]) {
        --paper: #0d1117; --card: #151b23; --ink: #e8eef5;
        --ink-soft: #c3cdd8; --soft: #97a3b1; --rule: #232b35;
        --rule-strong: #323c48; --accent: #7da2ff;
        color-scheme: dark;
      }
      .themes { margin: 0 0 16px; }
      .sw > summary { cursor: pointer; list-style: none; }
      .sw > summary::-webkit-details-marker { display: none; }
      .bar { height: 12px; border-radius: 6px; background: var(--accent); }
    </style>
  </head>
  <body>
    <div class="themes">
      <details class="sw" id="th-white" name="theme"><summary>White</summary></details>
      <details class="sw" id="th-dark" name="theme"><summary>Dark</summary></details>
    </div>
    <h1>Latency budget</h1>
    <p>Read path, p95, milliseconds.</p>
    <div class="bar" style="width: 60%"></div>
  </body>
</html>
```

## Security

Notes use the same credential as the rest of the shelf. HTML is treated as untrusted:
it is stored sanitized, served with `default-src 'none'` plus inline styles and
`https:`/`data:` images only, and rendered in an iframe with
`sandbox` (no scripts, no same-origin, no forms, no popups). Never put secrets in
a note: it is still your private archive, but the content is model-written.
