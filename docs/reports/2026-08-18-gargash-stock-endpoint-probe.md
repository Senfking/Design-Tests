# Gargash / MB MENA New-Vehicle Stock Endpoint Probe

**Date:** 2026-08-18
**Target:** https://www.mercedes-benz-mena.com/dubai/en/buy-new/
**Scope:** Read-only network observation. No repo code modified, no PR, no branch changes.
**Status: BLOCKED — NOT COMPLETED. No findings were obtained.**

---

## Executive summary

The probe could not be run. This session has **no outbound internet egress**. Every
HTTPS request is refused by the session's egress proxy at the CONNECT stage with
`403 Forbidden`, before any packet reaches the target host.

**No inventory endpoint was identified. No vehicle record was captured. No raw HTML was
retrieved.** Every question in the brief — how stock is served, whether a private JSON
endpoint exists, whether it is openly callable, the record shape, pagination — remains
**unanswered**. Nothing in this report should be read as evidence about the target site.

---

## What was verified (Phase 0 — passed)

| Check | Result |
|---|---|
| Node | v22.22.2 |
| Playwright package | v1.56.1 (global, `/opt/node22/lib/node_modules`) |
| Chromium binary | present at `/opt/pw-browsers`; launches headless, **v141.0.7390.37** |
| Local browser render | OK (verified against an in-memory page, no network) |
| Scratch dir | `/tmp/mb-probe` — nothing written into the repo tree except this report |

`npx playwright install chromium` was **not** needed and was not run — the browser was
already present.

## What blocked it (Phase 1 — could not run)

The proxy's own status endpoint records the denial:

```json
{
  "ts": "2026-08-18T07:02:18.043Z",
  "kind": "connect_rejected",
  "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
  "host": "www.mercedes-benz-mena.com:443"
}
```

Verbose trace of the attempt:

```
* Establish HTTP proxy tunnel to www.mercedes-benz-mena.com:443
> CONNECT www.mercedes-benz-mena.com:443 HTTP/1.1
< HTTP/1.1 403 Forbidden
* CONNECT tunnel failed, response 403
curl: (56) CONNECT tunnel failed, response 403
```

**This is not a target-specific block.** A control request to `https://example.com`
returned the identical `403` at the CONNECT stage. The policy is deny-by-default for all
external hosts, so the failure says nothing about the target site's own defenses — the
request never left this container.

The environment's proxy documentation (`/root/.ccr/README.md`) is explicit on handling:

> **403 / 407 from the proxy** — The destination host is not allowed by your
> organization's egress policy for this session. Do not retry or route around it —
> report the blocked host.

Accordingly the probe was stopped here. No mirrors, alternate domains, or third-party
fetch services were tried; doing so would be routing around the policy rather than
observing the target.

---

## Unblocking

The probe is a single command once egress exists. One of:

1. **Allowlist the host** for this session's environment —
   `www.mercedes-benz-mena.com:443` — then re-run `probe.js` (below).
2. **Run it locally**, off the managed environment, where egress is unrestricted.

The script needs no modification under either option.

### Ready-to-run probe script

Saved during this session at `/tmp/mb-probe/probe.js` (ephemeral — the container is
reclaimed, so the authoritative copy is here). Syntax-checked with `node --check`.
It implements the full brief: pre-navigation response listener, realistic desktop UA,
1440x900 viewport, networkidle + 8s settle, full XHR/fetch dump, JSON body sampling
filtered on vehicle-like fields, and a separate no-JavaScript fetch to test whether
stock is server-rendered.

```js
/* Read-only inventory probe for mercedes-benz-mena.com/dubai/en/buy-new/
   Run: node probe.js            (requires outbound HTTPS egress to the host) */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');

const TARGET = 'https://www.mercedes-benz-mena.com/dubai/en/buy-new/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const VEHICLE_HINTS = ['model','price','vin','trim','stock','vehicle','listing'];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const all = [];      // every response
  const bodies = [];   // candidate JSON payloads

  // listener registered BEFORE navigation
  page.on('response', async (res) => {
    const req = res.request();
    const rec = {
      url: res.url(),
      method: req.method(),
      status: res.status(),
      type: req.resourceType(),
      ct: (res.headers()['content-type'] || '').split(';')[0],
    };
    all.push(rec);
    if (!['xhr','fetch','document','script'].includes(rec.type)) return;
    try {
      const txt = await res.text();
      if (!txt || txt.length > 8_000_000) return;
      const looksJson = rec.ct.includes('json') || /^\s*[[{]/.test(txt);
      if (!looksJson) return;
      let parsed; try { parsed = JSON.parse(txt); } catch { return; }
      const lower = txt.slice(0, 200_000).toLowerCase();
      const hits = VEHICLE_HINTS.filter(h => lower.includes(`"${h}`) || lower.includes(h));
      bodies.push({ ...rec, hits, size: txt.length, sample: txt.slice(0, 2048), parsed });
    } catch { /* body unavailable (redirect/preflight) */ }
  });

  await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 90_000 });
  await page.waitForTimeout(8000); // explicit settle: grid renders client-side

  console.log('\n===== (a) ALL XHR / FETCH REQUESTS =====');
  for (const r of all.filter(r => r.type === 'xhr' || r.type === 'fetch'))
    console.log(`${r.method}\t${r.status}\t${r.ct || '-'}\t${r.url}`);

  console.log('\n===== ALL RESPONSES (full list, any type) =====');
  for (const r of all) console.log(`${r.method}\t${r.status}\t${r.type}\t${r.ct || '-'}\t${r.url}`);

  console.log('\n===== (b) JSON / VEHICLE-LIKE BODIES =====');
  for (const b of bodies.sort((x, y) => y.hits.length - x.hits.length)) {
    console.log(`\n--- ${b.method} ${b.status} ${b.ct} ${b.size}B  hits=[${b.hits}]\n${b.url}`);
    console.log(b.sample.split('\n').slice(0, 40).join('\n'));
  }

  // (5) raw HTML with NO JavaScript — is stock server-rendered?
  const noJsCtx = await browser.newContext({ userAgent: UA, javaScriptEnabled: false });
  const raw = await (await noJsCtx.request.get(TARGET, { headers: { 'user-agent': UA } })).text();
  fs.writeFileSync('raw.html', raw);
  const markers = ['data-vehicle','vin','msrp','AED','stockNumber','vehicleList','__NEXT_DATA__','application/ld+json'];
  console.log('\n===== (5) RAW HTML (no JS) =====');
  console.log('bytes:', raw.length);
  for (const m of markers) console.log(`  ${m}: ${raw.toLowerCase().includes(m.toLowerCase()) ? 'PRESENT' : 'absent'}`);

  fs.writeFileSync('all-responses.json', JSON.stringify(all, null, 2));
  fs.writeFileSync('json-bodies.json', JSON.stringify(bodies.map(({parsed, ...r}) => r), null, 2));
  await browser.close();
})().catch(e => { console.error('PROBE FAILED:', e.message); process.exit(1); });
```

Phase 2's decisive standalone test (endpoint callable without a browser) is a follow-up
step once `probe.js` names the endpoint: replay it with plain `curl`, first with no
headers at all, then adding only `Referer` / `Origin`, to separate genuinely open
endpoints from ones gated on browser-set headers or cookies.

---

## Verdict

**No verdict can be given.** The brief asked how easily a third party could pull this
inventory and where that method is brittle; answering that honestly requires observing
at least one real request/response cycle against the target, and zero were observed. The
session's egress proxy refused every outbound connection — including to an unrelated
control host — so no data about the target site was collected. Any statement here about
whether the stock is server-rendered or client-side, whether a private JSON endpoint
exists, whether it is openly callable, or how brittle scraping it would be, would be
fabrication rather than a finding. The probe is fully built and verified up to the
network boundary; it needs egress to `www.mercedes-benz-mena.com:443`, or a run from an
unrestricted host, and it will then answer every question in the brief in one pass.
