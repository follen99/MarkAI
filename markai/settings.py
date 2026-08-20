from flask import Blueprint, flash, g, jsonify, redirect, render_template, request, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from .ai.base import resolve_with_provider
from .auth import login_required
from .db import get_db

bp = Blueprint("settings", __name__)

MIN_PASSWORD_LENGTH = 6


def _render_settings():
    db = get_db()
    providers = db.execute(
        "SELECT * FROM ai_providers WHERE user_id = ? ORDER BY created_at", (g.user["id"],)
    ).fetchall()
    return render_template("settings.html", providers=providers)


@bp.route("/settings", methods=("GET",))
@login_required
def index():
    return _render_settings()


# The AI-provider page used to live at this URL on its own; it is a section of
# /settings now. Kept as a redirect so old links and bookmarks still land.
@bp.route("/settings/ai-providers", methods=("GET",))
@login_required
def ai_providers():
    return redirect(url_for("settings.index"))


@bp.route("/settings/password", methods=("POST",))
@login_required
def change_password():
    current = request.form.get("current_password") or ""
    new = request.form.get("new_password") or ""
    confirm = request.form.get("confirm_password") or ""

    db = get_db()
    user = db.execute("SELECT * FROM users WHERE id = ?", (g.user["id"],)).fetchone()

    if not check_password_hash(user["password_hash"], current):
        # Requiring the current password is what stops a walked-away-from session
        # (or a CSRF, which this app doesn't defend against) from locking the
        # owner out of their own install.
        flash("Your current password is not correct.")
    elif len(new) < MIN_PASSWORD_LENGTH:
        flash(f"The new password must be at least {MIN_PASSWORD_LENGTH} characters.")
    elif new != confirm:
        flash("The two new passwords don't match.")
    elif new == current:
        flash("The new password is the same as the current one.")
    else:
        db.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (generate_password_hash(new), user["id"]),
        )
        db.commit()
        flash("Password changed.")

    return redirect(url_for("settings.index"))


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
        return redirect(url_for("settings.index"))

    db = get_db()
    db.execute(
        "INSERT INTO ai_providers (user_id, name, kind, base_url, api_key, model) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (g.user["id"], name, kind, base_url, api_key, model),
    )
    db.commit()
    flash(f'AI provider "{name}" saved. Resolve-with-AI is not implemented yet.')
    return redirect(url_for("settings.index"))


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
