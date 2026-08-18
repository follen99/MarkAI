import re

import markdown as md_lib
from markdown.extensions.toc import slugify

from .util import unique_id


def parse_markdown(source: str) -> dict:
    """Render markdown into HTML blocks tagged with their source line number and
    a heading outline, so notes made in the UI can be anchored back to a line
    in the original .md source.
    """
    blocks = _split_blocks(source)
    used_ids = set()
    outline = []
    html_parts = []

    for index, (start_line, text) in enumerate(blocks):
        converter = md_lib.Markdown(extensions=["fenced_code", "tables", "sane_lists"])
        block_html = converter.convert(text)

        heading_match = re.match(r"^<h([1-6])[^>]*>(.*?)</h\1>", block_html, re.DOTALL)
        block_id = None
        heading = None
        if heading_match:
            level = int(heading_match.group(1))
            plain_text = re.sub(r"<[^>]+>", "", heading_match.group(2)).strip()
            base_id = slugify(plain_text, "-") or f"section-{index}"
            block_id = unique_id(base_id, used_ids)
            heading = {"level": level, "text": plain_text, "id": block_id}
            outline.append(heading)

        id_attr = f' id="{block_id}"' if block_id else ""
        level_attr = f' data-heading-level="{heading["level"]}"' if heading else ""
        html_parts.append(
            f'<div class="doc-block"{id_attr}{level_attr} data-line="{start_line}" '
            f'data-block-index="{index}">{block_html}</div>'
        )

    return {"html": "\n".join(html_parts), "outline": outline}


def _split_blocks(source: str):
    """Split markdown source into (start_line_number, text) blocks on blank lines."""
    lines = source.split("\n")
    blocks = []
    current = []
    current_start = None
    for i, line in enumerate(lines, start=1):
        if line.strip() == "":
            if current:
                blocks.append((current_start, "\n".join(current)))
                current = []
                current_start = None
        else:
            if current_start is None:
                current_start = i
            current.append(line)
    if current:
        blocks.append((current_start, "\n".join(current)))
    return blocks
