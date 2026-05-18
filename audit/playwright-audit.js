// MB Finland audit — v4: single navigation per page, then resize-and-rescroll for
// each viewport. networkidle replaced with `load` + bounded idle wait. Robust
// sitemap discovery via robots.txt.

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const zlib  = require('zlib');

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

// One desktop full-page screenshot per page is the headline; the other two are
// viewport-sized so capture is fast and visually representative of mobile UX.
const VIEWPORTS = [
  { tag: 'desktop', width: 1920, height: 1080, fullPage: true  },
  { tag: 'laptop',  width: 1280, height: 800,  fullPage: false },
  { tag: 'mobile',  width: 414,  height: 896,  fullPage: false, isMobile: true },
];

// ---------- tiny https GET with hard timeout + global request cap ----------
let _httpReqCount = 0;
const _httpReqMax = 30;

function fetchText(url, { max = 4_000_000, timeoutMs = 8000 } = {}) {
  if (_httpReqCount++ >= _httpReqMax) return Promise.resolve({ status: 0, body: '', _capped: true });
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 audit-bot',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          return finish(fetchText(next, { max, timeoutMs }).then((v) => finish(v)));
        } catch {}
      }
      // pick a decoder based on Content-Encoding OR file extension (.gz)
      let stream = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      const isGz = /\.gz(\?|$)/i.test(url);
      if (enc === 'gzip' || isGz)      stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate')      stream = res.pipe(zlib.createInflate());
      else if (enc === 'br')           stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = []; let len = 0;
      stream.on('data', (c) => { len += c.length; if (len < max) chunks.push(c); });
      stream.on('end',  () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error',() => finish({ status: 0, body: '' }));
      res.on('error',   () => finish({ status: 0, body: '' }));
    });
    req.on('timeout', () => { req.destroy(); finish({ status: 0, body: '', _timeout: true }); });
    req.on('error',   () => finish({ status: 0, body: '' }));
  });
}

async function crawlSitemap(rootUrl, depth = 0, seen = new Set(), collected = { count: 0 }) {
  if (depth > 2 || seen.has(rootUrl) || collected.count > 4000 || _httpReqCount > _httpReqMax) return [];
  seen.add(rootUrl);
  const r = await fetchText(rootUrl);
  if (r.status !== 200 || !r.body) return [];
  const locs = [...r.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  if (/<sitemapindex/i.test(r.body)) {
    const all = [];
    for (const child of locs.slice(0, 10)) {
      if (collected.count > 4000 || _httpReqCount > _httpReqMax) break;
      const childUrls = await crawlSitemap(child, depth + 1, seen, collected);
      all.push(...childUrls);
    }
    return all;
  }
  collected.count += locs.length;
  return locs.map((u) => ({ url: u, from: rootUrl }));
}

async function findAndCrawlSitemaps() {
  const robotsR = await fetchText('https://www.mercedes-benz.fi/robots.txt');
  const sitemapUrls = [];
  if (robotsR.status === 200) {
    const m = robotsR.body.matchAll(/^\s*Sitemap:\s*(\S+)/gmi);
    for (const x of m) sitemapUrls.push(x[1].trim());
  }
  if (!sitemapUrls.length) {
    sitemapUrls.push(
      'https://www.mercedes-benz.fi/sitemap.xml',
      'https://www.mercedes-benz.fi/sitemap_index.xml',
    );
  }
  const all = [];
  for (const s of sitemapUrls.slice(0, 4)) {
    const urls = await crawlSitemap(s);
    all.push(...urls);
  }
  return { robots: robotsR, sitemapUrls, urls: all };
}

// run with a hard wall-clock deadline; partial = ok
async function withDeadline(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// ---------- cookie banner ----------
const COOKIE_SELECTORS = [
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyLevelButtonAccept',
  '#CybotCookiebotDialogBodyButtonAccept',
  '#CybotCookiebotDialogBodyButtonDecline',
  '#onetrust-accept-btn-handler',
  '#onetrust-reject-all-handler',
  'button:has-text("Salli kaikki")',
  'button:has-text("Hyväksy kaikki")',
  'button:has-text("Hyväksy")',
  'button:has-text("Accept all")',
];

const NUKE_BANNERS_CSS = `
#CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay,
[id^="onetrust"], [class*="onetrust"],
[id*="cookie" i][role="dialog"], [class*="cookie-banner" i],
[class*="CookieConsent"], [aria-modal="true"][role="dialog"]
{ display: none !important; visibility: hidden !important; pointer-events: none !important; }
html, body { overflow: auto !important; }
`;

async function dismissCookies(page, pageData) {
  for (const sel of COOKIE_SELECTORS) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      await el.click({ timeout: 2500, force: true }).catch(() => {});
      pageData.cookieClicked = sel;
      await page.waitForTimeout(500);
      break;
    }
  }
  await page.addStyleTag({ content: NUKE_BANNERS_CSS }).catch(() => {});
}

async function lazyScroll(page, maxPx = 18000) {
  // bounded scroll
  await Promise.race([
    page.evaluate(async (cap) => {
      await new Promise((resolve) => {
        let lastH = 0, stable = 0, ticks = 0;
        const tick = () => {
          ticks++;
          const h = document.documentElement.scrollHeight;
          if (h === lastH) stable++; else { stable = 0; lastH = h; }
          if (stable > 2 || window.scrollY > cap || ticks > 80) {
            window.scrollTo(0, 0);
            setTimeout(resolve, 400);
            return;
          }
          window.scrollBy(0, Math.min(900, window.innerHeight * 0.9));
          setTimeout(tick, 220);
        };
        tick();
      });
    }, maxPx).catch(() => {}),
    new Promise((r) => setTimeout(r, 22_000)),
  ]);
  // wait for any in-flight EAGER images (not lazy), hard-capped at 4s
  await Promise.race([
    page.evaluate(() => Promise.all(
      Array.from(document.images)
        .filter(i => !i.complete && i.loading !== 'lazy')
        .map(i => new Promise(r => {
          i.addEventListener('load',  r, { once: true });
          i.addEventListener('error', r, { once: true });
        }))
    )).catch(() => {}),
    new Promise((r) => setTimeout(r, 4_000)),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
}

// ---------- main ----------
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const summary = {};

  const PAGE_DEADLINE_MS = 150_000; // 2.5 min per page is the hard ceiling
  for (const target of TARGETS) {
    console.log(`\n=== ${target.name}: ${target.url} ===`);
    const t0 = Date.now();
    const pageData = { url: target.url, viewports: {}, console: [], errors: [] };

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'fi-FI',
      timezoneId: 'Europe/Helsinki',
      ignoreHTTPSErrors: true,
      viewport: { width: 1920, height: 1080 },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });
    const page = await context.newPage();
    page.on('console',  (m) => pageData.console.push({ type: m.type(), text: m.text().slice(0, 500) }));
    page.on('pageerror', (e) => pageData.errors.push(String(e).slice(0, 500)));

    const work = (async () => {
      const navStart = Date.now();
      const resp = await page.goto(target.url, { waitUntil: 'load', timeout: 60000 })
        .catch((e) => { pageData.errors.push('nav: ' + e.message); return null; });
      pageData.navMs    = Date.now() - navStart;
      pageData.finalUrl = page.url();
      pageData.status   = resp ? resp.status() : null;

      await dismissCookies(page, pageData);

      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.evaluate(() => window.dispatchEvent(new Event('resize'))).catch(() => {});
        await page.waitForTimeout(500);
        await lazyScroll(page);
        await page.addStyleTag({ content: NUKE_BANNERS_CSS }).catch(() => {});
        await page.waitForTimeout(250);
        const shot = path.join(SCREENS_DIR, `${target.name}-${vp.tag}.png`);
        await Promise.race([
          page.screenshot({ path: shot, fullPage: !!vp.fullPage }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('screenshot timeout')), 25_000)),
        ]).catch((e) => pageData.errors.push('screenshot ' + vp.tag + ': ' + e.message));
        pageData.viewports[vp.tag] = { shot, width: vp.width, height: vp.height, fullPage: !!vp.fullPage };
        console.log(`  shot ${vp.tag} (${Date.now() - t0}ms total)`);
      }
      return 'work-done';
    })();

    const result = await Promise.race([
      work,
      new Promise((resolve) => setTimeout(() => resolve('deadline'), PAGE_DEADLINE_MS)),
    ]);
    if (result === 'deadline') {
      pageData.errors.push(`page deadline (${PAGE_DEADLINE_MS}ms) hit; aborting page`);
      console.log(`  ! DEADLINE hit for ${target.name}, moving on`);
      await context.close().catch(() => {});
      summary[target.name] = pageData;
      continue;
    }

    // ---- SEO + content extraction (back to desktop) ----
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    const seo = await page.evaluate(() => {
      const attr = (sel, a) => { const e = document.querySelector(sel); return e ? e.getAttribute(a) : null; };
      const all  = (sel) => Array.from(document.querySelectorAll(sel));
      const headings = {};
      ['h1','h2','h3','h4','h5','h6'].forEach(h => {
        headings[h] = all(h)
          .filter(n => n.offsetParent !== null)
          .map(n => n.innerText.replace(/\s+/g,' ').trim())
          .filter(Boolean);
      });
      const headingOrder = all('h1,h2,h3,h4,h5,h6')
        .filter(n => n.offsetParent !== null)
        .map(n => n.tagName).join(' > ').slice(0, 500);

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
        let h = ''; try { h = new URL(a.href).hostname; } catch {}
        return {
          href: a.href.slice(0,200),
          text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0,120),
          rel: a.getAttribute('rel') || '',
          target: a.getAttribute('target') || '',
          host: h,
          internal: h === host || h === '',
        };
      });
      const externalByHost = {};
      links.filter(l => !l.internal).forEach(l => { externalByHost[l.host] = (externalByHost[l.host] || 0) + 1; });

      const hreflang = all('link[rel="alternate"][hreflang]').map(l => ({
        hreflang: l.getAttribute('hreflang'), href: l.getAttribute('href'),
      }));
      const ldjson = all('script[type="application/ld+json"]').map(s => {
        try { return JSON.parse(s.textContent); } catch { return { _parseError: true, raw: s.textContent.slice(0,300) }; }
      });
      const ldjsonTypes = [];
      const collect = (n) => {
        if (!n) return;
        if (Array.isArray(n)) n.forEach(collect);
        else if (typeof n === 'object') {
          if (n['@type']) ldjsonTypes.push(String(n['@type']));
          if (n['@graph']) collect(n['@graph']);
        }
      };
      ldjson.forEach(collect);

      const metas = {};
      all('meta').forEach(m => {
        const k = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('http-equiv');
        if (k) metas[k] = m.getAttribute('content');
      });

      const mainEl = document.querySelector('main') || document.body;
      const mainText = (mainEl.innerText || '').replace(/\s+/g,' ').trim();
      const wordCount = (mainText.match(/\b[\p{L}\d]+\b/gu) || []).length;
      const sentenceCount = (mainText.match(/[.!?]\s/g) || []).length || 1;

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
        imageCount: images.length,
        imagesNoAlt: images.filter(i => !i.alt || !i.alt.trim()).length,
        imagesEagerAboveFold: images.filter(i => !i.loading || i.loading === 'eager').length,
        imagesNoExplicitSize: images.filter(i => !i.hasExplicitSize).length,
        images: images.slice(0, 40),
        linkCount: links.length,
        linksInternal: links.filter(l => l.internal).length,
        linksExternal: links.filter(l => !l.internal).length,
        emptyAnchorText: links.filter(l => !l.text).length,
        externalByHost,
        sampleLinks: links.slice(0, 30),
        ldjsonCount: ldjson.length,
        ldjsonTypes,
        ldjson: ldjson.slice(0, 6),
        wordCount,
        sentenceCount,
        avgWordsPerSentence: +((wordCount / sentenceCount).toFixed(1)),
        mainTextSample: mainText.slice(0, 4000),
      };
    });

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
      }, 3000);
    }));

    pageData.seo = seo;
    pageData.perf = perf;
    pageData.totalMs = Date.now() - t0;
    summary[target.name] = pageData;
    console.log(`  total ${pageData.totalMs}ms`);
    await context.close();
  }

  await browser.close();
  const outFile = path.join(DATA_DIR, 'summary.json');
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log('\nWritten ' + outFile);

  // Sitemap is best-effort, runs last with a hard 60s deadline so it can
  // never block the screenshots/SEO/perf capture from being committed.
  console.log('\nFetching robots.txt + sitemap (60s deadline) …');
  const sitemapResult = await withDeadline(
    findAndCrawlSitemaps(),
    60_000,
    { robots: { status: 0, body: '' }, sitemapUrls: [], urls: [], _timedOut: true },
  );
  const { robots, sitemapUrls, urls: sitemap, _timedOut } = sitemapResult;
  const sitemapByDepth = {};
  const sitemapBySection = {};
  for (const e of sitemap) {
    try {
      const u = new URL(e.url);
      const segs = u.pathname.split('/').filter(Boolean);
      sitemapByDepth[segs.length] = (sitemapByDepth[segs.length] || 0) + 1;
      const sec = segs[0] || '(root)';
      sitemapBySection[sec] = (sitemapBySection[sec] || 0) + 1;
    } catch {}
  }
  fs.writeFileSync(path.join(DATA_DIR, 'sitemap.json'), JSON.stringify({
    timedOut: !!_timedOut,
    httpRequestsUsed: _httpReqCount,
    robotsStatus: robots.status,
    robots: (robots.body || '').slice(0, 8000),
    sitemapUrls,
    sitemapCount: sitemap.length,
    sitemapByDepth,
    sitemapBySection,
    sample: sitemap.slice(0, 200).map(s => s.url),
  }, null, 2));
  console.log(`  robots.txt: ${robots.status}  sitemap URLs total: ${sitemap.length}${_timedOut ? ' (DEADLINE HIT)' : ''}`);
})();
