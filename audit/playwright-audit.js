// MB Finland SEO + content + performance audit via Playwright.
// v3: proper cookie dismissal, full lazy-load wait per viewport, fullPage screenshots
// on every viewport, sitemap/robots.txt parsing, richer SEO signals.

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR     = process.env.OUT_DIR || path.join(__dirname);
const SCREENS_DIR = path.join(OUT_DIR, 'screens');
const DATA_DIR    = path.join(OUT_DIR, 'data');
fs.mkdirSync(SCREENS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR,    { recursive: true });

const TARGETS = [
  { name: 'landing', url: process.env.LANDING_URL || 'https://www.mercedes-benz.fi/' },
  { name: 'model',   url: process.env.MODEL_URL   || 'https://www.mercedes-benz.fi/models/e-class-sedan-w214-806-2/' },
  { name: 'service', url: process.env.SERVICE_URL || 'https://www.mercedes-benz.fi/services/eco-huolto/' },
];

const VIEWPORTS = [
  { tag: 'desktop', width: 1920, height: 1080 },
  { tag: 'laptop',  width: 1280, height: 800  },
  { tag: 'mobile',  width: 414,  height: 896  }, // closer to a real iPhone width
];

// ---------- tiny https GET ----------
function fetchText(url, max = 1_500_000) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 audit-bot' } }, (res) => {
      const chunks = [];
      let len = 0;
      res.on('data', (c) => { len += c.length; if (len < max) chunks.push(c); });
      res.on('end',  () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error',() => resolve({ status: 0, body: '' }));
    }).on('error', () => resolve({ status: 0, body: '' }));
  });
}

// Extract <loc> entries from a sitemap (handles sitemap-index recursion).
async function crawlSitemap(rootUrl, depth = 0, seen = new Set()) {
  if (depth > 3 || seen.has(rootUrl)) return [];
  seen.add(rootUrl);
  const r = await fetchText(rootUrl);
  if (r.status !== 200 || !r.body) return [];
  const locs = [...r.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  // sitemap-index: locs point at child sitemaps; otherwise locs are page URLs
  if (/<sitemapindex/i.test(r.body)) {
    const all = [];
    for (const child of locs.slice(0, 12)) {
      const childUrls = await crawlSitemap(child, depth + 1, seen);
      all.push(...childUrls.map((u) => ({ ...u, from: child })));
    }
    return all;
  }
  return locs.map((u) => ({ url: u, from: rootUrl }));
}

// ---------- cookie banner suppression ----------
const COOKIE_SELECTORS = [
  // Cookiebot
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  '#CybotCookiebotDialogBodyLevelButtonAccept',
  '#CybotCookiebotDialogBodyButtonDecline',
  // OneTrust
  '#onetrust-accept-btn-handler',
  '#onetrust-reject-all-handler',
  // generic
  'button:has-text("Salli kaikki")',
  'button:has-text("Hyväksy kaikki")',
  'button:has-text("Hyväksy")',
  'button:has-text("Accept all")',
  'button:has-text("Accept")',
];

const NUKE_BANNERS_CSS = `
#CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay,
[id^="onetrust"], [class*="onetrust"],
[id*="cookie"], [class*="cookie-banner"], [class*="CookieConsent"],
[aria-label*="cookie" i], [role="dialog"][aria-modal="true"]
{ display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; }
html, body { overflow: auto !important; }
`;

async function dismissCookies(page, pageData) {
  for (const sel of COOKIE_SELECTORS) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      await el.click({ timeout: 3000, force: true }).catch(() => {});
      pageData.cookieClicked = sel;
      await page.waitForTimeout(800);
      break;
    }
  }
  // Always nuke any remaining banner via CSS, in case dismissal failed or revived.
  await page.addStyleTag({ content: NUKE_BANNERS_CSS }).catch(() => {});
}

// Scroll all the way down (in steps), waiting for new content; then back to top.
async function fullLazyScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let lastHeight = 0;
      let stableCount = 0;
      const step = async () => {
        const h = document.documentElement.scrollHeight;
        if (h === lastHeight) stableCount++;
        else { stableCount = 0; lastHeight = h; }
        if (stableCount > 3 || window.scrollY > 25_000) {
          window.scrollTo(0, 0);
          setTimeout(resolve, 600);
          return;
        }
        window.scrollBy(0, Math.min(800, window.innerHeight * 0.9));
        setTimeout(step, 280);
      };
      step();
    });
  }).catch(() => {});
  // Wait for any in-flight images to decode
  await page.evaluate(() => Promise.all(
    Array.from(document.images).filter(i => !i.complete).map(i => new Promise((r) => {
      i.addEventListener('load', r, { once: true });
      i.addEventListener('error', r, { once: true });
    }))
  )).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
}

// ---------- main ----------
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const summary = {};

  // 1) sitemap.xml & robots.txt (one-shot)
  console.log('Fetching sitemap.xml + robots.txt …');
  const robots  = await fetchText('https://www.mercedes-benz.fi/robots.txt');
  const sitemap = await crawlSitemap('https://www.mercedes-benz.fi/sitemap.xml');
  const sitemapByDepth = {};
  const sitemapBySection = {};
  for (const e of sitemap) {
    try {
      const u = new URL(e.url);
      const segs = u.pathname.split('/').filter(Boolean);
      const depth = segs.length;
      sitemapByDepth[depth] = (sitemapByDepth[depth] || 0) + 1;
      const sec = segs[0] || '(root)';
      sitemapBySection[sec] = (sitemapBySection[sec] || 0) + 1;
    } catch {}
  }
  fs.writeFileSync(path.join(DATA_DIR, 'sitemap.json'), JSON.stringify({
    robotsStatus: robots.status,
    robots: robots.body.slice(0, 8000),
    sitemapCount: sitemap.length,
    sitemapByDepth,
    sitemapBySection,
    sample: sitemap.slice(0, 80).map(s => s.url),
  }, null, 2));
  console.log(`  robots.txt: ${robots.status}  sitemap URLs: ${sitemap.length}`);

  // 2) per-page audits
  for (const target of TARGETS) {
    console.log(`\n=== ${target.name}: ${target.url} ===`);
    const pageData = { url: target.url, viewports: {}, console: [], errors: [] };

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'fi-FI',
      timezoneId: 'Europe/Helsinki',
      ignoreHTTPSErrors: true,
      viewport: { width: 1920, height: 1080 },
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'fi-FI,fi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not.A/Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
      },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    const page = await context.newPage();
    page.on('console',  (m) => pageData.console.push({ type: m.type(), text: m.text().slice(0, 500) }));
    page.on('pageerror', (e) => pageData.errors.push(String(e).slice(0, 500)));

    // Per-viewport: load fresh, dismiss banner, lazy-scroll, screenshot fullPage.
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const isFirst = vp.tag === VIEWPORTS[0].tag;
      const t0 = Date.now();
      const resp = await page.goto(target.url, { waitUntil: 'networkidle', timeout: 90000 })
        .catch((e) => { pageData.errors.push('nav ' + vp.tag + ': ' + e.message); return null; });
      if (isFirst) {
        pageData.navMs    = Date.now() - t0;
        pageData.finalUrl = page.url();
        pageData.status   = resp ? resp.status() : null;
      }
      await dismissCookies(page, pageData);
      await fullLazyScroll(page);
      await page.addStyleTag({ content: NUKE_BANNERS_CSS }).catch(() => {}); // double-tap before shot
      await page.waitForTimeout(500);

      const shot = path.join(SCREENS_DIR, `${target.name}-${vp.tag}.png`);
      await page.screenshot({ path: shot, fullPage: true })
        .catch((e) => pageData.errors.push('screenshot ' + vp.tag + ': ' + e.message));
      pageData.viewports[vp.tag] = { shot, width: vp.width, height: vp.height };
      console.log(`  shot ${vp.tag} -> ${shot}`);
    }

    // ---- SEO + content extraction (on desktop, banner already nuked) ----
    await page.setViewportSize({ width: 1920, height: 1080 });
    const seo = await page.evaluate(() => {
      const attr = (sel, a) => { const e = document.querySelector(sel); return e ? e.getAttribute(a) : null; };
      const all  = (sel) => Array.from(document.querySelectorAll(sel));
      const headings = {};
      ['h1','h2','h3','h4','h5','h6'].forEach(h => {
        headings[h] = all(h)
          .filter(n => n.offsetParent !== null) // visible only
          .map(n => n.innerText.replace(/\s+/g,' ').trim())
          .filter(Boolean);
      });
      const headingOrder = all('h1,h2,h3,h4,h5,h6')
        .filter(n => n.offsetParent !== null)
        .map(n => n.tagName)
        .join(' > ').slice(0, 500);

      const images = all('img').map(img => ({
        src: (img.currentSrc || img.src || '').slice(0,200),
        alt: img.getAttribute('alt'),
        w: img.naturalWidth, h: img.naturalHeight,
        loading: img.getAttribute('loading'),
        decoding: img.getAttribute('decoding'),
        hidden: img.offsetParent === null,
        hasExplicitSize: !!(img.getAttribute('width') && img.getAttribute('height')),
      }));

      const host = location.hostname;
      const links = all('a[href]').map(a => {
        let h = '';
        try { h = new URL(a.href).hostname; } catch {}
        return {
          href: a.href.slice(0,200),
          text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0,120),
          rel: a.getAttribute('rel') || '',
          target: a.getAttribute('target') || '',
          host: h,
          internal: h === host || h === '',
        };
      });
      const internal = links.filter(l => l.internal);
      const external = links.filter(l => !l.internal);
      const externalByHost = {};
      external.forEach(l => { externalByHost[l.host] = (externalByHost[l.host] || 0) + 1; });

      const hreflang = all('link[rel="alternate"][hreflang]').map(l => ({
        hreflang: l.getAttribute('hreflang'), href: l.getAttribute('href'),
      }));
      const ldjson = all('script[type="application/ld+json"]').map(s => {
        try { return JSON.parse(s.textContent); } catch { return { _parseError: true, raw: s.textContent.slice(0,300) }; }
      });
      const ldjsonTypes = [];
      const collectTypes = (n) => {
        if (!n) return;
        if (Array.isArray(n)) n.forEach(collectTypes);
        else if (typeof n === 'object') {
          if (n['@type']) ldjsonTypes.push(String(n['@type']));
          if (n['@graph']) collectTypes(n['@graph']);
        }
      };
      ldjson.forEach(collectTypes);

      const metas = {};
      all('meta').forEach(m => {
        const k = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('http-equiv');
        if (k) metas[k] = m.getAttribute('content');
      });

      // Main content text: skip nav/footer/dialog/aside if possible.
      const mainEl = document.querySelector('main') || document.body;
      const mainText = (mainEl.innerText || '').replace(/\s+/g,' ').trim();
      const wordCount = (mainText.match(/\b[\p{L}\d]+\b/gu) || []).length;
      // crude Finnish sentence count for reading-grade hint
      const sentenceCount = (mainText.match(/[.!?]\s/g) || []).length || 1;
      const avgWordsPerSentence = wordCount / sentenceCount;

      return {
        title: document.title,
        lang: document.documentElement.lang,
        charset: document.characterSet,
        canonical: attr('link[rel="canonical"]', 'href'),
        robotsMeta: metas['robots'] || null,
        description: metas['description'] || null,
        viewport: metas['viewport'] || null,
        og:      Object.fromEntries(Object.entries(metas).filter(([k]) => k.startsWith('og:'))),
        twitter: Object.fromEntries(Object.entries(metas).filter(([k]) => k.startsWith('twitter:'))),
        themeColor: metas['theme-color'] || null,
        hreflang,
        headingCounts: Object.fromEntries(Object.entries(headings).map(([k,v]) => [k, v.length])),
        headings,
        headingOrder,
        imageCount:           images.length,
        imagesNoAlt:          images.filter(i => !i.alt || !i.alt.trim()).length,
        imagesEagerAboveFold: images.filter(i => !i.loading || i.loading === 'eager').length,
        imagesNoExplicitSize: images.filter(i => !i.hasExplicitSize).length,
        images: images.slice(0, 40),

        linkCount:       links.length,
        linksInternal:   internal.length,
        linksExternal:   external.length,
        emptyAnchorText: links.filter(l => !l.text).length,
        externalByHost,
        sampleLinks: links.slice(0, 30),

        ldjsonCount: ldjson.length,
        ldjsonTypes,
        ldjson: ldjson.slice(0, 6),

        wordCount,
        sentenceCount,
        avgWordsPerSentence: +avgWordsPerSentence.toFixed(1),
        mainTextSample: mainText.slice(0, 4000),
      };
    });

    // ---- Performance (real PerformanceObserver, longer window) ----
    const perf = await page.evaluate(() => new Promise((resolve) => {
      const out = {};
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) {
        out.navigation = {
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
          loadEvent: Math.round(nav.loadEventEnd),
          ttfb: Math.round(nav.responseStart),
          transferSize: nav.transferSize,
          encodedBodySize: nav.encodedBodySize,
          decodedBodySize: nav.decodedBodySize,
        };
      }
      out.paints = Object.fromEntries(performance.getEntriesByType('paint').map(p => [p.name, Math.round(p.startTime)]));
      const res = performance.getEntriesByType('resource');
      const byType = {};
      let totalTransfer = 0, totalDecoded = 0;
      res.forEach(r => {
        const k = r.initiatorType || 'other';
        byType[k] = byType[k] || { count: 0, transfer: 0, decoded: 0 };
        byType[k].count++;
        byType[k].transfer += r.transferSize || 0;
        byType[k].decoded  += r.decodedBodySize || 0;
        totalTransfer += r.transferSize || 0;
        totalDecoded  += r.decodedBodySize || 0;
      });
      out.resourceSummary = { totalTransfer, totalDecoded, byType, count: res.length };
      out.heaviest = res
        .map(r => ({ url: r.name.slice(0,200), type: r.initiatorType, transfer: r.transferSize, decoded: r.decodedBodySize, dur: Math.round(r.duration) }))
        .sort((a,b) => (b.transfer||0) - (a.transfer||0))
        .slice(0, 20);

      let lcp = 0, cls = 0;
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) lcp = e.startTime; })
        .observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; })
        .observe({ type: 'layout-shift', buffered: true }); } catch {}
      setTimeout(() => {
        out.LCP_ms = Math.round(lcp);
        out.CLS = +cls.toFixed(4);
        resolve(out);
      }, 5000);
    }));

    pageData.seo = seo;
    pageData.perf = perf;
    summary[target.name] = pageData;
    await context.close();
  }

  await browser.close();
  const outFile = path.join(DATA_DIR, 'summary.json');
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log('\nWritten ' + outFile);
})();
