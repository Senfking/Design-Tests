// enrich.mjs — visit each picked vehicle's detail page and replace the
// tiny listing thumbnail with the largest hero image on the page.
//
// Reads & writes picked.json. Also rewrites any netdirector.auto URL's
// base64 payload to drop its resize cap, so we get native resolution.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';

function upgradeNetdirector(url) {
  const m = url.match(/(https:\/\/images\.netdirector\.auto\/)([^?#]+)/);
  if (!m) return url;
  let data;
  try {
    const pad = (4 - (m[2].length % 4)) % 4;
    data = JSON.parse(Buffer.from(m[2] + '='.repeat(pad), 'base64').toString('utf8'));
  } catch {
    return url;
  }
  // Replace whatever resize was baked in with a wide, aspect-preserving one.
  data.edits = { resize: { width: 1920, withoutEnlargement: true } };
  const out = Buffer.from(JSON.stringify(data)).toString('base64').replace(/=+$/, '');
  return m[1] + out;
}

const picked = JSON.parse(readFileSync('picked.json', 'utf8'));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1400 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  ignoreHTTPSErrors: true,
});

for (const v of picked) {
  if (!v.url) continue;
  const page = await ctx.newPage();
  try {
    await page.goto(v.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Force lazy hero/gallery images to attach.
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(1500);

    const hero = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      let best = null, bestArea = 0;
      for (const img of imgs) {
        const w = img.naturalWidth, h = img.naturalHeight;
        if (w < 600 || h < 300) continue;
        let src = img.currentSrc || img.src || '';
        if (src.startsWith('//')) src = 'https:' + src;
        if (!/^https?:/.test(src)) continue;
        if (/logo|icon|sprite|badge|placeholder|avatar/i.test(src)) continue;
        const area = w * h;
        if (area > bestArea) { bestArea = area; best = src; }
      }
      return best;
    });

    if (hero) {
      v.thumb = v.image;
      v.image = upgradeNetdirector(hero);
      console.error(`hero ${v.url}`);
      console.error(`  -> ${v.image}`);
    } else {
      // No hero on detail page — at least upgrade the listing thumb.
      v.image = upgradeNetdirector(v.image);
      console.error(`no hero on ${v.url} — keeping upgraded thumb`);
    }
  } catch (e) {
    console.error(`enrich error ${v.url}: ${e.message}`);
  } finally {
    await page.close();
  }
}

writeFileSync('picked.json', JSON.stringify(picked, null, 2));
await browser.close();
