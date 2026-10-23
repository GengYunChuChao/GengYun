#!/usr/bin/env python
"""Generate the synthetic sample image used by tools/evidence/tencent-ai-samples.mjs.

Why this file exists
--------------------
The IMS (`ImageModeration`) and OCR (`GeneralAccurateOCR`) sample points need an
image, and the project red line forbids any real photo or personal media. So the
sample is *generated*: a flat white background with one line of black printed
Chinese text. It is committed as a **generator**, never as a binary: the PNG is
written outside the repository (`--out`), and the evidence page records only its
byte length, SHA-256 and pixel size.

Usage
-----
    python tools/evidence/make-sample-image.py --out <path-outside-repo>

The output is deterministic (same text/size/font => same bytes), so the SHA-256
recorded in the evidence page can be reproduced. The script prints a small JSON
blob describing the artifact; it contains no personal data and no credentials.

Red line: this file must never embed a real photo, a real label scan, or any
personal media. Only flat colour + printed text.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# The one line of text the sample carries. It is factual, non-personal and
# intentionally identical in shape to the kind of label heading OCR must read.
SAMPLE_TEXT = "除草剂使用说明"

# 1080x720 keeps the glyphs large enough for OCR while staying far below the
# 2 MiB (2097152 byte) supplier ceiling declared in tools/ai-config.mjs.
DEFAULT_WIDTH = 1080
DEFAULT_HEIGHT = 720
DEFAULT_FONT_SIZE = 104

# Ordered CJK candidates; SimHei is a printed-style sans face, which is what the
# red line asks for ("印刷体"). A tofu fallback would silently produce garbage.
FONT_CANDIDATES = (
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simsun.ttc",
)


def pick_font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in FONT_CANDIDATES:
        path = Path(candidate)
        if path.is_file():
            return ImageFont.truetype(str(path), size)
    raise SystemExit(
        "NO_CJK_FONT: none of " + ", ".join(FONT_CANDIDATES) + " exists; refusing to render tofu glyphs"
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Generate the synthetic IMS/OCR sample image.")
    parser.add_argument("--out", required=True, help="output PNG path (must live outside the repository)")
    parser.add_argument("--width", type=int, default=DEFAULT_WIDTH)
    parser.add_argument("--height", type=int, default=DEFAULT_HEIGHT)
    parser.add_argument("--font-size", type=int, default=DEFAULT_FONT_SIZE)
    args = parser.parse_args(argv)

    out = Path(args.out)
    repo_root = Path(__file__).resolve().parents[2]
    try:
        out.resolve().relative_to(repo_root)
    except ValueError:
        pass
    else:
        raise SystemExit("OUT_INSIDE_REPO: the sample image must not be written into the repository")

    image = Image.new("RGB", (args.width, args.height), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    font = pick_font(args.font_size)

    left, top, right, bottom = draw.textbbox((0, 0), SAMPLE_TEXT, font=font)
    x = (args.width - (right - left)) // 2 - left
    y = (args.height - (bottom - top)) // 2 - top
    draw.text((x, y), SAMPLE_TEXT, font=font, fill=(0, 0, 0))

    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out, format="PNG", optimize=True)

    payload = out.read_bytes()
    print(
        json.dumps(
            {
                "path": str(out),
                "format": "png",
                "width": image.width,
                "height": image.height,
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "text": SAMPLE_TEXT,
                "font_size": args.font_size,
                "synthetic": True,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
