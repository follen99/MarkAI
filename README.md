# MarkAI

**Reviewing a document is easy. Getting the review *applied* is the part that wastes your afternoon.**
You read a thesis, a spec or a set of docs, and you leave forty comments — a wrong figure reference
in §3.2, a paragraph that contradicts the previous chapter, a term that should be spelled the same
way everywhere. Then the real work starts: every one of those comments has to be carried back into
the source by hand. And that is exactly the work an AI coding agent could do for you — except no
annotation tool will hand the notes over. Word comments live inside the `.docx`. PDF annotations
live inside the PDF. Google Docs suggestions live inside Google. You can read them one at a time and
retype each into a chat window, which is slower than just fixing the document yourself.

MarkAI is the missing export step. You annotate the document the way you always have — click a word,
select a phrase, type a note — and MarkAI writes the whole review out as a compact JSON file built
for an agent to consume: what to change, where it is (`Chapter 3 / 3.3 Chunking and pre-processing`)
and the exact quoted text to find it by. Point your agent at the file, let it apply the fixes, and it
flips each note to `done` in a companion status file that MarkAI reads back — so the notes panel in
front of you empties itself as the work lands. Review in a UI made for reading; let the agent do the
typing.

---

## How it works

```
   you                          MarkAI                        your AI agent
    │                              │                                │
    │  click / select → note       │                                │
    ├─────────────────────────────►│                                │
    │                              │  <doc>.notes.json              │
    │                              ├───────────────────────────────►│
    │                              │       (source folder)          │  applies each
    │                              │                                │  note to the
    │                              │  <doc>.notes_status.json       │  real source
    │   notes flip to "done"       │◄───────────────────────────────┤
    │◄─────────────────────────────┤        status: done            │
```

Link a document to a **source folder** — the directory where the actual source of that document
lives — and MarkAI keeps two files there in sync on every change:

- `<doc>.notes.json` — the review itself.
- `<doc>.notes_status.json` — id/status pairs the agent writes back as it applies each note.

No source folder? Use **Export notes…** in the toolbar and pick either the notes file alone or a zip
containing the same pair, and hand it to the agent yourself.

## The export format

Deliberately terse — a document full of notes should not eat an agent's context window:

```json
{
  "document": "Master Thesis",
  "notes": [
    {
      "id": "9f3c1e7a4b6d40f2a1c8e5d2b7093f14",
      "status": "pending",
      "note": "This contradicts the definition given in 2.1 — pick one and use it everywhere.",
      "location": "Chapter 3 / 3.3 Chunking and pre-processing",
      "quote": "chunks are split on token boundaries"
    }
  ]
}
```

`location` is the full heading path (root → leaf), not just the nearest heading, so an agent can find
the right section even when a phrase repeats across a long document. `quote` is the selected text
verbatim, or a few words either side of the anchor for a single-point note.

The status file the agent writes back is just as small:

```json
{
  "instructions": "For each note you have applied to the source, set its status to 'done'. MarkAI reads this file back and reflects the status in its UI.",
  "notes": [{ "id": "9f3c1e7a4b6d40f2a1c8e5d2b7093f14", "status": "done" }]
}
```

## Features

- **Markdown, PDF and DOCX** in one reader, with the same annotation model across all three.
- **Precise anchoring.** Click a word or select a phrase; notes are anchored to the exact character
  offsets, not just "somewhere in this paragraph" — markers and highlights land on the glyphs.
- **PDF that behaves like a PDF reader.** Real text selection (pdf.js's own text layer), a chapter
  outline read from the PDF's bookmarks, and zoom that responds instantly at any page count: the page
  resizes on the spot and canvases re-render in the background, nearest to the viewport first.
  `−` / `+`, a fine-grained slider popover (40–400 %), Fit-width presets, and Ctrl/Cmd + wheel.
- **Chapter outline** on the left as a collapsible tree, starting closed, with a Collapse-all button.
- **Notes panel** on the right grouped into Pending / Done, with a selection mode for bulk
  mark-done / mark-pending / delete.
- **Two-way sync.** Notes are written to the source folder on every change; statuses your agent
  writes back are pulled in on a 5 s poll, on demand via Refresh, and before every note edit.
- **Drag & drop upload** anywhere on the library page.
- Local-first: a single Flask process and one SQLite file. Nothing leaves your machine.

## Quick start

Requires Python 3.10+. With [uv](https://docs.astral.sh/uv/) installed, there is nothing to clone
and nothing to set up:

```bash
uvx markai
```

That downloads MarkAI into a throwaway environment, starts it on <http://localhost:8765> and opens
your browser. To keep it installed instead:

```bash
uv tool install markai     # or: pipx install markai
markai
```

Register an account on first run — it is stored in your own SQLite file, on your own machine — and
upload a document.

### Options

```
markai --port 9000        # a specific port (fails loudly if it's taken)
markai --data-dir ~/notes # where the database and uploads live
markai --no-browser       # don't open a browser window
```

MarkAI binds to `127.0.0.1` only, so nothing outside your machine can reach it. Everything it stores
lives in one directory — `%LOCALAPPDATA%\MarkAI` on Windows, `~/Library/Application Support/MarkAI`
on macOS, `~/.local/share/MarkAI` on Linux — holding `app.db`, `uploads/` and a session key
generated on first run. Delete that directory to reset the app; back it up to keep your notes.
`MARKAI_DATA_DIR` overrides the location.

### From a checkout

```bash
git clone https://github.com/follen99/MarkAI && cd MarkAI
python -m venv .venv
.venv/bin/python -m pip install -e .        # Windows: .venv/Scripts/python
.venv/bin/python run.py                     # dev server on :5000, data in ./data
```

## Using it with an AI agent

1. In the library, click **Source folder** on a document and enter the path where its source lives
   (e.g. the repo folder containing the `.md` file, or the LaTeX project behind the PDF).
2. Annotate. Every note rewrites `<doc>.notes.json` and `<doc>.notes_status.json` in that folder.
3. Tell your agent something like:
   > Read `thesis-4.notes.json`. For each note with `status: "pending"`, find the spot using
   > `location` and `quote`, apply the change described in `note`, then set that note's status to
   > `"done"` in `thesis-4.notes_status.json`.
4. Watch the notes move from Pending to Done in the panel as the agent works.

## Tech

Flask, SQLite (plain `sqlite3`, no ORM), server-rendered Jinja templates, and vanilla JS/CSS — no
build step, no frontend framework. PDF rendering and interaction are entirely client-side via
[pdf.js](https://mozilla.github.io/pdf.js/) (3.11.174, **bundled with the package** rather than
pulled from a CDN, so MarkAI works with no network at all); the server just streams the raw bytes.
Markdown is parsed with `markdown`, DOCX with `python-docx`. Serving is handled by `waitress`.

`CLAUDE.md` in the repository root is the deep architecture document — how notes are anchored, why
the PDF text layer works the way it does, and which fallbacks are load-bearing. Read it before
changing anything non-trivial.

## Status and limitations

This is a working single-user local tool, built to be deployable later but not deployed yet:

- Built for `localhost`. There is no CSRF protection and AI-provider API keys are stored in
  plaintext, so don't put this on a public host — `--host 0.0.0.0` exists but exposes your documents
  to anyone who can reach the machine.
- No password recovery and no email verification, by design.
- The "Resolve with AI" button is an intentional stub (`app/ai/`): provider settings can be saved,
  but the in-app resolve endpoint returns 501. The export/agent loop above is the supported path.
- Paragraph grouping in PDFs is a heuristic; unusual layouts (multi-column, tables) can group oddly.
- Cross-page PDF selections are rejected rather than silently truncated.

## Contributing

`python tests/smoke_test.py` runs the end-to-end check (it installs nothing, but expects MarkAI to
be installed — `pip install -e .` first). CI runs it on Linux, macOS and Windows against a freshly
built wheel.

## License

MIT — see [LICENSE](LICENSE).
