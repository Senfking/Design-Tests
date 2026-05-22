#!/usr/bin/env python3
"""Combine scraped vehicle metadata with outpainted images into a report.

Inputs:
  vehicles.json   — full scrape output
  picked.json     — subset that was sent to the outpainter
  out/            — outpainted PNGs (filename stem matches the source image stem)

Outputs:
  results.json    — array of {url, model, price, source_image, outpainted_image}
  report.html     — self-contained gallery (images inlined as data: URIs)
"""
from __future__ import annotations

import argparse
import base64
import html
import json
import sys
from pathlib import Path
from urllib.parse import urlparse


def stem_of_url(url: str) -> str:
    return Path(urlparse(url).path).stem or "image"


def data_uri(p: Path) -> str:
    mime = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--picked", type=Path, required=True)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--results", type=Path, default=Path("results.json"))
    ap.add_argument("--report", type=Path, default=Path("report.html"))
    args = ap.parse_args()

    picked = json.loads(args.picked.read_text())
    results = []
    for v in picked:
        stem = stem_of_url(v["image"])
        candidate = args.out_dir / f"{stem}-1x1.png"
        results.append({
            "url": v.get("url"),
            "model": v.get("model"),
            "price": v.get("price"),
            "source_image": v.get("image"),
            "outpainted_image": str(candidate) if candidate.exists() else None,
        })

    args.results.write_text(json.dumps(results, indent=2))

    # ---- HTML report ---------------------------------------------------------
    cards = []
    for r in results:
        img_html = (
            f'<img src="{data_uri(Path(r["outpainted_image"]))}" alt="outpainted">'
            if r["outpainted_image"]
            else '<div class="missing">outpaint failed</div>'
        )
        cards.append(f"""
        <article class="card">
          {img_html}
          <h2>{html.escape(r["model"] or "—")}</h2>
          <p class="price">{html.escape(r["price"] or "—")}</p>
          <p class="src"><a href="{html.escape(r["url"] or "#")}" target="_blank" rel="noopener">vehicle page →</a></p>
          <p class="src"><a href="{html.escape(r["source_image"] or "#")}" target="_blank" rel="noopener">original image →</a></p>
        </article>
        """)

    page = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Outpaint results</title>
  <style>
    :root {{ color-scheme: dark; --accent: #5b9dd9; }}
    body {{ margin: 0; padding: 32px; background: #0c0c0e; color: #e8e8ea;
            font: 15px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; }}
    h1 {{ font-weight: 500; letter-spacing: .02em; margin: 0 0 24px; }}
    .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 24px; }}
    .card {{ background: #14151a; border: 1px solid #20222a; border-radius: 12px;
             overflow: hidden; padding: 0 0 16px; }}
    .card img {{ width: 100%; aspect-ratio: 1/1; object-fit: cover; display: block; }}
    .card h2 {{ margin: 16px 16px 4px; font-size: 17px; font-weight: 500; }}
    .price {{ margin: 0 16px 8px; color: var(--accent); font-weight: 500; }}
    .src {{ margin: 0 16px; font-size: 13px; }}
    .src a {{ color: #9aa0aa; text-decoration: none; }}
    .src a:hover {{ color: var(--accent); }}
    .missing {{ aspect-ratio: 1/1; display: grid; place-items: center;
                background: #1a1c22; color: #7a7d86; }}
  </style>
</head>
<body>
  <h1>Outpaint results — {len(results)} vehicle{"s" if len(results) != 1 else ""}</h1>
  <div class="grid">{"".join(cards)}</div>
</body>
</html>
"""
    args.report.write_text(page)
    print(f"wrote {args.results} and {args.report}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
