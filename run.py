"""Development entry point: `python run.py` from a checkout.

Keeps the repo's own data/ folder (sample documents live there) and runs the
Flask reloader. The installed app uses `markai.cli` instead — see pyproject's
[project.scripts].
"""

import os

from markai import create_app

app = create_app(data_dir=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))

if __name__ == "__main__":
    app.run(debug=True, port=5000)
