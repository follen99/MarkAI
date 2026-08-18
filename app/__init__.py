import os

from flask import Flask

from . import db


def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=False)

    data_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
    os.makedirs(data_dir, exist_ok=True)

    app.config.from_mapping(
        SECRET_KEY=os.environ.get("MARKAI_SECRET_KEY", "dev-secret-key-change-me"),
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
