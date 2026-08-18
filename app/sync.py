import json
import os
import tempfile
from datetime import datetime, timezone

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


def export_notes(db, document):
    """Write the full notes file and the short status file into the document's
    source folder, if one is configured. Called after any note mutation."""
    if not document["source_folder"]:
        return

    notes = db.execute(
        "SELECT * FROM notes WHERE document_id = ? ORDER BY created_at",
        (document["id"],),
    ).fetchall()

    detailed = {
        "document_title": document["title"],
        "document_type": document["doc_type"],
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "notes": [
            {
                "id": note["id"],
                "status": note["status"],
                "note": note["note_text"],
                "position": json.loads(note["position_json"]),
                "created_at": note["created_at"],
                "updated_at": note["updated_at"],
            }
            for note in notes
        ],
    }
    status_list = {
        "instructions": (
            "For each note you have applied to the source, set its status to "
            "'done'. MarkAI reads this file back and reflects the status in its UI."
        ),
        "notes": [{"id": note["id"], "status": note["status"]} for note in notes],
    }

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
