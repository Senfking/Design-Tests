// scrape.mjs — open the MB MENA C-Class listing and harvest vehicle cards.
// Output: vehicles.json on stdout — array of {url, image, model, price}.
//
// Strategy:
//   1. Prefer JSON-LD (<script type=application/ld+json>) — most reliable when present.
//   2. Fall back to a DOM walk anchored on price text (regex /AED\s*[\d,]+/),
//      walking up to the nearest card container, then pulling image + heading
//      + the anchor that links to the vehicle detail page.
// Both strategies feed into the same de-dup pass (keyed by detail URL).

import { chromium } from 'playwright';

const SOURCE_URL =
  process.env.SOURCE_URL ||
  'https://www.mercedes-benz-mena.com/dubai/en/buy-new/?manufacturer%5B0%5D=Mercedes-Benz&model%5B0%5D=C-Class&nfcSearchVersion=1.0.0';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 2400 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();

await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

// Listing is client-rendered; scroll to force lazy cards & images.
for (let i = 0; i < 8; i++) {
  await page.mouse.wheel(0, 1800);
  await page.waitForTimeout(700);
}
await page.waitForTimeout(1500);

const vehicles = await page.evaluate(() => {
  const absolutise = (u) => {
    if (!u) return null;
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('/')) return location.origin + u;
    if (!/^https?:/.test(u)) return null;
    return u;
  };
  const priceRe = /(AED|USD|EUR|SAR|QAR|KWD|\$|€)\s*[\d,]+(\.\d+)?/i;

  // ---- 1. JSON-LD ----------------------------------------------------------
  const ldCards = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    let data;
    try { data = JSON.parse(s.textContent); } catch { return; }
    const items = Array.isArray(data) ? data : [data];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      const t = node['@type'];
      const types = Array.isArray(t) ? t : [t];
      if (types.some((x) => /Vehicle|Car|Product/i.test(x || ''))) {
        const offers = node.offers || {};
        const offer = Array.isArray(offers) ? offers[0] : offers;
        const price = offer?.price ?? offer?.priceSpecification?.price;
        const currency = offer?.priceCurrency ?? offer?.priceSpecification?.priceCurrency ?? '';
        ldCards.push({
          url: absolutise(node.url || offer?.url),
          image: absolutise(Array.isArray(node.image) ? node.image[0] : node.image),
          model: node.name || node.model || null,
          price: price ? `${currency} ${price}`.trim() : null,
        });
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') walk(v);
      }
    };
    items.forEach(walk);
  });

  // ---- 2. DOM heuristic — anchor on price text -----------------------------
  const domCards = [];
  const allEls = Array.from(document.querySelectorAll('body *'));
  const priceEls = allEls.filter((el) => {
    if (el.children.length > 3) return false;
    const txt = (el.textContent || '').trim();
    if (txt.length > 60) return false;
    return priceRe.test(txt);
  });

  for (const pEl of priceEls) {
    let card = pEl;
    for (let i = 0; i < 8 && card; i++) {
      const a = card.querySelector?.('a[href]');
      const img = card.querySelector?.('img');
      if (a && img) break;
      card = card.parentElement;
    }
    if (!card) continue;
    const a = card.querySelector('a[href]');
    const img = card.querySelector('img');
    if (!a || !img) continue;
    const heading =
      card.querySelector('h1, h2, h3, h4, [class*="title" i], [class*="model" i], [class*="name" i]');
    const model = heading?.textContent?.trim() || a.getAttribute('title') || a.textContent?.trim() || null;
    domCards.push({
      url: absolutise(a.href),
      image: absolutise(img.currentSrc || img.src || (img.getAttribute('srcset') || '').split(',')[0]?.trim().split(/\s+/)[0]),
      model: model && model.length < 200 ? model : null,
      price: (pEl.textContent || '').trim(),
    });
  }

  // ---- 3. merge + de-dup by URL --------------------------------------------
  const byUrl = new Map();
  for (const c of [...ldCards, ...domCards]) {
    if (!c.url || !c.image) continue;
    const key = c.url.split('#')[0];
    const prev = byUrl.get(key) || {};
    byUrl.set(key, {
      url: key,
      image: c.image || prev.image,
      model: c.model || prev.model,
      price: c.price || prev.price,
    });
  }
  return [...byUrl.values()];
});

process.stdout.write(JSON.stringify(vehicles, null, 2) + '\n');
console.error(`scraped ${vehicles.length} vehicle cards`);

await browser.close();
