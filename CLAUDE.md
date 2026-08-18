# MarkAI

Local web app for annotating documents (MD / PDF / DOCX) and exporting the notes in a compact,
AI-friendly format so an external coding agent can apply them to the source. Single user for now,
built to be deploy-ready later. Flask backend, vanilla JS/CSS frontend, SQLite storage.

Read this file before making changes — it captures decisions and gotchas that aren't obvious from
the code alone. Update it when you make a structural change or fix something non-obvious.

## Run it

```bash
cd MarkAI
.venv/Scripts/python run.py    # http://localhost:5000, debug=True
```

Deps: `Flask`, `python-docx`, `markdown` (see `requirements.txt`). `.venv` already exists; if not,
`python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt`.

`.claude/launch.json` is configured for the `preview_start` tool (name `markai`, port 5000).
**Flask's debug reloader spawns a child process that `preview_stop` doesn't always kill** — if you
get "port 5000 already in use" on the next `preview_start`, find and kill leftover
`.venv\Scripts\python.exe .\run.py` processes first (`Get-CimInstance Win32_Process -Filter
"name='python.exe'"` on Windows) before retrying.

There's a git repo (`git log` → one commit, "first commit") with **uncommitted changes** from the
last round of fixes as of this writing — check `git status` before assuming the working tree matches
what was last committed.

## Architecture

```
app/
  __init__.py       Flask app factory, config, blueprint registration
  db.py              sqlite3 connection (flask g) + schema (executescript, no migrations/ORM)
  auth.py            register/login/logout, session-based, login_required decorator + g.user
  documents.py       library CRUD, file upload/storage, serves parsed content or raw PDF bytes
  notes.py           notes CRUD, bulk actions, manual export download, sync-status poll endpoint
  sync.py            writes/reads the two files in a document's "source folder"
  settings.py        AI-provider settings CRUD (storage only) + resolve-ai stub endpoint
  ai/base.py         AIProvider ABC — NOT implemented, just an extension point (see below)
  parsers/
    markdown_parser.py   md -> HTML blocks tagged with data-line + heading outline
    docx_parser.py        docx -> HTML blocks tagged with data-paragraph-index + heading outline
    util.py                shared slug/unique-id helper
  templates/          Jinja2, server-rendered (no SPA framework)
  static/css/app.css  hand-written, CSS custom properties, light+dark via prefers-color-scheme
  static/js/
    viewer.js          the big one — rendering, note CRUD, highlighting, PDF handling (~950 lines)
    sync_poll.js        polls /documents/<id>/sync-status every 5s + wires the Refresh button
data/                 gitignored: app.db (sqlite), uploads/<user_id>/<uuid>.<ext>
```

No ORM, no JS framework, no build step. PDF rendering/interaction is 100% client-side via **pdf.js
loaded from cdnjs** (`3.11.174`, both `pdf.min.js` and `pdf.worker.min.js`) — zero Python PDF
dependency; the server just streams the raw file bytes for PDFs.

## Data model (SQLite, see `db.py` for the authoritative schema)

- `users(id, email, password_hash, created_at)`
- `documents(id, user_id, title, doc_type[md|pdf|docx], stored_filename, source_folder, last_status_sync_mtime, last_opened_at, created_at)`
- `notes(id TEXT uuid, document_id, user_id, note_text, status[pending|done], position_json, created_at, updated_at)`
- `ai_providers(id, user_id, name, kind[api|local], base_url, api_key, model, created_at)` — unused, backs the settings page only

## The `position_json` blob — this is the part worth understanding

Every note stores a JSON object with fields that differ slightly by doc type, built **client-side**
in `viewer.js` at click/selection time. Common fields: `type` (`point`|`selection`), `chapter`
(nearest heading text), `heading_path` (array of ancestor headings, root→leaf — this is what makes
the hierarchical export location possible), `context_before`/`context_after` (~150 chars, used only
in the popover preview UI), `quote` (short human/AI-readable snippet — see export section), and for
selections `selected_text`.

Type-specific anchors:
- **MD**: `line_number` (line in the source `.md`, computed server-side by `markdown_parser.py`
  splitting on blank lines — approximate but monotonic), plus `char_offset`/`char_length` (exact
  offset within the rendered block's `.textContent`, used for pixel-precise marker placement and
  `<mark>` wrapping).
- **DOCX**: `paragraph_index` (index into `document.paragraphs` from python-docx) + same
  `char_offset`/`char_length`.
- **PDF**: `page` + `anchor_span_index` (index into that page's `pdf.js` text-layer `<span>` list, in
  DOM order — assumed stable across re-renders of the same page since `getTextContent()` returns
  items in consistent order) + `anchor_span_index_end` for selections.

**Backward-compat fallback is load-bearing, not optional.** Notes created before `char_offset` /
`anchor_span_index` existed (or any future note where the stored offset doesn't resolve) fall back
to searching the current text for `selected_text` or `anchor_text` via `indexOf`/`findIndex`. This
logic lives in `locateAnchorInBlock` (md/docx) and `locatePdfAnchor` (pdf) in `viewer.js` — **always
route marker placement and highlighting through these**, never read `char_offset`/`anchor_span_index`
directly, or you'll silently break old notes.

## Highlighting behavior (what a user sees when opening a note)

- MD/DOCX: the whole paragraph (`.doc-block`) gets a `.note-target-block` background tint, and the
  exact word/phrase gets wrapped in a real `<mark class="note-highlight">` (via `Range.surroundContents`,
  wrapped in try/catch since it can throw if the range crosses element boundaries — falls back to
  paragraph-only tint in that case).
- PDF: same idea but can't mutate the PDF content, so it's done with absolutely-positioned overlay
  `<div class="pdf-highlight-box">` elements in a dedicated `.pdf-highlight-layer` (sits between the
  canvas and the — deliberately near-invisible, `opacity:0.2` — text layer used for native
  selection). `.block` class = paragraph tint, `.target` = exact word/selection, `.hover` = live
  hover preview. "Paragraph" for PDF is a heuristic (`computeParagraphs` in `viewer.js`): pdf.js text
  items are grouped into lines by `top` proximity, then lines into paragraphs by detecting gaps
  larger than ~1.6× the median line gap. It's a heuristic, not real structure — expect occasional
  misgrouping on unusual layouts (columns, tables).
- Exactly one highlight is ever active (`activeHighlight` module var + `clearHighlight()`), cleared
  whenever a popover closes.

## Export format (`sync.py`)

Deliberately terse — this was cut down twice already after user feedback that it was too verbose /
burned context. Current shape:

```json
{
  "document": "My Doc",
  "notes": [
    {"id": "...", "status": "pending", "note": "user's note text",
     "location": "Chapter 3 / 3.3 Chunking and pre-processing", "quote": "a few words around the spot"}
  ]
}
```

`location` = `heading_path` joined with `" / "` (full ancestor path, not just the nearest heading).
`quote` = `selected_text` verbatim for selection notes, or a JS-computed "~4 words before + anchor +
~4 words after" snippet for point notes (computed at creation time in `viewer.js`, stored in
`position.quote`). **Do not add fields back to this export without a good reason** — that's the
whole point of the last two rounds of changes.

Two files get written to a document's `source_folder` (if set) on every note mutation:
`<slug>-<id>.notes.json` (the above) and `<slug>-<id>.notes_status.json` (`{id, status}` pairs only
— meant for an external AI agent to flip to `"done"` as it applies fixes). MarkAI reads the status
file back via `check_and_pull_status()` — called before every note create/update (smart pre-mutation
refresh), on manual Refresh click, and on a 5s poll (`sync_poll.js`) while a document is open. A
manual one-off download (independent of source_folder) is available via the toolbar button →
`GET /documents/<id>/notes/export`.

## Routes

Auth: `GET/POST /register`, `GET/POST /login`, `POST /logout`.
Library: `GET /library`, `POST /library/upload`, `PATCH|DELETE /documents/<id>`.
Viewer: `GET /documents/<id>/view`, `GET /documents/<id>/content` (parsed HTML+outline JSON for
md/docx, raw bytes for pdf).
Notes: `GET|POST /documents/<id>/notes`, `PATCH|DELETE /notes/<id>`,
`POST /documents/<id>/notes/bulk` (`{ids:[...], action: "done"|"pending"|"delete"}`, one transaction
+ one export write), `GET /documents/<id>/notes/export` (manual download),
`GET /documents/<id>/sync-status` (poll).
Settings (stub): `GET|POST /settings/ai-providers`, `DELETE /settings/ai-providers/<id>`,
`POST /notes/<id>/resolve-ai` → always 501, not implemented.

## Frontend interaction model (`viewer.js`)

- **Click a paragraph/PDF text** → point note anchored to the nearest word (`caretPositionFromPoint`
  + word-boundary search for md/docx; nearest text-layer span by distance for pdf).
- **Select text** → selection note with the exact quoted text.
- **Hold Ctrl/Cmd while clicking** → note-creation is suppressed entirely so links work normally.
  This is documented in the UI itself (toolbar hint), not just here.
- **Click elsewhere while a popover is open** → closes it, does *not* open a new one at the new spot
  (first click always just dismisses; a second, separate click starts a new note). This is a
  deliberate guard at the top of the `mouseup` handlers — don't remove it, it was a reported bug.
- Two independently collapsible side panels: left = chapter/section outline (now a real collapsible
  tree, built from the flat `{level, ...}` list via `buildOutlineTree` + `renderOutlineTree`, shared
  between md/docx and pdf), right = notes grouped by status (Pending/Done) with a "Select" mode for
  bulk mark-done/mark-pending/delete.
- PDF zoom re-renders **in place** (`updatePdfPageInPlace`/`updateAllPdfPagesInPlace`) rather than
  tearing down and rebuilding all page-wrap elements — the earlier destroy/rebuild approach caused a
  visible "reload" flash and reset scroll to page 1. A `pdfRenderToken` counter guards against
  overlapping renders if zoom is clicked again before the previous one finishes. Scroll position is
  preserved via a page-number + within-page-ratio snapshot (`getScrollState`/`restoreScrollState`),
  not just "scroll to top of page N".
- Markers are positioned at the actual anchor's pixel location (via `Range.getClientRects()` for
  md/docx, span `getBoundingClientRect()` for pdf), with simple vertical collision avoidance
  (`avoidMarkerCollision`, a `WeakMap<element, number[]>` of used offsets) — not a fixed per-block
  stack-by-count offset like the first version had.

## The AI-resolve stub (`app/ai/`)

The user wants an eventual in-app "Resolve with AI" feature (pick a provider — hosted API or local
Ollama — and have MarkAI apply the fix directly, bypassing the export files). **This is intentionally
not implemented.** `ai_providers` table + `/settings/ai-providers` CRUD exist so provider config can
be saved now; `ai/base.py` has an `AIProvider` ABC and a `resolve_with_provider()` that always raises
`NotImplementedError`. `POST /notes/<id>/resolve-ai` wires this up and returns 501. If you're asked to
build this out for real, this is the intended extension point — don't bolt it on elsewhere.

## Known environment limitation (not a code bug)

In the sandboxed browser tool used for manual testing in this session, `document.hidden` is `true`
(the preview pane isn't visually displayed to the user), which throttles Chrome's rendering pipeline
for anything requiring a fresh paint/compositor frame — **PDF canvas rendering (`page.render()`)
hangs after the first page**, and CSS transitions freeze mid-value. This was confirmed thoroughly
(isolated repro scripts, `getComputedStyle` vs `display:none` sanity checks) — it is not a bug in the
app. Discrete DOM/CSS changes (classList, `display:none`, structural changes) were verified working
correctly; only continuous paint/transition-driven behavior couldn't be visually confirmed. **PDF
zoom/hover and sidebar-collapse animations should be re-verified in a normal, visible browser tab**
before considering them fully done — the logic has been reviewed and unit-style tested in isolation,
but not eyeballed.

## Things NOT done / deliberately deferred

- No file-watcher (e.g. `watchdog`) — status-file sync is polling-based on purpose, to keep the
  dependency list minimal.
- No password recovery, no email verification (explicit user requirement).
- No CSRF protection, plaintext-stored `api_key` in `ai_providers` — explicitly acceptable per the
  user for now ("security not a priority yet"); revisit before any real deployment.
- `.gitignore` excludes `.venv/`, `.claude/`, `data/`, `__pycache__/`, `*.pyc`.
- Dev/test data currently sitting in `data/app.db`: a user `tester@example.com` / `testpass123` with
  a few sample md/docx/pdf documents and notes used for manual verification during development. Fine
  to keep or wipe (`rm data/app.db data/uploads -rf` + restart to get a clean DB).

## If you're picking this up fresh

1. `git status` first — there were uncommitted changes as of this file's writing.
2. Skim `viewer.js` top to bottom once — it's the single file where most behavior lives, and the
   section comments above map roughly 1:1 to its function groups.
3. Don't reintroduce verbose fields into the export (`sync.py::build_detailed_export` /
   `_location_and_quote`) without checking with the user — it's been trimmed twice already for being
   too token-heavy.
4. Any new note "position" field needs: (a) set client-side in `viewer.js`'s four position-builder
   call sites (`handleBlockClick`, `handleBlockSelection`, `handlePdfClick`, `handlePdfSelection`),
   (b) a fallback path in `locateAnchorInBlock`/`locatePdfAnchor` if it's used for
   highlighting/marker placement, (c) a decision on whether it belongs in the compact export.
