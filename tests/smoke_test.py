"""End-to-end smoke test for a packaged MarkAI.

Plain stdlib on purpose (no pytest dependency): CI installs the wheel and runs
this from the tests/ directory, so `import markai` resolves to the *installed*
package. That makes it catch the packaging failure that matters most — templates,
CSS/JS or the vendored pdf.js build missing from the wheel — which importing the
source tree would hide.

    python tests/smoke_test.py
"""

import io
import json
import os
import sys
import tempfile
import zipfile

import markai

EMAIL = "smoke@example.com"
PASSWORD = "smoke-password"

SAMPLE_MD = """# Sample document

Some introductory text that a note can be anchored to.

## A subsection

More text, for the outline.
"""

failures = []


def check(label, condition, detail=""):
    status = "ok  " if condition else "FAIL"
    print(f"  [{status}] {label}{(' — ' + detail) if detail and not condition else ''}")
    if not condition:
        failures.append(label)


def main() -> int:
    print(f"markai {markai.__version__} from {os.path.dirname(markai.__file__)}")

    package_dir = os.path.dirname(os.path.abspath(markai.__file__))
    for asset in (
        "templates/viewer.html",
        "static/css/app.css",
        "static/js/viewer.js",
        "static/vendor/pdfjs/pdf.min.js",
        "static/vendor/pdfjs/pdf.worker.min.js",
    ):
        path = os.path.join(package_dir, *asset.split("/"))
        check(f"packaged asset {asset}", os.path.exists(path), "missing from the install")

    with tempfile.TemporaryDirectory() as data_dir:
        app = markai.create_app(data_dir=data_dir)
        check("data dir created", os.path.isdir(data_dir))
        check("secret key persisted", os.path.exists(os.path.join(data_dir, "secret_key")))
        check(
            "secret key is not the old hardcoded default",
            app.config["SECRET_KEY"] != "dev-secret-key-change-me",
        )

        client = app.test_client()

        client.post("/register", data={"email": EMAIL, "password": PASSWORD})
        login = client.post(
            "/login", data={"email": EMAIL, "password": PASSWORD}, follow_redirects=True
        )
        check("register + login", login.status_code == 200)

        library = client.get("/library")
        check("library page renders", library.status_code == 200)
        check("upload dropzone present", b"dropzone" in library.data)

        upload = client.post(
            "/library/upload",
            data={
                "file": (io.BytesIO(SAMPLE_MD.encode("utf-8")), "sample.md"),
                "title": "Sample document",
            },
            content_type="multipart/form-data",
            follow_redirects=True,
        )
        check("markdown upload", upload.status_code == 200 and b"Sample document" in upload.data)

        with app.app_context():
            row = markai.db.get_db().execute("SELECT id FROM documents LIMIT 1").fetchone()
        check("document stored", row is not None)
        if row is None:
            return report()
        doc_id = row["id"]

        viewer = client.get(f"/documents/{doc_id}/view")
        check("viewer page renders", viewer.status_code == 200)
        check(
            "viewer uses the vendored pdf.js worker",
            b"vendor/pdfjs/pdf.worker.min.js" in viewer.data,
        )
        check("viewer does not call a CDN", b"cdnjs.cloudflare.com" not in viewer.data)

        content = client.get(f"/documents/{doc_id}/content")
        parsed = content.get_json()
        check("parsed content served", content.status_code == 200 and "html" in parsed)
        check("outline built", len(parsed.get("outline") or []) == 2)

        created = client.post(
            f"/documents/{doc_id}/notes",
            json={
                "note": "Rewrite this sentence.",
                "position": {
                    "type": "selection",
                    "line_number": 3,
                    "heading_path": ["Sample document"],
                    "selected_text": "introductory text",
                    "quote": "Some introductory text that",
                },
            },
        )
        check("note created", created.status_code == 201)

        notes_export = client.get(f"/documents/{doc_id}/notes/export?format=notes")
        payload = json.loads(notes_export.data)
        check(
            "notes export",
            notes_export.status_code == 200 and len(payload["notes"]) == 1,
        )
        check(
            "export stays terse",
            set(payload["notes"][0]) == {"id", "status", "note", "location", "quote"},
            str(sorted(payload["notes"][0])),
        )

        bundle = client.get(f"/documents/{doc_id}/notes/export?format=bundle")
        with zipfile.ZipFile(io.BytesIO(bundle.data)) as zf:
            names = sorted(zf.namelist())
        check(
            "bundle export holds both files",
            bundle.status_code == 200
            and len(names) == 2
            and names[0].endswith(".notes.json")
            and names[1].endswith(".notes_status.json"),
            str(names),
        )

    return report()


def report() -> int:
    if failures:
        print(f"\n{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
