# MarkAI

Local web app for annotating documents (MD / PDF / DOCX) and exporting the notes in a compact,
AI-friendly format so an external coding agent can apply them to the source. Single user for now,
built to be deploy-ready later. Flask backend, vanilla JS/CSS frontend, SQLite storage.

Read this file before making changes — it captures decisions and gotchas that aren't obvious from
the code alone. Update it when you make a structural change or fix something non-obvious.

## Run it

```bash
cd MarkAI
.venv/Scripts/python run.py    # http://localhost:5000, debug=True, data in ./data
```

That's the *development* entry point and the one to use here: it pins the data dir to the repo's
`data/` (sample documents live there) and runs the Flask reloader. The **shipped** entry point is
`markai/cli.py` → the `markai` console script (`uvx markai`), which is a different beast: waitress
instead of the dev server, port 8765 with a free-port fallback, `127.0.0.1` only, browser auto-open,
and data under `platformdirs.user_data_dir("MarkAI")`. Changes to startup behaviour usually need to
happen in both.

Deps: `Flask`, `python-docx`, `markdown`, `platformdirs`, `waitress` — declared in `pyproject.toml`
(`requirements.txt` is kept only as a convenience mirror). `.venv` already exists; if not,
`python -m venv .venv && .venv/Scripts/python -m pip install -e .`.

`.claude/launch.json` is configured for the `preview_start` tool (name `markai`, port 5000).
**Flask's debug reloader spawns a child process that `preview_stop` doesn't always kill** — if you
get "port 5000 already in use" on the next `preview_start`, find and kill leftover
`.venv\Scripts\python.exe .\run.py` processes first (`Get-CimInstance Win32_Process -Filter
"name='python.exe'"` on Windows) before retrying.

There's a git repo. **Check `git status` and `git log` before assuming the working tree matches
what's committed** — this file is updated when structural changes land, but git history (not this
paragraph) is the source of truth for what's actually shipped at any given moment.

## Architecture

```
pyproject.toml      packaging (hatchling), deps, the `markai` console script, PyPI metadata
run.py              dev entry point (repo-local data dir, Flask reloader)
tests/smoke_test.py stdlib end-to-end check, run against an *installed* MarkAI
.github/workflows/  ci.yml (smoke test on 3 OSes) + publish.yml (tag -> PyPI, trusted publishing)
markai/
  __init__.py       Flask app factory, data dir resolution, per-install secret key
  cli.py             `markai` console script: arg parsing, port choice, waitress, browser open
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
  static/vendor/pdfjs/  pdf.min.js + pdf.worker.min.js, vendored (NOT a CDN — see below)
  static/js/
    viewer.js          the big one — rendering, note CRUD, highlighting, PDF zoom/handling (~2000 lines)
    sync_poll.js        polls /documents/<id>/sync-status every 5s + wires the Refresh button
data/                 gitignored: dev-only data dir (app.db, uploads/, secret_key)
```

**Data lives outside the repo for installed users.** `create_app(data_dir=...)` decides where:
explicit argument, else `MARKAI_DATA_DIR`, else the per-user platform dir. The Flask `SECRET_KEY` is
generated once per install and stored as `<data_dir>/secret_key` — never hardcode a fallback there,
a constant shipped inside a public package makes every install's session cookies forgeable.

No ORM, no JS framework, no build step. PDF rendering/interaction is 100% client-side via **pdf.js
`3.11.174`, vendored under `markai/static/vendor/pdfjs/`** (both `pdf.min.js` and
`pdf.worker.min.js`) — zero Python PDF dependency; the server just streams the raw file bytes for
PDFs. It used to load from cdnjs; it doesn't any more, because a tool that promises your documents
never leave the machine shouldn't need the network to open one, and an offline user got a dead
viewer. `viewer.html` has the `<script>` tag, `viewer.js` reads the worker URL from
`cfg.pdfWorkerUrl` (also set in `viewer.html`) — **both** must move together if the version is ever
bumped, and `pyproject.toml`'s `artifacts` entry is what keeps the two files inside the wheel.

**The PDF text layer uses pdf.js's own `pdfjsLib.renderTextLayer`/`updateTextLayer`** (both exported
from the core `pdf.min.js` build already loaded — no extra CDN asset needed), not a hand-rolled span
builder. This is version-coupled: item splitting and the `textDivs` array pdf.js hands back are an
implementation detail of that exact build, which is why the pdf.js version is pinned in
`viewer.html` — bumping it should be deliberate, and re-verify the "old note still resolves" case
(see below) afterward. `buildPdfTextLayer` (`viewer.js`) captures `textDivs` in item order into
per-page state (`wrap.__mk`, via `pdfPageState(wrap)`) — this is also why `anchor_span_index` stays a
valid index into `textDivs` across this change: pdf.js pushes one div per text item, in order, before
appending any of them, same as the old code did. `--scale-factor` is set on each `.pdf-page-wrap` (an
ancestor of the text layer) and **must** track `pdfScale` — pdf.js reads it via `getComputedStyle`
and both layout (percentage left/top) and zoom (`updateTextLayer` with `mustRescale:true`) depend on
it being current. See `app.css`'s `.pdf-text-layer` block — those rules are a port of pdf.js's own
`text_layer_builder.css` and are load-bearing for glyph alignment, not decorative.

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
- **PDF**: `page` + `anchor_span_index`/`anchor_span_index_end` (index into that page's `textDivs`
  list, in `getTextContent()` item order — stable across re-renders of the same page and across
  zoom, since pdf.js pushes one div per item before appending any of them). Notes created since the
  native-text-layer rewrite also carry `char_base: "span"` plus `char_offset`/`char_length` (point)
  or `char_offset`/`char_offset_end` (selection) — offsets are **relative to
  `textDivs[anchor_span_index].textContent`**, not a page-wide flat string, so they can be turned
  directly into a DOM `Range` (`pdfRangeFromAnchor`). `char_base` is the version discriminator:
  its absence marks a pre-rewrite note that only ever resolved to a whole text item.

**Backward-compat fallback is load-bearing, not optional.** Notes created before `char_offset` /
`anchor_span_index` existed (or any future note where the stored offset doesn't resolve) fall back
to searching the current text for `selected_text` or `anchor_text` via `indexOf`/`findIndex`. This
logic lives in `locateAnchorInBlock` (md/docx) and `locatePdfAnchor` (pdf) in `viewer.js` — **always
route marker placement and highlighting through these**, never read `char_offset`/`anchor_span_index`
directly, or you'll silently break old notes.

`locatePdfAnchor`'s fallback chain, in order: **(1)** `char_base:"span"` present → resolve the exact
char offsets, then verify the resolved text still matches `selected_text`/`anchor_text` (catches a
PDF that changed on disk, or a future pdf.js version splitting items differently) — on mismatch, fall
through to (2); **(2)** whole-page text search (`locatePdfAnchorByText`, using a whitespace-normalized
flat index built lazily per page and cached on `wrap.__mk.flatIndex`) against `selected_text`,
its first 40 chars, `anchor_text`, then `anchor_text`'s first word — tried *before* the index-only
fallback for legacy selections specifically, because the old `anchor_span_index_end` often just
repeats the start index and would otherwise highlight one text item instead of the whole phrase;
**(3)** index-only — highlight the whole `anchor_span_index` (…`_end`) text item(s), i.e. today's
pre-rewrite behavior, for legacy notes the text search can't place; **(4)** `null` — the caller
(`highlightPdfPosition`) shows an explicit `.pdf-anchor-missing` outline instead of highlighting
nothing silently.

## Highlighting behavior (what a user sees when opening a note)

- MD/DOCX: the whole paragraph (`.doc-block`) gets a `.note-target-block` background tint, and the
  exact word/phrase gets wrapped in a real `<mark class="note-highlight">` (via `Range.surroundContents`,
  wrapped in try/catch since it can throw if the range crosses element boundaries — falls back to
  paragraph-only tint in that case).
- PDF: same idea but can't mutate the PDF content, so it's done with absolutely-positioned overlay
  `<div class="pdf-highlight-box">` elements in a dedicated `.pdf-highlight-layer` (sits between the
  canvas and the text layer used for native selection; the text layer is `opacity:1` with
  `color:transparent` spans — pdf.js's own approach — **not** the old `opacity:0.2` trick, which
  also made the native selection color render at ~8% alpha and was a big part of why selection used
  to look broken). The `.target` box is painted from a real DOM `Range`
  (`pdfRangeFromAnchor` → `paintRangeBoxes` → `mergeRectsByLine`, one bar per visual line) built from
  the resolved char offsets, so it covers exactly the anchored text instead of a whole pdf.js text
  item. `.block` class = paragraph tint, `.hover` = live hover preview (mousemove-driven, coalesced
  via `requestAnimationFrame` so it doesn't rebuild boxes on every pixel of movement). "Paragraph" for
  PDF is still a heuristic (`computeParagraphs` in `viewer.js`), but it now groups by each text item's
  **baseline**, computed once from `item.transform` in unscaled PDF units (`buildItemGeom`) rather
  than by reading live `span.style.top` — pdf.js's own text layer expresses that as a percentage
  string, and re-deriving pixel geometry per zoom level was both slower and the thing that made
  paragraph grouping quietly degrade at high zoom before this rewrite. It's still a heuristic, not
  real structure — expect occasional misgrouping on unusual layouts (columns, tables).
- If no anchor resolves at all (e.g. a scanned PDF page with no text layer, or a note whose quoted
  text genuinely isn't on the page anymore), the page still scrolls into view and gets a dashed
  `.pdf-anchor-missing` outline for ~1.2s, and the popover shows a one-line hint — this used to be
  completely silent (nothing highlighted, no signal), which was indistinguishable from "the feature
  is broken."
- Exactly one highlight is ever active (`activeHighlight` module var + `clearHighlight()`), cleared
  whenever a popover closes. `activeHighlightPosition` (the position object behind it) is also kept
  so PDF zoom (`rerenderPdfPreservingPosition`) can re-apply the same highlight after re-render —
  previously zoom just wiped it and left an open popover pointing at nothing.
- Opening a note (`openEditPopover`) always resolves + scrolls the highlight first
  (`scrollIntoViewerCenter`, synchronous — not `scrollIntoView({behavior:"smooth"})`, whose
  async completion used to leave the popover positioned from pre-scroll coordinates) and *then*
  derives the popover's position from where the highlight actually landed
  (`activeHighlight.anchorRect()`), unless explicit `{x, y}` opts are passed (e.g. clicking a marker
  directly). This is what makes "open a note from the list" actually jump to and show its
  highlight — before, `openEditPopover` always passed `{scroll:false}` and relied on a marker
  element existing to scroll manually, and PDF markers were frequently off-screen (see below), so in
  practice opening a PDF note from the list highlighted nothing the user could see.

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
manual one-off download (independent of source_folder) is available via the toolbar's
"Export notes…" button, which opens a chooser (`openExportDialog` in `viewer.js`) rather than
downloading straight away — the two shapes are not interchangeable and guessing was wrong half the
time:
- **Notes only** → `?format=notes`, the `<slug>.notes.json` above, on its own.
- **Source-folder bundle** → `?format=bundle`, a zip of *both* files (notes + status), i.e. exactly
  what a linked `source_folder` would receive, so the agent round-trip works without linking one.

Both are built from the same `build_detailed_export` / `build_status_export` pair that
`export_notes()` writes to disk, so a download can never drift from what the folder would contain.

## Routes

Auth: `GET/POST /register`, `GET/POST /login`, `POST /logout`.
Library: `GET /library`, `POST /library/upload`, `PATCH|DELETE /documents/<id>`.
Viewer: `GET /documents/<id>/view`, `GET /documents/<id>/content` (parsed HTML+outline JSON for
md/docx, raw bytes for pdf).
Notes: `GET|POST /documents/<id>/notes`, `PATCH|DELETE /notes/<id>`,
`POST /documents/<id>/notes/bulk` (`{ids:[...], action: "done"|"pending"|"delete"}`, one transaction
+ one export write), `GET /documents/<id>/notes/export?format=notes|bundle` (manual download),
`GET /documents/<id>/sync-status` (poll).
Settings (stub): `GET|POST /settings/ai-providers`, `DELETE /settings/ai-providers/<id>`,
`POST /notes/<id>/resolve-ai` → always 501, not implemented.

## Frontend interaction model (`viewer.js`)

- **Click a paragraph/PDF text** → point note anchored to the nearest word (`caretPositionFromPoint`
  + word-boundary search for both md/docx and pdf — `caretAnchorInPdf` tries the caret first, falling
  back to nearest-text-div-by-distance capped at `28 * pdfScale` CSS px so a click in empty margin
  doesn't silently anchor to a far-away word).
- **Select text** → selection note with the exact quoted text. For PDF, `anchorFromSelection` walks
  `textDivs` and asks the browser `Range` which ones it actually intersects (`range.intersectsNode`)
  rather than trusting `range.startContainer`/`endContainer` directly, since pdf.js's `.endOfContent`
  helper div (added for smoother drag-select) is frequently the reported end container. A selection
  that starts and ends on different pages is rejected with a toast (`showToast`) instead of silently
  creating a note anchored to a truncated, mismatched range — MarkAI doesn't support cross-page
  selections.
- **Hold Ctrl/Cmd while clicking** → note-creation is suppressed entirely so links work normally.
  This is documented in the UI itself (toolbar hint), not just here. For links that point *into the
  same document* (`href="#..."` — a markdown TOC, or any sidebar outline entry) "normally" cannot
  mean the browser default: Ctrl-click would open a second copy of the whole viewer in a new tab, and
  a plain click would scroll the page out from under the note popover it just opened. So
  `navigateToFragment` handles them instead — Ctrl/Cmd+click jumps to the section inside
  `#viewer-main`, a plain click navigates nowhere and just creates its note. Links to anywhere else
  are untouched. The outline sidebar routes *every* click through the same helper (the `a.href` is
  kept only so the row still reads as a link and shows a target on hover).
- **Click elsewhere while a popover is open** → closes it, does *not* open a new one at the new spot
  (first click always just dismisses; a second, separate click starts a new note). This is a
  deliberate guard at the top of the `mouseup` handlers — don't remove it, it was a reported bug.
- Two independently collapsible side panels: left = chapter/section outline (a real collapsible
  tree, built from the flat `{level, ...}` list via `buildOutlineTree` + `renderOutlineTree`, shared
  between md/docx and pdf), right = notes grouped by status (Pending/Done) with a "Select" mode for
  bulk mark-done/mark-pending/delete. **Every outline node with children starts `collapsed`** and a
  "Collapse all" button (`collapseAllOutline`) re-closes the tree — on a real document the fully
  expanded tree is unusable (the thesis sample is 207 rows expanded vs 11 chapters closed).
- **PDF zoom is split into a synchronous layout pass and a lazy raster pass** (see the `----------
  Zoom ----------` block in `viewer.js`) — this is the whole reason zoom feels instant, and it's easy
  to accidentally undo. `setPdfZoom` does *only* cheap work inline: `pdfLayoutPage` on every page
  (wrap width/height, `--scale-factor`, and the canvas's **CSS** size — the bitmap is left alone and
  simply stretched by the browser), `restoreScrollState`, and `repaintPdfHighlight`. The expensive
  canvas re-rasterization is deferred to a debounced pass (`schedulePdfRaster` → `refreshPdfRaster`)
  that only touches pages within `PDF_RASTER_MARGIN` viewport-heights of the visible area, nearest
  first; everything else stays marked dirty (`canvasScale !== pdfScale`) until `onPdfScroll` brings it
  near the viewport. Before this, every zoom step re-rendered *all* pages sequentially before the
  toolbar unfroze, which on a long PDF meant seconds of lag per click. Same split for text layers:
  `ensurePageTextScaled` runs `pdfjsLib.updateTextLayer(..., mustRescale:true)` for near-viewport
  pages only, and `placePdfMarker`/`highlightPdfPosition` call it on demand for whatever page they're
  about to measure. Deferring it is safe because the text divs' left/top are percentages and their
  font sizes are `calc(... * var(--scale-factor))`, so they follow the new scale by themselves;
  `updateTextLayer` only re-derives the per-div `scaleX` correction. `computeParagraphs`' output
  stays valid across zoom without recomputation since it's derived from unscaled PDF units (see
  `buildItemGeom`).
  - `rasterizePage` renders into a **detached** canvas and swaps it in when done — writing to the
    live canvas would blank the page for the render's duration (assigning `canvas.width` clears the
    bitmap), which was the visible white flash of the old zoom.
  - It refuses to touch a page whose *first* render is still running (`st.initialRender`): cancelling
    that would abort `renderPdfPage` before it ever builds the text layer, leaving a page with no
    anchors. `initPdf` calls `schedulePdfRaster(0)` after the first pass so pages rendered at a scale
    the user has since left get caught up.
  - Markers are **not** re-placed on zoom (their `top` is a percentage of page height, so they track
    it for free); the one active highlight is repainted from `activeHighlightPosition`, and each
    page's hover state is reset via `st.clearHover` — without that, the mousemove handler's
    "same text item as last time" short-circuit would suppress the hover highlight until the pointer
    crossed into a different item.
  - Scroll position is preserved via a page-number + within-page-ratio snapshot
    (`getScrollState`/`restoreScrollState`), not just "scroll to top of page N".
- Zoom UI (`initZoomControls`): `-` / `+` step to the next round multiple of 10%, the percentage
  itself is a button that opens a popover with a fine-grained slider (40–400%, live `input` — it can
  be live precisely *because* the layout pass is synchronous) plus Fit-width/50/100/150/200 presets,
  and Ctrl/Cmd + wheel over the document zooms. `PDF_BASE_SCALE` (1.2) is the scale the UI calls
  100%; `pdfScale` is always the raw pdf.js scale, never the percentage.
- Markers are positioned at the actual anchor's pixel location (via `Range.getClientRects()` for
  md/docx, and — since the native text-layer rewrite — a real `Range` built from the resolved char
  offsets via `pdfRangeFromAnchor` for pdf), with simple vertical collision avoidance
  (`avoidMarkerCollision`, a `WeakMap<element, number[]>` of used offsets) — not a fixed per-block
  stack-by-count offset like the first version had. PDF markers sit inside the page's own right
  margin (`.pdf-page-wrap .note-marker { right: 8px }`, `top` written as a **percentage** of page
  height so it tracks zoom) rather than at a fixed negative offset outside a width-constrained
  container — `.doc-pane[data-doc-type="pdf"]` has no `max-width`, PDF pages render at their natural
  size instead of being squeezed into the 760px md/docx column.
- `MarkAIApplyExternalNotes` (called by `sync_poll.js` on every 5s poll) now does a full
  reconciliation against the incoming note list: notes that just showed up get a marker placed for
  the first time, notes that disappeared (deleted externally) get their marker removed. Previously it
  only toggled done/pending state on markers that already existed — a note created by an external
  agent while the document was open never got a marker until the page was reloaded.

## Library upload (`library.html`)

The upload form is a single centred card whose file input is visually hidden inside a `<label
class="dropzone">` (so clicking anywhere in the zone opens the picker with no JS). Dropping a file
anywhere in the window works too: `dragenter`/`dragleave` are counted with a **depth counter**, not
toggled per event — they fire for every element the pointer crosses, so toggling directly makes the
`.drop-overlay` flicker. A dropped file is validated by extension, assigned to the real `<input
type="file">` via `DataTransfer`, and then the ordinary multipart form is submitted — there is
deliberately no separate fetch-based upload path to keep in sync with `documents.upload`.

## The AI-resolve stub (`markai/ai/`)

The user wants an eventual in-app "Resolve with AI" feature (pick a provider — hosted API or local
Ollama — and have MarkAI apply the fix directly, bypassing the export files). **This is intentionally
not implemented.** `ai_providers` table + `/settings/ai-providers` CRUD exist so provider config can
be saved now; `ai/base.py` has an `AIProvider` ABC and a `resolve_with_provider()` that always raises
`NotImplementedError`. `POST /notes/<id>/resolve-ai` wires this up and returns 501. If you're asked to
build this out for real, this is the intended extension point — don't bolt it on elsewhere.

## Known environment limitation (not a code bug)

In the sandboxed browser tool used for manual testing (`preview_start` + the `Browser` pane),
`document.hidden` is `true` (the pane isn't visually displayed to the user), which throttles
Chrome's rendering pipeline for anything requiring a fresh paint/compositor frame — **PDF canvas
rendering (`page.render()`) hangs before it ever resolves**, and CSS transitions freeze mid-value.
Confirmed thoroughly (isolated repro scripts, `getComputedStyle` vs `display:none` sanity checks) —
not a bug in the app. Discrete DOM/CSS changes (classList, `display:none`, structural changes) work
fine and are verifiable this way; only continuous paint/transition-driven behavior, and — because
`buildPdfTextLayer` awaits `page.render()` first (pdf.js needs the canvas render to have bound page
fonts before measuring text) — **the entire PDF text-layer/selection/highlighting pipeline**, cannot
be visually confirmed through this tool. Anything PDF-specific (native text-layer selection,
char-precise highlighting, open-from-list scroll+highlight, zoom re-render, marker placement) needs
a real, visible Chrome tab (`.venv/Scripts/python run.py`, then open `http://localhost:5000` in an
actual browser window — not the sandboxed preview) before it can be considered verified, no matter
how carefully the code has been checked against pdf.js's source. The md/docx side of any shared code
path (e.g. `highlightPosition`/`openEditPopover`/`scrollIntoViewerCenter`/`positionPopover`) *can* be
verified in-sandbox, since it never touches a PDF canvas — do that first as a cheap sanity check, but
don't let it stand in for the PDF-specific check.

**PDF verification checklist** (run in a real visible tab, against the "Test PDF Doc" / "Tesi"
sample documents — see below for the login):
1. Console clean on load: no `--scale-factor` warning, no `Deprecated API usage` (textContent vs
   textContentSource) message.
2. Drag-select a phrase mid-paragraph → the highlight lands exactly on the glyphs, no offset/drift;
   repeat at high zoom near the bottom of a page.
3. Selected phrase spanning two lines → one highlight bar per visual line, not one per pdf.js text
   item.
4. Click a word → popover context is right; click empty margin → no popover.
5. Open a note from the right-hand list whose page isn't the current one → viewer jumps there,
   highlight is visible and centered, popover is fully on-screen.
6. Zoom in/out with a note's popover open → highlight is still there and still correct afterward;
   rapid zoom clicks produce no console errors. Also: the page must resize *immediately* on each
   click/slider drag (blurry-then-sharp is the intended behaviour, frozen-then-jump is the
   regression), the slider must track the pointer while dragging on a long document, and pages
   scrolled to afterwards must sharpen instead of staying stretched.
7. A pre-existing note (created before this rewrite, i.e. no `char_base` in its `position_json`)
   still highlights correctly.
8. Drag a selection from one page into the next → rejected with a toast, no note created.

## Releasing

`pyproject.toml` is the source of truth for metadata; the version is read from `markai/__init__.py`
(`__version__`) by hatchling, so bump it there. Then:

```bash
git tag v0.1.1 && git push --tags
```

`.github/workflows/publish.yml` builds sdist + wheel, refuses to publish if the tag doesn't match
`markai.__version__` (PyPI releases are permanent — a wrong number can't be taken back), runs
`twine check` and the smoke test against the built wheel, then uploads via **PyPI Trusted Publishing**
(OIDC, no API token stored anywhere). The one-time PyPI-side setup is a GitHub publisher on project
`markai` for `follen99/MarkAI`, workflow `publish.yml`, environment `pypi`.

`tests/smoke_test.py` deliberately imports `markai` rather than the source tree (it's run from
`tests/`, so the *installed* package wins) — that's what makes it catch templates, CSS/JS or the
vendored pdf.js being left out of the wheel, which is the packaging bug that actually happens.

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

1. `git status` and `git log` first — don't assume the working tree matches what was last committed.
2. If the PDF verification checklist above hasn't been run in a real visible browser tab yet, that's
   the highest-value next step: it's the one part of the current code that's been reviewed and
   reasoned through carefully but never eyeballed.
3. Skim `viewer.js` top to bottom once — it's the single file where most behavior lives, and the
   section comments above map roughly 1:1 to its function groups.
4. Don't reintroduce verbose fields into the export (`sync.py::build_detailed_export` /
   `_location_and_quote`) without checking with the user — it's been trimmed twice already for being
   too token-heavy.
5. Any new note "position" field needs: (a) set client-side in `viewer.js`'s four position-builder
   call sites (`handleBlockClick`, `handleBlockSelection`, `handlePdfClick`, `handlePdfSelection`),
   (b) a fallback path in `locateAnchorInBlock`/`locatePdfAnchor` if it's used for
   highlighting/marker placement, (c) a decision on whether it belongs in the compact export.
6. For PDF specifically: don't read `.pdf-text-layer span` from the DOM via `querySelectorAll` for
   anything anchor-related — always go through `pdfTextDivs(wrap)` / `pdfPageState(wrap).textDivs`,
   which is the array pdf.js itself populated (and can contain divs it never appended to the DOM, for
   zero-length text items — `locatePdfAnchor`/`pdfRangeFromAnchor` already handle that via
   `connectedDivIndex`, don't re-derive span lists another way).
