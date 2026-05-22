#!/usr/bin/env python3
"""
Outpaint car photos to 1:1 with Stability AI, preserving the original
vehicle and synthesizing matching background on the short axis.

Usage
-----
    python3 outpaint.py photo1.jpg photo2.jpg [--out out/] [--size 1024]
    python3 outpaint.py https://.../car.jpg

Requirements: pip install requests pillow
"""
from __future__ import annotations

import argparse
import io
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests
from PIL import Image

STABILITY_KEY = os.environ.get("STABILITY_API_KEY", "")
if not STABILITY_KEY:
    sys.exit("STABILITY_API_KEY env var is required")
ENDPOINT = "https://api.stability.ai/v2beta/stable-image/edit/outpaint"

# Stability's outpaint accepts up to 1536px on the long edge for the input;
# the response can be larger because the model expands the canvas.
MAX_INPUT_SIDE = 1536


def load_image(src: str) -> Image.Image:
    if src.startswith(("http://", "https://")):
        r = requests.get(src, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        return Image.open(io.BytesIO(r.content)).convert("RGB")
    return Image.open(src).convert("RGB")


def downscale_for_api(img: Image.Image) -> Image.Image:
    w, h = img.size
    long_side = max(w, h)
    if long_side <= MAX_INPUT_SIDE:
        return img
    scale = MAX_INPUT_SIDE / long_side
    return img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)


def outpaint_to_square(img: Image.Image, prompt: str = "") -> Image.Image:
    """Extend the shorter axis with Stability outpaint so the result is 1:1."""
    img = downscale_for_api(img)
    w, h = img.size
    if w == h:
        return img

    if w > h:
        # Landscape -> pad top & bottom.
        total = w - h
        up = total // 2
        down = total - up
        left = right = 0
    else:
        # Portrait -> pad left & right.
        total = h - w
        left = total // 2
        right = total - left
        up = down = 0

    buf = io.BytesIO()
    img.save(buf, "PNG")
    buf.seek(0)

    data = {
        "left": str(left),
        "right": str(right),
        "up": str(up),
        "down": str(down),
        "creativity": "0.3",  # low — we want a faithful extension, not invention
        "output_format": "png",
    }
    if prompt:
        data["prompt"] = prompt

    resp = requests.post(
        ENDPOINT,
        headers={
            "Authorization": f"Bearer {STABILITY_KEY}",
            "Accept": "image/*",
        },
        files={"image": ("input.png", buf, "image/png")},
        data=data,
        timeout=120,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Stability API {resp.status_code}: {resp.text[:400]}")

    return Image.open(io.BytesIO(resp.content)).convert("RGB")


def stem_for(src: str) -> str:
    if src.startswith(("http://", "https://")):
        return Path(urlparse(src).path).stem or "image"
    return Path(src).stem


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+", help="image paths or URLs")
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--size", type=int, default=None, help="final square side (resize after outpaint)")
    ap.add_argument(
        "--prompt",
        default="luxury sedan photographed in a modern showroom, soft studio lighting, "
                "matching background, photorealistic, no additional cars",
        help="guidance for the extended region",
    )
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    for i, src in enumerate(args.inputs, 1):
        print(f"[{i}/{len(args.inputs)}] {src}")
        try:
            img = load_image(src)
            print(f"   in : {img.size[0]}x{img.size[1]}")
            sq = outpaint_to_square(img, prompt=args.prompt)
            if args.size and sq.size[0] != args.size:
                sq = sq.resize((args.size, args.size), Image.LANCZOS)
            out_path = args.out / f"{stem_for(src)}-1x1.png"
            sq.save(out_path)
            print(f"   out: {sq.size[0]}x{sq.size[1]} -> {out_path}")
        except Exception as e:
            print(f"   ERR: {e}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
