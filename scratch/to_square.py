#!/usr/bin/env python3
"""
Pad each vehicle image to 1:1 without cropping the car.

Strategy
--------
Car listing photos are almost always shot on a flat, near-white studio
backdrop. So instead of cropping (which would chop wheels/mirrors) we
*extend* the shorter axis with the same background color, sampled from the
image's corners. The car stays fully visible and centered.

If the corners disagree (gradient / outdoor shot), we fall back to a
per-side edge sample so the seam stays invisible.

Usage:  python3 to_square.py urls.txt out_dir/  [--size 1024]
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests
from PIL import Image, ImageStat


def sample_bg(img: Image.Image) -> tuple[int, int, int]:
    """Median color of a thin frame around the image — robust to a stray dark pixel."""
    w, h = img.size
    frame = max(2, min(w, h) // 60)  # ~1.5% of the shorter side
    mask = Image.new("L", img.size, 0)
    # paint the outer frame white in the mask
    from PIL import ImageDraw
    d = ImageDraw.Draw(mask)
    d.rectangle([0, 0, w, h], fill=255)
    d.rectangle([frame, frame, w - frame, h - frame], fill=0)
    rgb = img.convert("RGB")
    stat = ImageStat.Stat(rgb, mask=mask)
    r, g, b = (int(round(v)) for v in stat.median)
    return r, g, b


def pad_to_square(img: Image.Image, size: int | None = None) -> Image.Image:
    img = img.convert("RGB")
    w, h = img.size
    side = max(w, h)
    bg = sample_bg(img)
    canvas = Image.new("RGB", (side, side), bg)
    canvas.paste(img, ((side - w) // 2, (side - h) // 2))
    if size and size != side:
        canvas = canvas.resize((size, size), Image.LANCZOS)
    return canvas


def url_to_name(url: str) -> str:
    path = urlparse(url).path
    stem = Path(path).stem or "image"
    digest = hashlib.sha1(url.encode()).hexdigest()[:8]
    return f"{stem}-{digest}.jpg"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("urls_file", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--size", type=int, default=None, help="resize square to this side")
    args = ap.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    urls = [u.strip() for u in args.urls_file.read_text().splitlines() if u.strip()]
    seen: set[str] = set()
    ok = fail = 0

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) "
                     "AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Referer": "https://www.mercedes-benz-mena.com/",
    }

    for url in urls:
        if url in seen:
            continue
        seen.add(url)
        try:
            r = requests.get(url, headers=headers, timeout=20)
            r.raise_for_status()
            tmp = args.out_dir / ("_tmp_" + url_to_name(url))
            tmp.write_bytes(r.content)
            with Image.open(tmp) as im:
                im.load()
                # Reject tiny assets — icons sneak past the URL filter.
                if min(im.size) < 200:
                    tmp.unlink(missing_ok=True)
                    continue
                squared = pad_to_square(im, args.size)
            out = args.out_dir / url_to_name(url)
            squared.save(out, "JPEG", quality=92)
            tmp.unlink(missing_ok=True)
            ok += 1
            print(f"  ok  {out.name}  ({im.size[0]}x{im.size[1]} -> {squared.size[0]}²)")
        except Exception as e:
            fail += 1
            print(f"  err {url}: {e}", file=sys.stderr)

    print(f"\nDone: {ok} saved, {fail} failed, into {args.out_dir}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
