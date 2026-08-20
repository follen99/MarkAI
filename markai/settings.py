from flask import Blueprint, flash, g, jsonify, redirect, render_template, request, url_for

from .ai.base import resolve_with_provider
from .auth import login_required
from .db import get_db

bp = Blueprint("settings", __name__)


@bp.route("/settings/ai-providers", methods=("GET",))
@login_required
def ai_providers():
    db = get_db()
    providers = db.execute(
        "SELECT * FROM ai_providers WHERE user_id = ? ORDER BY created_at", (g.user["id"],)
    ).fetchall()
    return render_template("settings.html", providers=providers)


@bp.route("/settings/ai-providers", methods=("POST",))
@login_required
def create_ai_provider():
    name = (request.form.get("name") or "").strip()
    kind = request.form.get("kind")
    base_url = (request.form.get("base_url") or "").strip() or None
    api_key = (request.form.get("api_key") or "").strip() or None
    model = (request.form.get("model") or "").strip() or None

    if not name or kind not in ("api", "local"):
        flash("Name and provider kind are required.")
        return redirect(url_for("settings.ai_providers"))

    db = get_db()
    db.execute(
        "INSERT INTO ai_providers (user_id, name, kind, base_url, api_key, model) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (g.user["id"], name, kind, base_url, api_key, model),
    )
    db.commit()
    flash(f'AI provider "{name}" saved. Resolve-with-AI is not implemented yet.')
    return redirect(url_for("settings.ai_providers"))


@bp.route("/settings/ai-providers/<int:provider_id>", methods=("DELETE",))
@login_required
def delete_ai_provider(provider_id):
    db = get_db()
    db.execute(
        "DELETE FROM ai_providers WHERE id = ? AND user_id = ?", (provider_id, g.user["id"])
    )
    db.commit()
    return jsonify({"ok": True})


@bp.route("/notes/<note_id>/resolve-ai", methods=("POST",))
@login_required
def resolve_ai(note_id):
    payload = request.get_json(silent=True) or {}
    provider_id = payload.get("provider_id")

    db = get_db()
    note = db.execute(
        "SELECT * FROM notes WHERE id = ? AND user_id = ?", (note_id, g.user["id"])
    ).fetchone()
    if note is None:
        return jsonify({"error": "note not found"}), 404

    provider = None
    if provider_id:
        provider = db.execute(
            "SELECT * FROM ai_providers WHERE id = ? AND user_id = ?",
            (provider_id, g.user["id"]),
        ).fetchone()

    try:
        resolve_with_provider(provider, dict(note), None)
    except NotImplementedError as exc:
        return jsonify({"error": str(exc)}), 501
