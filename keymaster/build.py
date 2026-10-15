"""Builds keymaster.html by inserting analysis.js and export.js into ui.html."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PARTS = {"/*ANALYSIS*/": "analysis.js", "/*EXPORT*/": "export.js"}


def build(root: Path = ROOT, out: Path | None = None) -> Path:
    html = (root / "ui.html").read_text(encoding="utf-8")
    for marker, name in PARTS.items():
        if html.count(marker) != 1:
            raise ValueError(f"ui.html must contain {marker} exactly once")
        # Plain split/join so "$" or backslashes in the JS are never interpreted.
        before, after = html.split(marker)
        html = before + (root / name).read_text(encoding="utf-8") + after
    out = out or root / "keymaster.html"
    out.write_text(html, encoding="utf-8")
    return out


if __name__ == "__main__":
    print(build())
