// MB Finland SEO + content + performance audit via Playwright
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT_DIR     = process.env.OUT_DIR || path.join(__dirname);
const SCREENS_DIR = path.join(OUT_DIR, 'screens');
const DATA_DIR    = path.join(OUT_DIR, 'data');
fs.mkdirSync(SCREENS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR,    { recursive: true });

const TARGETS = [
  { name: 'landing', url: process.env.LANDING_URL || 'https://www.mercedes-benz.fi/' },
  { name: 'model',   url: process.env.MODEL_URL   || 'https://www.mercedes-benz.fi/passengercars/models/saloon/e-class.html' },
  { name: 'service', url: process.env.SERVICE_URL || 'https://www.mercedes-benz.fi/services/eco-huolto/' },
];

const VIEWPORTS = [
  { tag: 'desktop', width: 1920, height: 1080 },
  { tag: 'laptop',  width: 1280, height: 800  },
  { tag: 'mobile',  width: 768,  height: 1024 },
];

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const summary = {};

  for (const target of TARGETS) {
    console.log(`\n=== ${target.name}: ${target.url} ===`);
    const pageData = { url: target.url, viewports: {}, requests: [], console: [], errors: [] };
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
        'Upgrade-Insecure-Requests': '1',
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not.A/Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
      },
    });
    // hide webdriver flag (very basic stealth)
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['fi-FI', 'fi', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
      window.chrome = { runtime: {} };
    });
    const page = await context.newPage();

    page.on('console', (msg) => pageData.console.push({ type: msg.type(), text: msg.text().slice(0, 500) }));
    page.on('pageerror', (err) => pageData.errors.push(String(err).slice(0, 500)));
    page.on('response', async (res) => {
      try {
        const req = res.request();
        const headers = res.headers();
        pageData.requests.push({
          url: res.url().slice(0, 300),
          status: res.status(),
          type: req.resourceType(),
          size: Number(headers['content-length'] || 0),
          enc: headers['content-encoding'] || '',
          ct: headers['content-type'] || '',
        });
      } catch (e) {}
    });

    // Take desktop first with full measurement
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      if (vp.tag === 'desktop') {
        const t0 = Date.now();
        const resp = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
          pageData.errors.push('navigation: ' + e.message);
          return null;
        });
        pageData.navMs = Date.now() - t0;
        pageData.finalUrl = page.url();
        pageData.status = resp ? resp.status() : null;

        // Try to dismiss cookie banner
        const cookieSelectors = [
          'button:has-text("Hyväksy")',
          'button:has-text("Hyväksy kaikki")',
          'button:has-text("Accept")',
          'button:has-text("Accept all")',
          '#onetrust-accept-btn-handler',
          'button[aria-label*="Hyväksy"]',
        ];
        for (const sel of cookieSelectors) {
          const el = await page.$(sel).catch(() => null);
          if (el) {
            await el.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(700);
            pageData.cookieClicked = sel;
            break;
          }
        }
      } else {
        // For other viewports, just reflow; reload to render proper responsive layout
        await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
      }

      // Scroll to trigger lazy loading
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          let y = 0;
          const step = () => {
            window.scrollBy(0, 600);
            y += 600;
            if (y < document.body.scrollHeight && y < 12000) setTimeout(step, 150);
            else { window.scrollTo(0, 0); setTimeout(resolve, 600); }
          };
          step();
        });
      }).catch(() => {});

      const shot = path.join(SCREENS_DIR, `${target.name}-${vp.tag}.png`);
      await page.screenshot({ path: shot, fullPage: vp.tag === 'desktop' }).catch((e) =>
        pageData.errors.push('screenshot ' + vp.tag + ': ' + e.message),
      );
      pageData.viewports[vp.tag] = { shot, width: vp.width, height: vp.height };
      console.log(` shot ${vp.tag} -> ${shot}`);
    }

    // ---- SEO + content extraction (on the desktop pass) ----
    await page.setViewportSize({ width: 1920, height: 1080 });
    const seo = await page.evaluate(() => {
      const text = (el) => (el ? el.innerText.trim() : null);
      const attr = (sel, a) => { const e = document.querySelector(sel); return e ? e.getAttribute(a) : null; };
      const all = (sel) => Array.from(document.querySelectorAll(sel));
      const headings = {};
      ['h1','h2','h3','h4'].forEach(h => {
        headings[h] = all(h).map(n => n.innerText.replace(/\s+/g,' ').trim()).filter(Boolean);
      });
      const images = all('img').map(img => ({
        src: (img.currentSrc || img.src || '').slice(0,200),
        alt: img.getAttribute('alt'),
        w: img.naturalWidth, h: img.naturalHeight,
        loading: img.getAttribute('loading'),
        decoding: img.getAttribute('decoding'),
        hidden: img.offsetParent === null,
      }));
      const links = all('a[href]').map(a => ({
        href: a.href.slice(0,200),
        text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0,120),
        rel: a.getAttribute('rel') || '',
        target: a.getAttribute('target') || '',
      }));
      const hreflang = all('link[rel="alternate"][hreflang]').map(l => ({
        hreflang: l.getAttribute('hreflang'), href: l.getAttribute('href'),
      }));
      const ldjson = all('script[type="application/ld+json"]').map(s => {
        try { return JSON.parse(s.textContent); } catch { return { _parseError: true, raw: s.textContent.slice(0,200) }; }
      });
      const metas = {};
      all('meta').forEach(m => {
        const k = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('http-equiv');
        if (k) metas[k] = m.getAttribute('content');
      });
      return {
        title: document.title,
        lang: document.documentElement.lang,
        charset: document.characterSet,
        canonical: attr('link[rel="canonical"]', 'href'),
        robotsMeta: metas['robots'] || null,
        description: metas['description'] || null,
        viewport: metas['viewport'] || null,
        og: Object.fromEntries(Object.entries(metas).filter(([k]) => k.startsWith('og:'))),
        twitter: Object.fromEntries(Object.entries(metas).filter(([k]) => k.startsWith('twitter:'))),
        hreflang,
        headingCounts: Object.fromEntries(Object.entries(headings).map(([k,v]) => [k, v.length])),
        headings,
        imageCount: images.length,
        imagesNoAlt: images.filter(i => !i.alt || !i.alt.trim()).length,
        imagesEagerAboveFold: images.filter(i => !i.loading || i.loading === 'eager').length,
        images: images.slice(0, 40),
        linkCount: links.length,
        externalLinks: links.filter(l => !/mercedes-benz\.fi/.test(l.href)).length,
        emptyAnchorText: links.filter(l => !l.text).length,
        links: links.slice(0, 30),
        ldjson,
        bodyText: document.body.innerText.replace(/\s+/g,' ').slice(0, 8000),
        wordCount: (document.body.innerText.match(/\b\w+\b/g) || []).length,
      };
    });

    // ---- Performance (PerformanceNavigationTiming, LCP, CLS, FCP) ----
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
      const paints = performance.getEntriesByType('paint');
      out.paints = Object.fromEntries(paints.map(p => [p.name, Math.round(p.startTime)]));
      const res = performance.getEntriesByType('resource');
      const byType = {};
      let totalTransfer = 0, totalDecoded = 0;
      res.forEach(r => {
        const k = r.initiatorType || 'other';
        byType[k] = byType[k] || { count: 0, transfer: 0, decoded: 0 };
        byType[k].count++;
        byType[k].transfer += r.transferSize || 0;
        byType[k].decoded += r.decodedBodySize || 0;
        totalTransfer += r.transferSize || 0;
        totalDecoded += r.decodedBodySize || 0;
      });
      out.resourceSummary = { totalTransfer, totalDecoded, byType, count: res.length };
      // top 20 heaviest
      out.heaviest = res
        .map(r => ({ url: r.name.slice(0,200), type: r.initiatorType, transfer: r.transferSize, decoded: r.decodedBodySize, dur: Math.round(r.duration) }))
        .sort((a,b) => (b.transfer||0) - (a.transfer||0))
        .slice(0,20);

      // observe LCP/CLS for ~3.5s
      let lcp = 0, cls = 0;
      try {
        new PerformanceObserver((list) => { for (const e of list.getEntries()) lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {}
      try {
        new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
      } catch {}
      setTimeout(() => {
        out.LCP_ms = Math.round(lcp);
        out.CLS = +cls.toFixed(4);
        resolve(out);
      }, 3500);
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
