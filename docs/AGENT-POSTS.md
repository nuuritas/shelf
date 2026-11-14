# Agent posts: writing a note into Shelf

This is the contract for AI agents that add a research note to a Shelf archive.
A note is content **you wrote** and saved — not a URL you found. To save someone
else's page, use a normal link save (`POST /api/bookmarks`); Shelf fetches and
reads that page itself.

One source of truth: this file. `shelf guide` prints it, `shelf add --help`
points at it, and the MCP server exposes it as `get_authoring_guide`.

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
| `agent`     | `{ name, model, tool }`; shown on the card as `Written by …`. |

Attribution is mandatory in spirit: never present a note as a human's writing.

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
- Support light and dark: use `prefers-color-scheme` and avoid fixed white
  backgrounds.
- No invented citations. Link real sources and list them at the end.

Shelf stores the document after best-effort sanitation and serves it from
`/p/<ref>/frame` with a strict CSP inside `<iframe sandbox>`. The sandbox and CSP
are the security boundary; the sanitizer is defense in depth. A note that tries
to break out is still rendered inert, but it will look broken.

## API

```http
POST /api/posts
Authorization: Bearer <APP_PASSWORD>
Content-Type: application/json

{
  "format": "markdown",
  "content": "## Findings\n\n- …",
  "title": "How agent memory works",
  "summary": "Short abstract.",
  "sourceUrl": "https://example.com/primary-source",
  "clientId": "research-agent-memory-2026-11-13",
  "agent": { "name": "Claude Code", "model": "claude-sonnet-4.5", "tool": "claude-code" }
}
```

Returns `{ created, bookmark }` with 201 (new) or 200 (updated by `clientId` or
`ref`). A `ref` that is not a note returns 404; a missing or malformed one returns
400. Updating with `ref` replaces the body, title, summary and source, so send
the fields you want to keep.
`SHARE_TOKEN` is not accepted here; it is add-only for URL saves.

## CLI

```bash
shelf add ./research.md --title "How agent memory works" \
  --agent "Claude Code" --model "claude-sonnet-4.5" --tool "claude-code"

cat note.md | shelf add - --title "Daily notes" --client-id daily-2026-11-13
shelf add ./revision.html --ref xqajj --summary "Revised for phone reading."
```

- Reads a path or `-` from stdin; infers markdown/HTML from the extension.
- `--format markdown|html` wins over the extension.
- `--summary`, `--source-url`, `--client-id`, `--ref`, `--json` are also accepted.

## MCP

Call `create_post` with the same fields. Only call it when the user explicitly
asks to save, publish, or keep a research result. Prefer markdown; use HTML only
for visuals. Say what you saved and include its short ref.

`get_authoring_guide` returns this document for clients that cannot fetch URLs.

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
      body { font-family: system-ui, sans-serif; margin: 24px; color: #1c1a17; }
      @media (prefers-color-scheme: dark) { body { background: #1d1b18; color: #f4f0e8; } }
      .bar { height: 12px; border-radius: 6px; background: #c24a22; }
    </style>
  </head>
  <body>
    <h1>Latency budget</h1>
    <p>Read path, p95, milliseconds.</p>
    <div class="bar" style="width: 60%"></div>
  </body>
</html>
```

## Security

Notes use the same password as the rest of Shelf. HTML is treated as untrusted:
it is stored sanitized, served with `default-src 'none'` plus inline styles and
`https:`/`data:` images only, and rendered in an iframe with
`sandbox` (no scripts, no same-origin, no forms, no popups). Never put secrets in
a note: it is still your private archive, but the content is model-written.
