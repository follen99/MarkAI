import os
import secrets

from flask import Flask

from . import db

__version__ = "0.2.1"


def default_data_dir() -> str:
    """Where the SQLite file and the uploads live.

    Installed (`uvx markai`) the app is launched from whatever directory the user
    happens to be in, so a CWD-relative folder would scatter databases around;
    per-user application data is the right home. Running from a checkout is the
    exception — `run.py` passes the repo's own `data/` so development keeps its
    sample documents.
    """
    from_env = os.environ.get("MARKAI_DATA_DIR")
    if from_env:
        return os.path.abspath(os.path.expanduser(from_env))

    from platformdirs import user_data_dir

    return user_data_dir("MarkAI", appauthor=False)


def _load_or_create_secret_key(data_dir: str) -> str:
    """Sessions must survive a restart, and the key must not be a constant baked
    into a package everyone downloads — that would make every install's session
    cookies forgeable with the same value. Generate one per install, keep it in
    the data dir with owner-only permissions."""
    env_key = os.environ.get("MARKAI_SECRET_KEY")
    if env_key:
        return env_key

    path = os.path.join(data_dir, "secret_key")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            key = f.read().strip()
        if key:
            return key

    key = secrets.token_hex(32)
    with open(path, "w", encoding="utf-8") as f:
        f.write(key)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # best effort; Windows ACLs don't map onto this
    return key


def create_app(test_config=None, data_dir=None):
    app = Flask(__name__, instance_relative_config=False)

    data_dir = os.path.abspath(data_dir or default_data_dir())
    os.makedirs(data_dir, exist_ok=True)

    app.config.from_mapping(
        SECRET_KEY=_load_or_create_secret_key(data_dir),
        DATA_DIR=data_dir,
        DATABASE=os.path.join(data_dir, "app.db"),
        UPLOAD_DIR=os.path.join(data_dir, "uploads"),
        MAX_CONTENT_LENGTH=64 * 1024 * 1024,
    )
    if test_config:
        app.config.update(test_config)

    os.makedirs(app.config["UPLOAD_DIR"], exist_ok=True)

    db.init_app(app)

    from . import auth
    from . import documents
    from . import notes
    from . import settings

    app.register_blueprint(auth.bp)
    app.register_blueprint(documents.bp)
    app.register_blueprint(notes.bp)
    app.register_blueprint(settings.bp)

    @app.route("/", endpoint="index")
    def index():
        from flask import session, redirect, url_for
        if session.get("user_id"):
            return redirect(url_for("documents.library"))
        return redirect(url_for("auth.login"))

    return app
