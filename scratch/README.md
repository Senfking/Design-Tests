# scratch/ — outpaint pipeline

Sandboxed Claude Code sessions can't reach `api.stability.ai` or the
MB MENA CDN, so the pipeline runs on a GitHub Actions runner.

## One-time setup

Add a repo secret named **`STABILITY_API_KEY`**:

  https://github.com/Senfking/Design-Tests/settings/secrets/actions/new

## Run it

  https://github.com/Senfking/Design-Tests/actions/workflows/outpaint.yml

Click **Run workflow**, pick branch `claude/adoring-feynman-lr3Ip`, optionally
tweak the source URL / count / prompt, then **Run**.

## Output

The run uploads an artifact named **outpainted** containing:

- `report.html` — open in a browser; gallery of cards with model, price,
  vehicle page link, original image link, and the 1:1 outpainted render
  (images inlined as data URIs, so the file is portable).
- `results.json` — same data as JSON: `{url, model, price, source_image, outpainted_image}` per vehicle.
- `vehicles.json` — full scrape output (everything the scraper found).
- `picked.json` — the subset that was outpainted.
- `out/*.png` — the raw 1:1 outpainted PNGs.

## Files

- `scrape.mjs` — Playwright scraper; emits `vehicles.json` (JSON-LD + DOM heuristic).
- `outpaint.py` — Stability AI outpaint (extends short axis to 1:1).
- `build_report.py` — combines `picked.json` + `out/` into `results.json` + `report.html`.
- `to_square.py` — earlier white-padding approach, kept for reference.
- `selftest.py` — sanity test for `to_square.pad_to_square`.
