import json
import os
import tempfile

from markdown.extensions.toc import slugify


def _slug_for(document) -> str:
    base = slugify((document["title"] or "").strip(), "-") or "document"
    return f"{base}-{document['id']}"


def notes_file_path(document):
    if not document["source_folder"]:
        return None
    return os.path.join(document["source_folder"], f"{_slug_for(document)}.notes.json")


def status_file_path(document):
    if not document["source_folder"]:
        return None
    return os.path.join(document["source_folder"], f"{_slug_for(document)}.notes_status.json")


def _atomic_write_json(path, data):
    directory = os.path.dirname(path)
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, path)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def export_filename(document) -> str:
    return f"{_slug_for(document)}.notes.json"


def status_export_filename(document) -> str:
    return f"{_slug_for(document)}.notes_status.json"


def bundle_export_filename(document) -> str:
    return f"{_slug_for(document)}.notes-bundle.zip"


def _words(text, n, from_end=False):
    words = (text or "").split()
    return " ".join(words[-n:] if from_end else words[:n])


def _location_and_quote(position):
    """Reduce a note's (verbose, UI-oriented) position into the two things an
    AI agent actually needs to find the spot in a source file: the full
    section/subsection path, and a short quote. Kept deliberately terse so a
    document full of notes doesn't blow up the context window."""
    heading_path = position.get("heading_path") or []
    location = " / ".join(heading_path) if heading_path else (position.get("chapter") or "")

    quote = position.get("quote")
    if not quote:
        quote = position.get("selected_text") or ""
    if not quote:
        before = _words(position.get("context_before"), 4, from_end=True)
        anchor = position.get("anchor_text") or ""
        after = _words(position.get("context_after"), 4)
        quote = " ".join(part for part in (before, anchor, after) if part)

    return location, quote.strip()


def build_detailed_export(db, document):
    notes = db.execute(
        "SELECT * FROM notes WHERE document_id = ? ORDER BY created_at",
        (document["id"],),
    ).fetchall()
    result = []
    for note in notes:
        location, quote = _location_and_quote(json.loads(note["position_json"]))
        result.append(
            {
                "id": note["id"],
                "status": note["status"],
                "note": note["note_text"],
                "location": location,
                "quote": quote,
            }
        )
    return {"document": document["title"], "notes": result}


def build_status_export(detailed):
    """The companion status file: just id/status pairs plus the one-line contract
    an external agent needs. Derived from an already-built detailed export so the
    two files can never disagree about which notes exist."""
    return {
        "instructions": (
            "For each note you have applied to the source, set its status to "
            "'done'. MarkAI reads this file back and reflects the status in its UI."
        ),
        "notes": [{"id": n["id"], "status": n["status"]} for n in detailed["notes"]],
    }


def export_notes(db, document):
    """Write the full notes file and the short status file into the document's
    source folder, if one is configured. Called after any note mutation."""
    if not document["source_folder"]:
        return

    detailed = build_detailed_export(db, document)
    status_list = build_status_export(detailed)

    os.makedirs(document["source_folder"], exist_ok=True)
    _atomic_write_json(notes_file_path(document), detailed)
    _atomic_write_json(status_file_path(document), status_list)


def check_and_pull_status(db, document):
    """Read the status file back (if changed since last check) and update note
    statuses in the DB to match. Returns True if anything changed."""
    path = status_file_path(document)
    if not path or not os.path.exists(path):
        return False

    mtime = os.path.getmtime(path)
    last_known = document["last_status_sync_mtime"]
    if last_known is not None and mtime <= last_known:
        return False

    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except (json.JSONDecodeError, OSError):
        return False

    entries = payload.get("notes", []) if isinstance(payload, dict) else payload
    if not isinstance(entries, list):
        return False

    changed = False
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        note_id = entry.get("id")
        status = entry.get("status")
        if status not in ("pending", "done") or not note_id:
            continue
        cur = db.execute(
            "SELECT status FROM notes WHERE id = ? AND document_id = ?",
            (note_id, document["id"]),
        ).fetchone()
        if cur is not None and cur["status"] != status:
            db.execute(
                "UPDATE notes SET status = ?, updated_at = datetime('now') WHERE id = ?",
                (status, note_id),
            )
            changed = True

    db.execute(
        "UPDATE documents SET last_status_sync_mtime = ? WHERE id = ?",
        (mtime, document["id"]),
    )
    db.commit()
    return changed
