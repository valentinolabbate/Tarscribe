from __future__ import annotations

from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape

import reportlab
import yaml
from markdown_it import MarkdownIt
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable,
    ListFlowable,
    ListItem,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

_FONT_DIR = Path(reportlab.__file__).parent / "fonts"
_FONT_NAMES = {
    "normal": "TarscribeBody",
    "bold": "TarscribeBold",
    "italic": "TarscribeItalic",
    "bold_italic": "TarscribeBoldItalic",
}


def _register_fonts() -> None:
    if _FONT_NAMES["normal"] in pdfmetrics.getRegisteredFontNames():
        return
    pdfmetrics.registerFont(TTFont(_FONT_NAMES["normal"], _FONT_DIR / "Vera.ttf"))
    pdfmetrics.registerFont(TTFont(_FONT_NAMES["bold"], _FONT_DIR / "VeraBd.ttf"))
    pdfmetrics.registerFont(TTFont(_FONT_NAMES["italic"], _FONT_DIR / "VeraIt.ttf"))
    pdfmetrics.registerFont(TTFont(_FONT_NAMES["bold_italic"], _FONT_DIR / "VeraBI.ttf"))
    pdfmetrics.registerFontFamily(
        _FONT_NAMES["normal"],
        normal=_FONT_NAMES["normal"],
        bold=_FONT_NAMES["bold"],
        italic=_FONT_NAMES["italic"],
        boldItalic=_FONT_NAMES["bold_italic"],
    )


def _supported_chars() -> set[int]:
    _register_fonts()
    font = pdfmetrics.getFont(_FONT_NAMES["normal"])
    return set(font.face.charToGlyph)


_REPLACEMENTS = {
    "✅": "[x]",
    "☑": "[x]",
    "☐": "[ ]",
    "⬜": "[ ]",
    "➡": "->",
    "→": "->",
    "•": "-",
}


def _safe_text(value: str) -> str:
    for source, replacement in _REPLACEMENTS.items():
        value = value.replace(source, replacement)
    supported = _supported_chars()
    return "".join(
        char if char in "\n\t" or ord(char) in supported else "?" for char in value
    )


def _inline_markup(token) -> str:
    output: list[str] = []
    for child in token.children or []:
        kind = child.type
        if kind == "text":
            output.append(escape(_safe_text(child.content)))
        elif kind in {"softbreak", "hardbreak"}:
            output.append("<br/>")
        elif kind == "strong_open":
            output.append("<b>")
        elif kind == "strong_close":
            output.append("</b>")
        elif kind == "em_open":
            output.append("<i>")
        elif kind == "em_close":
            output.append("</i>")
        elif kind == "s_open":
            output.append("<strike>")
        elif kind == "s_close":
            output.append("</strike>")
        elif kind == "code_inline":
            output.append(f"<font name='{_FONT_NAMES['normal']}'><b>")
            output.append(escape(_safe_text(child.content)))
            output.append("</b></font>")
        elif kind == "link_open":
            href = child.attrGet("href") or ""
            if href.startswith(("http://", "https://")):
                output.append(f"<link href='{escape(href)}' color='#176f68'>")
        elif kind == "link_close":
            output.append("</link>")
        elif kind == "image":
            output.append(escape(_safe_text(child.content or "Bild")))
    return "".join(output)


def _extract_frontmatter(content: str) -> tuple[dict, str]:
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    if not normalized.startswith("---\n"):
        return {}, normalized
    end = normalized.find("\n---\n", 4)
    if end < 0:
        return {}, normalized
    try:
        metadata = yaml.safe_load(normalized[4:end]) or {}
    except yaml.YAMLError:
        return {}, normalized
    return (metadata if isinstance(metadata, dict) else {}), normalized[end + 5 :]


def _styles() -> dict[str, ParagraphStyle]:
    def style(name: str, **overrides) -> ParagraphStyle:
        values = {
            "fontName": _FONT_NAMES["normal"],
            "textColor": colors.HexColor("#192521"),
            **overrides,
        }
        return ParagraphStyle(name, **values)

    return {
        "title": style(
            "SummaryTitle",
            fontName=_FONT_NAMES["bold"],
            fontSize=22,
            leading=27,
            spaceAfter=5 * mm,
        ),
        "meta": style(
            "SummaryMeta",
            fontSize=8.5,
            leading=11,
            textColor=colors.HexColor("#62706b"),
            spaceAfter=4 * mm,
        ),
        "body": style(
            "SummaryBody",
            fontSize=10.5,
            leading=15,
            spaceAfter=3.2 * mm,
            splitLongWords=True,
        ),
        "h1": style(
            "SummaryH1",
            fontName=_FONT_NAMES["bold"],
            fontSize=17,
            leading=21,
            spaceBefore=4 * mm,
            spaceAfter=2.5 * mm,
            keepWithNext=True,
        ),
        "h2": style(
            "SummaryH2",
            fontName=_FONT_NAMES["bold"],
            fontSize=14,
            leading=18,
            textColor=colors.HexColor("#176f68"),
            spaceBefore=3.5 * mm,
            spaceAfter=2 * mm,
            keepWithNext=True,
        ),
        "h3": style(
            "SummaryH3",
            fontName=_FONT_NAMES["bold"],
            fontSize=11.5,
            leading=15,
            spaceBefore=3 * mm,
            spaceAfter=1.5 * mm,
            keepWithNext=True,
        ),
        "quote": style(
            "SummaryQuote",
            fontSize=10,
            leading=14,
            leftIndent=5 * mm,
            rightIndent=2 * mm,
            borderColor=colors.HexColor("#69a59f"),
            borderWidth=1.2,
            borderPadding=7,
            backColor=colors.HexColor("#edf6f4"),
            spaceBefore=1.5 * mm,
            spaceAfter=3.5 * mm,
        ),
        "code": style(
            "SummaryCode",
            fontSize=8.5,
            leading=11,
            leftIndent=3 * mm,
            rightIndent=3 * mm,
            borderPadding=6,
            backColor=colors.HexColor("#f1f3f2"),
            spaceBefore=1.5 * mm,
            spaceAfter=3 * mm,
        ),
        "table": style(
            "SummaryTable",
            fontSize=8.5,
            leading=11,
        ),
        "table_header": style(
            "SummaryTableHeader",
            fontName=_FONT_NAMES["bold"],
            fontSize=8.5,
            leading=11,
            textColor=colors.white,
        ),
    }


def _consume_list(tokens, start: int, styles: dict[str, ParagraphStyle]):
    open_type = tokens[start].type
    close_type = open_type.replace("_open", "_close")
    ordered = open_type == "ordered_list_open"
    items: list[ListItem] = []
    current: list[str] | None = None
    depth = 1
    index = start + 1
    while index < len(tokens) and depth:
        token = tokens[index]
        if token.type == open_type:
            depth += 1
        elif token.type == close_type:
            depth -= 1
            if depth == 0:
                break
        elif token.type == "list_item_open" and depth == 1:
            current = []
        elif token.type == "inline" and current is not None and depth == 1:
            current.append(_inline_markup(token))
        elif token.type == "list_item_close" and current is not None and depth == 1:
            items.append(
                ListItem(
                    Paragraph("<br/>".join(current), styles["body"]),
                    leftIndent=5 * mm,
                )
            )
            current = None
        index += 1
    flowable = ListFlowable(
        items,
        bulletType="1" if ordered else "bullet",
        start=(tokens[start].attrGet("start") or "1") if ordered else None,
        leftIndent=5 * mm,
        bulletFontName=_FONT_NAMES["normal"],
        bulletFontSize=9,
        spaceAfter=2.5 * mm,
    )
    return flowable, index + 1


def _consume_blockquote(tokens, start: int, styles: dict[str, ParagraphStyle]):
    parts: list[str] = []
    index = start + 1
    depth = 1
    while index < len(tokens) and depth:
        token = tokens[index]
        if token.type == "blockquote_open":
            depth += 1
        elif token.type == "blockquote_close":
            depth -= 1
            if depth == 0:
                break
        elif token.type == "inline":
            parts.append(_inline_markup(token))
        index += 1
    return Paragraph("<br/>".join(parts), styles["quote"]), index + 1


def _consume_table(tokens, start: int, styles: dict[str, ParagraphStyle]):
    rows: list[list[Paragraph]] = []
    row: list[Paragraph] | None = None
    header = False
    cell_header = False
    index = start + 1
    while index < len(tokens):
        token = tokens[index]
        if token.type == "table_close":
            break
        if token.type == "thead_open":
            header = True
        elif token.type == "thead_close":
            header = False
        elif token.type == "tr_open":
            row = []
        elif token.type == "tr_close" and row is not None:
            rows.append(row)
            row = None
        elif token.type in {"th_open", "td_open"}:
            cell_header = header or token.type == "th_open"
        elif token.type == "inline" and row is not None:
            style = styles["table_header"] if cell_header else styles["table"]
            row.append(Paragraph(_inline_markup(token), style))
        index += 1
    table = Table(rows, repeatRows=1 if rows else 0, hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#176f68")),
                ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#f7f9f8")),
                ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#cfd8d5")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    return table, index + 1


def _markdown_story(content: str, styles: dict[str, ParagraphStyle]) -> list:
    parser = MarkdownIt("commonmark", {"html": False}).enable("table").enable("strikethrough")
    tokens = parser.parse(content)
    story: list = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.type == "heading_open" and index + 1 < len(tokens):
            level = int(token.tag[1:]) if token.tag.startswith("h") else 3
            style = styles["h1" if level == 1 else "h2" if level == 2 else "h3"]
            story.append(Paragraph(_inline_markup(tokens[index + 1]), style))
            index += 3
            continue
        if token.type == "paragraph_open" and index + 1 < len(tokens):
            story.append(Paragraph(_inline_markup(tokens[index + 1]), styles["body"]))
            index += 3
            continue
        if token.type in {"bullet_list_open", "ordered_list_open"}:
            flowable, index = _consume_list(tokens, index, styles)
            story.append(flowable)
            continue
        if token.type == "blockquote_open":
            flowable, index = _consume_blockquote(tokens, index, styles)
            story.append(flowable)
            continue
        if token.type == "table_open":
            flowable, index = _consume_table(tokens, index, styles)
            story.extend([flowable, Spacer(1, 3 * mm)])
            continue
        if token.type in {"fence", "code_block"}:
            story.append(Preformatted(_safe_text(token.content.rstrip()), styles["code"]))
        elif token.type == "hr":
            story.append(
                HRFlowable(
                    width="100%",
                    thickness=0.6,
                    color=colors.HexColor("#cfd8d5"),
                    spaceBefore=2 * mm,
                    spaceAfter=3 * mm,
                )
            )
        index += 1
    return story


def render_summary_pdf(content: str, recording_title: str) -> bytes:
    _register_fonts()
    metadata, body = _extract_frontmatter(content)
    styles = _styles()
    title = str(metadata.get("title") or recording_title or "Zusammenfassung")
    details = [
        str(value)
        for value in (
            metadata.get("date"),
            metadata.get("duration"),
            metadata.get("topic_area"),
        )
        if value
    ]
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=_safe_text(title),
        author="Tarscribe",
        allowSplitting=True,
    )
    story = [Paragraph(escape(_safe_text(title)), styles["title"])]
    if details:
        story.append(Paragraph(escape(_safe_text(" · ".join(details))), styles["meta"]))
    story.append(
        HRFlowable(
            width="100%",
            thickness=1,
            color=colors.HexColor("#69a59f"),
            spaceAfter=5 * mm,
        )
    )
    story.extend(_markdown_story(body, styles))

    def page_footer(canvas, document) -> None:
        canvas.saveState()
        canvas.setFont(_FONT_NAMES["normal"], 7.5)
        canvas.setFillColor(colors.HexColor("#71807b"))
        canvas.drawString(18 * mm, 9 * mm, _safe_text(recording_title))
        canvas.drawRightString(A4[0] - 18 * mm, 9 * mm, f"Seite {document.page}")
        canvas.restoreState()

    doc.build(story, onFirstPage=page_footer, onLaterPages=page_footer)
    return buffer.getvalue()
