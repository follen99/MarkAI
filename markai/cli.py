"""Console entry point: `markai` (and `uvx markai`).

Deliberately does the boring local-app things a bare `flask run` doesn't: binds
to loopback only, picks a port that is actually free, serves through waitress
rather than the development server, and opens a browser at the right URL.

Two commands:
    markai                   start the app (the default, so `markai --port X` works)
    markai reset-password    local password recovery, see reset_password_command
"""

import argparse
import getpass
import os
import socket
import sys
import threading
import webbrowser

from . import __version__, create_app, default_data_dir

DEFAULT_PORT = 8765  # not 5000: macOS hands that to the AirPlay receiver
DEFAULT_HOST = "127.0.0.1"


def _port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        # SO_REUSEADDR only on POSIX, where it just skips the TIME_WAIT wait. On
        # Windows the same option means "bind even if someone else already has
        # this port", so setting it here would report every busy port as free.
        if os.name != "nt":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def _resolve_port(host: str, port: int, explicit: bool) -> int:
    """An explicit --port is an instruction, so fail loudly if it's taken. The
    default is just a preference: walk forward, then let the OS choose."""
    if _port_is_free(host, port):
        return port
    if explicit:
        raise SystemExit(f"Port {port} on {host} is already in use.")
    for candidate in range(port + 1, port + 20):
        if _port_is_free(host, candidate):
            return candidate
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return sock.getsockname()[1]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="markai",
        description="Annotate documents locally and export the notes for an AI agent to apply.",
        epilog="Other commands: markai reset-password [--email ADDRESS] [--data-dir DIR]",
    )
    parser.add_argument("--port", type=int, default=None, help=f"port to listen on (default {DEFAULT_PORT})")
    parser.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help="interface to bind (default 127.0.0.1, reachable only from this machine)",
    )
    parser.add_argument(
        "--data-dir",
        default=None,
        help=f"where the database and uploads are kept (default {default_data_dir()})",
    )
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    parser.add_argument("--version", action="version", version=f"markai {__version__}")
    return parser


def reset_password_command(argv) -> int:
    """Password recovery for a local install.

    There is no email to send a link to, and inventing a self-service web reset
    would just be a second unauthenticated way into the app. Physical access to
    the machine is the credential here: whoever can run this command can already
    read the SQLite file, so a terminal prompt is both the simplest and the least
    dangerous recovery path.
    """
    parser = argparse.ArgumentParser(
        prog="markai reset-password",
        description="Set a new password for a MarkAI account on this machine.",
    )
    parser.add_argument("--email", default=None, help="account to reset (asked for if omitted)")
    parser.add_argument("--data-dir", default=None, help="database location")
    parser.add_argument(
        "--password",
        default=None,
        help="new password (omit to be prompted; passing it here leaves it in your shell history)",
    )
    args = parser.parse_args(argv)

    from werkzeug.security import generate_password_hash

    from .db import get_db

    app = create_app(data_dir=args.data_dir)
    with app.app_context():
        db = get_db()
        users = db.execute("SELECT id, email FROM users ORDER BY id").fetchall()
        if not users:
            print("No accounts in this database:", app.config["DATA_DIR"])
            return 1

        email = (args.email or "").strip().lower()
        if not email:
            if len(users) == 1:
                email = users[0]["email"]
                print(f"Account: {email}")
            else:
                print("Accounts in this database:")
                for user in users:
                    print(f"  - {user['email']}")
                email = input("Which one? ").strip().lower()

        target = next((u for u in users if u["email"] == email), None)
        if target is None:
            print(f"No account with email {email!r} in {app.config['DATA_DIR']}")
            return 1

        password = args.password
        if not password:
            password = getpass.getpass("New password: ")
            if password != getpass.getpass("Repeat it: "):
                print("The two passwords don't match.")
                return 1
        if len(password) < 6:
            print("The password must be at least 6 characters.")
            return 1

        db.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (generate_password_hash(password), target["id"]),
        )
        db.commit()

    print(f"Password updated for {email}. Start MarkAI and log in with it.")
    return 0


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    # Hand-rolled instead of argparse subparsers so that the bare `markai` and
    # `markai --port 9000` stay the default command, which is what people type.
    if argv and argv[0] == "reset-password":
        return reset_password_command(argv[1:])
    if argv and argv[0] == "serve":
        argv = argv[1:]

    args = build_parser().parse_args(argv)

    app = create_app(data_dir=args.data_dir)
    port = _resolve_port(args.host, args.port or DEFAULT_PORT, explicit=args.port is not None)
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{port}"

    print(f"MarkAI {__version__}")
    print(f"  data:  {app.config['DATA_DIR']}")
    print(f"  open:  {url}")
    if args.host not in ("127.0.0.1", "localhost"):
        print(
            "  note:  bound to a non-loopback interface: anyone who can reach this\n"
            "         machine can reach your documents. Use a trusted network."
        )
    print("Press Ctrl+C to stop.", flush=True)  # visible straight away even when piped

    if not args.no_browser and not os.environ.get("MARKAI_NO_BROWSER"):
        threading.Timer(0.7, webbrowser.open, args=(url,)).start()

    from waitress import serve

    try:
        serve(app, host=args.host, port=port, threads=8, ident="MarkAI")
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
