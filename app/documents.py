import os
import uuid

from flask import (
    Blueprint,
    abort,
    current_app,
    flash,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    url_for,
)
from werkzeug.utils import secure_filename

from .auth import login_required
from .db import get_db
from .parsers.docx_parser import parse_docx
from .parsers.markdown_parser import parse_markdown

bp = Blueprint("documents", __name__)

_EXT_TO_TYPE = {".md": "md", ".markdown": "md", ".pdf": "pdf", ".docx": "docx"}


def _get_owned_document(document_id):
    db = get_db()
    doc = db.execute(
        "SELECT * FROM documents WHERE id = ? AND user_id = ?",
        (document_id, g.user["id"]),
    ).fetchone()
    if doc is None:
        abort(404)
    return doc


def _document_path(doc):
    return os.path.join(current_app.config["UPLOAD_DIR"], doc["stored_filename"])


@bp.route("/library")
@login_required
def library():
    db = get_db()
    docs = db.execute(
        "SELECT * FROM documents WHERE user_id = ? ORDER BY last_opened_at IS NULL, last_opened_at DESC, created_at DESC",
        (g.user["id"],),
    ).fetchall()
    return render_template("library.html", documents=docs)


@bp.route("/library/upload", methods=("POST",))
@login_required
def upload():
    file = request.files.get("file")
    if not file or file.filename == "":
        flash("Choose a file to upload.")
        return redirect(url_for("documents.library"))

    original_name = secure_filename(file.filename)
    ext = os.path.splitext(original_name)[1].lower()
    doc_type = _EXT_TO_TYPE.get(ext)
    if doc_type is None:
        flash("Unsupported file type. Please upload a .md, .pdf or .docx file.")
        return redirect(url_for("documents.library"))

    user_dir = os.path.join(current_app.config["UPLOAD_DIR"], str(g.user["id"]))
    os.makedirs(user_dir, exist_ok=True)
    stored_name = f"{g.user['id']}/{uuid.uuid4().hex}{ext}"
    file.save(os.path.join(current_app.config["UPLOAD_DIR"], stored_name))

    title = request.form.get("title", "").strip() or os.path.splitext(original_name)[0]

    db = get_db()
    db.execute(
        "INSERT INTO documents (user_id, title, doc_type, stored_filename) VALUES (?, ?, ?, ?)",
        (g.user["id"], title, doc_type, stored_name),
    )
    db.commit()
    return redirect(url_for("documents.library"))


@bp.route("/documents/<int:document_id>", methods=("PATCH",))
@login_required
def update_document(document_id):
    doc = _get_owned_document(document_id)
    payload = request.get_json(silent=True) or {}
    db = get_db()

    if "title" in payload:
        title = (payload["title"] or "").strip()
        if title:
            db.execute("UPDATE documents SET title = ? WHERE id = ?", (title, doc["id"]))

    if "source_folder" in payload:
        folder = (payload["source_folder"] or "").strip()
        if folder and not os.path.isdir(folder):
            return jsonify({"error": f"Folder does not exist: {folder}"}), 400
        db.execute(
            "UPDATE documents SET source_folder = ?, last_status_sync_mtime = NULL WHERE id = ?",
            (folder or None, doc["id"]),
        )

    db.commit()
    updated = _get_owned_document(document_id)
    return jsonify({"document": dict(updated)})


@bp.route("/documents/<int:document_id>", methods=("DELETE",))
@login_required
def delete_document(document_id):
    doc = _get_owned_document(document_id)
    path = _document_path(doc)
    db = get_db()
    db.execute("DELETE FROM documents WHERE id = ?", (doc["id"],))
    db.commit()
    if os.path.exists(path):
        os.remove(path)
    return jsonify({"ok": True})


@bp.route("/documents/<int:document_id>/view")
@login_required
def view(document_id):
    doc = _get_owned_document(document_id)
    db = get_db()
    db.execute(
        "UPDATE documents SET last_opened_at = datetime('now') WHERE id = ?", (doc["id"],)
    )
    db.commit()
    return render_template("viewer.html", document=doc)


@bp.route("/documents/<int:document_id>/content")
@login_required
def content(document_id):
    doc = _get_owned_document(document_id)
    path = _document_path(doc)

    if doc["doc_type"] == "pdf":
        return send_file(path, mimetype="application/pdf")

    if doc["doc_type"] == "md":
        with open(path, "r", encoding="utf-8") as f:
            source = f.read()
        parsed = parse_markdown(source)
        return jsonify(parsed)

    if doc["doc_type"] == "docx":
        parsed = parse_docx(path)
        return jsonify(parsed)

    abort(404)
