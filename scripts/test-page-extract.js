// Unit checks for POST /api/extract-from-page (the Brand Studio bookmark path): `npm test`
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const sharp = require('sharp');
const { observationWeight, collectPageEvidence, svgFillColours, pageFonts, extractFromPage } = require('../lib/page-evidence');
const { createEvidence, buildResult, kindOf, deltaE } = require('../lib/brand-colours');
const handler = require('../api/extract-from-page');
const remax = require('./fixtures/remaxsuccess-page.json');
const mcgrath = require('./fixtures/mcgrath-page.json');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
// Vercel can't fetch logos from bot-walled sites: simulate that by default
const blockedFetch = { fetchBinary: async () => ({ status: 403, buf: Buffer.from('<html><title>Just a moment...</title></html>'), contentType: 'text/html' }) };
const page = (extra) => ({ v: 1, url: 'https://agency.example/', title: 'Agency', obs: [], vars: [], logo: { candidates: [] }, fonts: {}, images: [], ...extra });
const hexes = (body) => body.palette;
// a solid mark on a transparent canvas, like a real logo file (a fully opaque
// rectangle is read as a background box and ignored)
async function logoPng(r, g, b) {
  const mark = await sharp({ create: { width: 160, height: 24, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toBuffer();
  return sharp({ create: { width: 200, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: mark, left: 20, top: 8 }]).png().toBuffer();
}

test('observation weight follows the stylesheet context weights, scaled by count and size', () => {
  assert.equal(observationWeight('button', 'bg', 6000, 1), 3);           // one typical button = one .btn{background} rule
  assert.ok(observationWeight('header', 'bg', 140000, 1) <= 3 * 1.5);    // a huge header bar is capped
  assert.ok(observationWeight('link', 'fg', 6000 * 100, 100) <= 1.2 * 3 * 1.5); // 100 links don't drown everything
  assert.ok(observationWeight('generic', 'bg', 400000, 1) < observationWeight('button', 'bg', 6000, 1));
});

test('observations become evidence with their context; unknown contexts and kinds are ignored', () => {
  const ev = createEvidence();
  collectPageEvidence(ev, page({ obs: [['button', 'bg', '#123456', 6000, 2], ['logo', 'bg', '#ff0000', 9e9, 99], ['button', 'glow', '#00ff00', 6000, 1], 'junk'] }));
  assert.deepEqual(ev.items.map((i) => [i.hex, i.source, i.kind]), [['#123456', 'button', 'bg']]);
});

test('brand CSS variables count like theme settings; WordPress preset palettes do not', () => {
  const ev = createEvidence();
  collectPageEvidence(ev, page({ vars: [['--brand-primary', '#7a1f3d'], ['--wp--preset--color--vivid-red', '#cf2e2e'], ['--bad name', '#000000']] }));
  assert.deepEqual(ev.items.map((i) => [i.hex, i.source]), [['#7a1f3d', 'cssVar']]);
});

test('theme-color meta is evidence', () => {
  const ev = createEvidence();
  collectPageEvidence(ev, page({ themeColor: '#00594f' }));
  assert.equal(buildResult(ev).primary, '#00594f');
});

test('a coloured header and buttons beat a more common link colour', () => {
  const r = buildResult((() => {
    const ev = createEvidence();
    collectPageEvidence(ev, page({ obs: [['link', 'fg', '#e4002b', 300000, 60], ['header', 'bg', '#0b2f5b', 110000, 1], ['button', 'bg', '#0b2f5b', 12000, 3]] }));
    return ev;
  })());
  assert.equal(r.primary, '#0b2f5b');
});

test('REMAX Success (real browser capture, logo unreadable): REMAX blue, with red and black', async () => {
  const { status, body } = await extractFromPage(remax, blockedFetch);
  assert.equal(status, 200);
  assert.ok(deltaE(body.primary, '#0039a8') < 3, body.primary);
  assert.ok(hexes(body).includes('#dc1c2e'), JSON.stringify(hexes(body)));
  assert.ok(hexes(body).some((h) => kindOf(h) === 'dark'), JSON.stringify(hexes(body)));
  assert.equal(body.headFont, 'Poppins');
  assert.ok(!body.allFonts.some((f) => /awesome|slick|icomoon/i.test(f)), 'icon fonts filtered');
  assert.equal(body.logo, remax.logo.candidates[0].url);
  assert.match(body.warnings.join(' '), /save it, and upload/);
  assert.equal(body.source, 'browser');
});

test('REMAX Success with the logo readable: still blue primary; the black wordmark joins the palette', async () => {
  const logo = await logoPng(0, 0, 0); // black wordmark, like the real REMAX Success logo
  const deps = { fetchBinary: async () => ({ status: 200, buf: logo, contentType: 'image/png' }) };
  const { body } = await extractFromPage(remax, deps);
  assert.equal(body.primary, '#0039a8');
  assert.ok(hexes(body).includes('#dc1c2e') && hexes(body).includes('#000000'), JSON.stringify(hexes(body)));
});

test('McGrath (real browser capture behind a Vercel checkpoint): orange, black wordmark, own fonts', async () => {
  const { status, body } = await extractFromPage(mcgrath, blockedFetch);
  assert.equal(status, 200);
  assert.equal(body.primary, '#e67200');
  assert.equal(body.secondary, '#000000');
  assert.ok(!body.palette.includes('#007aff'), 'Swiper\u2019s default --swiper-theme-color is not a brand colour');
  assert.equal(body.headFont, 'Recife Display');
  assert.equal(body.bodyFont, 'Centra No2');
});

test('logo pixels read by the browser referee the page colours', async () => {
  const png = await logoPng(0, 122, 94);
  const p = page({
    obs: [['button', 'bg', '#e85d04', 6000, 4], ['link', 'fg', '#e85d04', 40000, 20], ['header', 'bg', '#007a5e', 20000, 1]],
    logo: { candidates: [{ url: 'https://agency.example/logo.png', kind: 'img' }], pixels: { url: 'https://agency.example/logo.png', dataUrl: 'data:image/png;base64,' + png.toString('base64') } },
  });
  let fetched = false;
  const { body } = await extractFromPage(p, { fetchBinary: async () => { fetched = true; return blockedFetch.fetchBinary(); } });
  assert.equal(body.primary, '#007a5e');
  assert.equal(fetched, false, 'no server fetch when the browser already read the logo');
  assert.deepEqual(body.logoColours.map((c) => c.hex), ['#007a5e']);
});

test('inline SVG logo fills (as the browser computed them) act as the logo', async () => {
  assert.equal(svgFillColours([['#ffffff', 10]]).reversed, true);
  const p = page({
    obs: [['button', 'bg', '#1d4ed8', 6000, 4]],
    logo: { candidates: [], svg: { fills: [['#7b2d8e', 5000], ['#1a1a1a', 3000], ['#ffffff', 200]] } },
  });
  const { body } = await extractFromPage(p, blockedFetch);
  assert.equal(body.primary, '#7b2d8e');
});

test('server fetch is the fallback, and only accepts real images', async () => {
  const urls = [];
  const p = page({ obs: [['button', 'bg', '#123456', 6000, 2]], logo: { candidates: [{ url: 'https://agency.example/logo.png', kind: 'img' }, { url: 'http://127.0.0.1/admin.png', kind: 'img' }] } });
  const { body } = await extractFromPage(p, { fetchBinary: async (u) => { urls.push(u); return blockedFetch.fetchBinary(); } });
  assert.deepEqual(urls, ['https://agency.example/logo.png'], 'private hosts are never fetched');
  assert.equal(body.logoColours.length, 0);
});

test('fonts: generic families and Google Fonts URLs are cleaned up', () => {
  const f = pageFonts({ head: '"Playfair Display", serif', body: 'system-ui, sans-serif', all: ['FontAwesome', 'Inter'], google: ['https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Inter'] });
  assert.equal(f.headFont, 'Playfair Display');
  assert.equal(f.bodyFont, 'Inter'); // system-ui is generic, so the second Google family stands in
  assert.deepEqual(f.allFonts, ['Playfair Display', 'Inter']);
});

test('bad payloads, non-web pages and challenge pages are refused', async () => {
  assert.equal((await extractFromPage(null)).status, 400);
  assert.equal((await extractFromPage({ v: 2 })).status, 400);
  assert.equal((await extractFromPage(page({ url: 'javascript:alert(1)' }))).status, 400);
  const ch = await extractFromPage(page({ title: 'Just a moment...', obs: [['button', 'bg', '#f38020', 6000, 1]] }), blockedFetch);
  assert.equal(ch.status, 422);
  assert.equal(ch.body.blocked, 'cloudflare');
  assert.equal((await extractFromPage(page(), blockedFetch)).status, 422); // nothing to read
});

test('only http(s) URLs come back for logos and images', async () => {
  const { body } = await extractFromPage(page({
    obs: [['button', 'bg', '#123456', 6000, 2]],
    logo: { candidates: [{ url: 'javascript:alert(1)', kind: 'img' }, { url: 'https://agency.example/a"b.png', kind: 'img' }] },
    images: ['data:image/png;base64,xx', 'https://agency.example/hero.jpg'],
  }), blockedFetch);
  assert.deepEqual(body.logoCandidates, ['https://agency.example/a%22b.png']);
  assert.deepEqual(body.images, ['https://agency.example/hero.jpg']);
});

// ---- the HTTP handler ----
function call(method, contentType, bodyText) {
  const req = Readable.from(bodyText ? [Buffer.from(bodyText)] : []);
  req.method = method; req.headers = { 'content-type': contentType || '' };
  return new Promise((resolve) => {
    const res = { headers: {}, statusCode: 200 };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => resolve({ status: res.statusCode, headers: res.headers, json: o });
    res.end = (t) => resolve({ status: res.statusCode, headers: res.headers, text: String(t || '') });
    handler(req, res);
  });
}

test('handler: JSON POST answers in the GET /api/extract shape', async () => {
  const r = await call('POST', 'application/json', JSON.stringify(page({ obs: [['button', 'bg', '#0b2f5b', 6000, 3]] })));
  assert.equal(r.status, 200);
  for (const k of ['ok', 'primary', 'secondary', 'confidence', 'palette', 'paletteDetail', 'headFont', 'bodyFont', 'allFonts', 'logoCandidates', 'images', 'warnings']) assert.ok(k in r.json, k);
  assert.equal(r.headers['access-control-allow-origin'], undefined, 'same-origin only');
  assert.equal((await call('GET')).status, 405);
  assert.equal((await call('POST', 'application/json', '{nope')).status, 400);
});

test('handler: form POST returns a hand-off page with the result safely embedded', async () => {
  const p = page({ siteName: '</script><script>alert(1)</script>', obs: [['button', 'bg', '#0b2f5b', 6000, 3]] });
  const r = await call('POST', 'application/x-www-form-urlencoded', 'payload=' + encodeURIComponent(JSON.stringify(p)));
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.headers['content-security-policy'], /default-src 'none'/);
  assert.equal((r.text.match(/<\/script>/g) || []).length, 1, 'payload text cannot close the script');
  assert.match(r.text, /BroadcastChannel\('brand-studio'\)/);
  assert.match(r.text, /brandStudio\.pageExtraction/);
  const bad = await call('POST', 'application/x-www-form-urlencoded', 'payload=' + encodeURIComponent(JSON.stringify(page({ url: 'ftp://x' }))));
  assert.equal(bad.status, 400);
  assert.doesNotMatch(bad.text, /BroadcastChannel/);
});

test('the collector stays bookmarklet-safe (no line comments; parses with newlines stripped)', () => {
  const { brandStudioCollect } = require('../public/studio/collector.js');
  const src = brandStudioCollect.toString().replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /(^|[^:'"\\])\/\/(?![^'"\n]*['"])/m);
  new Function('(' + src.replace(/\n/g, ' ') + ')');
});

(async () => {
  for (const [name, fn] of tests) { await fn(); console.log('ok -', name); }
  console.log(`\n${tests.length} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
