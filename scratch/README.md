# scratch/ — outpaint pipeline

Sandboxed Claude Code sessions can't reach `api.stability.ai` or the
MB MENA CDN, so the pipeline runs on a GitHub Actions runner instead.

## One-time setup

Add a repo secret named **`STABILITY_API_KEY`** under
*Settings → Secrets and variables → Actions → New repository secret*.

## Run it

1. Go to the **Actions** tab → **outpaint-cars** → **Run workflow**.
2. Optional inputs: source URL, number of images, prompt.
3. When it finishes, download the **outpainted** artifact — it contains
   `out/*.png` (the 1:1 renders) plus `urls.txt` / `picked.txt` for
   debugging the scrape.

## Files

- `scrape.mjs` — Playwright scraper for the MB MENA listing.
- `outpaint.py` — Stability AI outpaint (extends short axis to 1:1).
- `to_square.py` — earlier white-padding approach, kept for reference.
- `selftest.py` — sanity test for `to_square.pad_to_square`.

## Local run (if you have outbound network)

```bash
cd scratch
npm install playwright && npx playwright install chromium
node scrape.mjs > urls.txt
pip install requests pillow
export STABILITY_API_KEY=sk-...
python3 outpaint.py $(head -2 urls.txt) --out out
```
