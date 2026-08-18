import json
import uuid

from flask import Blueprint, Response, abort, g, jsonify, request

from .auth import login_required
from .db import get_db
from .sync import build_detailed_export, check_and_pull_status, export_filename, export_notes

bp = Blueprint("notes", __name__)


def _get_document(document_id):
    db = get_db()
    doc = db.execute(
        "SELECT * FROM documents WHERE id = ? AND user_id = ?",
        (document_id, g.user["id"]),
    ).fetchone()
    if doc is None:
        abort(404)
    return doc


def _get_note(note_id):
    db = get_db()
    note = db.execute(
        "SELECT * FROM notes WHERE id = ? AND user_id = ?",
        (note_id, g.user["id"]),
    ).fetchone()
    if note is None:
        abort(404)
    return note


def _serialize_note(note):
    return {
        "id": note["id"],
        "document_id": note["document_id"],
        "note": note["note_text"],
        "status": note["status"],
        "position": json.loads(note["position_json"]),
        "created_at": note["created_at"],
        "updated_at": note["updated_at"],
    }


@bp.route("/documents/<int:document_id>/notes", methods=("GET",))
@login_required
def list_notes(document_id):
    db = get_db()
    doc = _get_document(document_id)
    check_and_pull_status(db, doc)
    notes = db.execute(
        "SELECT * FROM notes WHERE document_id = ? ORDER BY created_at", (document_id,)
    ).fetchall()
    return jsonify({"notes": [_serialize_note(n) for n in notes]})


@bp.route("/documents/<int:document_id>/notes", methods=("POST",))
@login_required
def create_note(document_id):
    db = get_db()
    doc = _get_document(document_id)
    check_and_pull_status(db, doc)

    payload = request.get_json(silent=True) or {}
    note_text = (payload.get("note") or "").strip()
    position = payload.get("position")
    if not note_text or not isinstance(position, dict):
        return jsonify({"error": "note text and position are required"}), 400

    note_id = uuid.uuid4().hex
    db.execute(
        "INSERT INTO notes (id, document_id, user_id, note_text, position_json) "
        "VALUES (?, ?, ?, ?, ?)",
        (note_id, document_id, g.user["id"], note_text, json.dumps(position)),
    )
    db.commit()

    doc = _get_document(document_id)
    export_notes(db, doc)

    note = _get_note(note_id)
    return jsonify({"note": _serialize_note(note)}), 201


@bp.route("/notes/<note_id>", methods=("PATCH",))
@login_required
def update_note(note_id):
    db = get_db()
    note = _get_note(note_id)
    doc = _get_document(note["document_id"])
    check_and_pull_status(db, doc)

    payload = request.get_json(silent=True) or {}
    fields = []
    values = []

    if "note" in payload:
        text = (payload["note"] or "").strip()
        if text:
            fields.append("note_text = ?")
            values.append(text)

    if "status" in payload:
        status = payload["status"]
        if status in ("pending", "done"):
            fields.append("status = ?")
            values.append(status)

    if fields:
        fields.append("updated_at = datetime('now')")
        values.append(note_id)
        db.execute(f"UPDATE notes SET {', '.join(fields)} WHERE id = ?", values)
        db.commit()
        doc = _get_document(note["document_id"])
        export_notes(db, doc)

    note = _get_note(note_id)
    return jsonify({"note": _serialize_note(note)})


@bp.route("/notes/<note_id>", methods=("DELETE",))
@login_required
def delete_note(note_id):
    db = get_db()
    note = _get_note(note_id)
    doc = _get_document(note["document_id"])
    db.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    db.commit()
    export_notes(db, doc)
    return jsonify({"ok": True})


@bp.route("/documents/<int:document_id>/notes/bulk", methods=("POST",))
@login_required
def bulk_update_notes(document_id):
    db = get_db()
    doc = _get_document(document_id)
    check_and_pull_status(db, doc)

    payload = request.get_json(silent=True) or {}
    ids = [i for i in (payload.get("ids") or []) if isinstance(i, str)]
    action = payload.get("action")
    if not ids or action not in ("done", "pending", "delete"):
        return jsonify({"error": "ids and a valid action are required"}), 400

    placeholders = ",".join("?" for _ in ids)
    if action == "delete":
        db.execute(
            f"DELETE FROM notes WHERE id IN ({placeholders}) AND document_id = ? AND user_id = ?",
            (*ids, document_id, g.user["id"]),
        )
    else:
        db.execute(
            f"UPDATE notes SET status = ?, updated_at = datetime('now') "
            f"WHERE id IN ({placeholders}) AND document_id = ? AND user_id = ?",
            (action, *ids, document_id, g.user["id"]),
        )
    db.commit()

    doc = _get_document(document_id)
    export_notes(db, doc)

    notes = db.execute(
        "SELECT * FROM notes WHERE document_id = ? ORDER BY created_at", (document_id,)
    ).fetchall()
    return jsonify({"notes": [_serialize_note(n) for n in notes]})


@bp.route("/documents/<int:document_id>/notes/export", methods=("GET",))
@login_required
def export_notes_download(document_id):
    db = get_db()
    doc = _get_document(document_id)
    check_and_pull_status(db, doc)
    payload = build_detailed_export(db, doc)
    body = json.dumps(payload, indent=2, ensure_ascii=False)
    response = Response(body, mimetype="application/json")
    response.headers["Content-Disposition"] = f'attachment; filename="{export_filename(doc)}"'
    return response


@bp.route("/documents/<int:document_id>/sync-status", methods=("GET",))
@login_required
def sync_status(document_id):
    db = get_db()
    doc = _get_document(document_id)
    changed = check_and_pull_status(db, doc)
    notes = db.execute(
        "SELECT * FROM notes WHERE document_id = ? ORDER BY created_at", (document_id,)
    ).fetchall()
    return jsonify({"changed": changed, "notes": [_serialize_note(n) for n in notes]})
