import html as html_lib

from docx import Document
from markdown.extensions.toc import slugify

from .util import unique_id

_HEADING_LEVELS = {
    "title": 1,
    "heading 1": 1,
    "heading 2": 2,
    "heading 3": 3,
    "heading 4": 4,
    "heading 5": 5,
    "heading 6": 6,
}


def parse_docx(file_path: str) -> dict:
    """Render a .docx file into HTML paragraphs tagged with their paragraph index
    and a heading outline, so notes can be anchored back to a paragraph.
    """
    document = Document(file_path)
    used_ids = set()
    outline = []
    html_parts = []

    for index, paragraph in enumerate(document.paragraphs):
        text = paragraph.text
        if not text.strip():
            continue

        style_name = (paragraph.style.name or "").strip().lower()
        level = _HEADING_LEVELS.get(style_name)
        inner_html = _render_runs(paragraph)

        if level:
            base_id = slugify(text.strip(), "-") or f"section-{index}"
            block_id = unique_id(base_id, used_ids)
            outline.append({"level": level, "text": text.strip(), "id": block_id})
            id_attr = f' id="{block_id}"'
            level_attr = f' data-heading-level="{level}"'
            tag = f"h{level}"
        else:
            id_attr = ""
            level_attr = ""
            tag = "p"

        html_parts.append(
            f'<div class="doc-block"{id_attr}{level_attr} data-paragraph-index="{index}">'
            f"<{tag}>{inner_html}</{tag}></div>"
        )

    return {"html": "\n".join(html_parts), "outline": outline}


def _render_runs(paragraph) -> str:
    parts = []
    for run in paragraph.runs:
        text = html_lib.escape(run.text)
        if not text:
            continue
        if run.bold:
            text = f"<strong>{text}</strong>"
        if run.italic:
            text = f"<em>{text}</em>"
        parts.append(text)
    rendered = "".join(parts)
    return rendered if rendered else html_lib.escape(paragraph.text)
