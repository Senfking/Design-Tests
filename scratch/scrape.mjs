// scrape.mjs — open the MB MENA listing, wait for cards to render, harvest image URLs.
// Usage: NODE_PATH=/opt/node22/lib/node_modules node scrape.mjs > urls.txt

import { chromium } from 'playwright';

const URL =
  'https://www.mercedes-benz-mena.com/dubai/en/buy-new/?manufacturer%5B0%5D=Mercedes-Benz&model%5B0%5D=C-Class&nfcSearchVersion=1.0.0';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 2400 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  ignoreHTTPSErrors: true, // sandbox proxy presents a custom CA
});
const page = await ctx.newPage();

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

// The listing is client-rendered; scroll to force lazy images to attach.
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, 1800);
  await page.waitForTimeout(700);
}
await page.waitForTimeout(1500);

// Pull every <img> + any srcset/background-image; filter to vehicle photos.
const urls = await page.evaluate(() => {
  const out = new Set();
  const push = (u) => {
    if (!u) return;
    if (u.startsWith('//')) u = 'https:' + u;
    if (!/^https?:/.test(u)) return;
    out.add(u);
  };
  document.querySelectorAll('img').forEach((img) => {
    push(img.currentSrc || img.src);
    const ss = img.getAttribute('srcset');
    if (ss) {
      ss.split(',').forEach((part) => push(part.trim().split(/\s+/)[0]));
    }
  });
  document.querySelectorAll('*').forEach((el) => {
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg.startsWith('url(')) {
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m) push(m[1]);
    }
  });
  return [...out];
});

// Heuristic: MB MENA serves car photos from its media CDN; exclude icons/logos/sprites.
const isVehicle = (u) => {
  const low = u.toLowerCase();
  if (!/\.(jpe?g|png|webp)(\?|$)/.test(low)) return false;
  if (/(logo|icon|sprite|favicon|placeholder|flag|badge)/.test(low)) return false;
  // Vehicle stock photos are typically larger than 600px on a side; many CDNs encode that in the URL.
  return true;
};

const filtered = urls.filter(isVehicle);
for (const u of filtered) console.log(u);

await browser.close();
