// Unit checks for the colour engine and block-page guard: `npm test`
const assert = require('node:assert/strict');
const { createEvidence, collectCssEvidence, buildResult, normHex, kindOf, selectorContext } = require('../lib/brand-colours');
const { detectBlockedPage } = require('../lib/page-guard');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };
const run = (css, extra) => {
  const ev = createEvidence();
  collectCssEvidence(ev, [{ text: css, weight: 1.2 }]);
  (extra || []).forEach(([hex, src, w]) => ev.add(hex, src, w));
  return buildResult(ev);
};

test('normHex handles short, alpha, rgb and hsl forms', () => {
  assert.equal(normHex('#AbC'), '#aabbcc');
  assert.equal(normHex('#11223344'), '#112233');
  assert.equal(normHex('rgb(255, 0, 0)'), '#ff0000');
  assert.equal(normHex('rgba(0,0,0,.1)'), null);
  assert.equal(normHex('hsl(0, 100%, 50%)'), '#ff0000');
});

test('selector contexts', () => {
  assert.equal(selectorContext('.site-header .btn-primary'), 'button');
  assert.equal(selectorContext('header.site-header'), 'header');
  assert.equal(selectorContext('.alert-danger'), 'noise');
  assert.equal(selectorContext('.text-red-400'), 'noise');
  assert.equal(selectorContext('.footer-widgets'), 'footer');
});

test('a colour used on buttons + header beats a more frequent utility colour', () => {
  const noise = Array.from({ length: 60 }, (_, i) => `.text-red-400.x${i}{color:#f87171}`).join('');
  const r = run(noise + 'header{background:#0b3d2e}.btn{background:#0b3d2e;color:#fff}');
  assert.equal(r.primary, '#0b3d2e');
});

test('framework defaults lose to the theme colour', () => {
  const r = run('a{color:#007bff}a:hover{color:#0056b3}.btn-primary{background:#007bff}'.repeat(10) + ':root{--brand-primary:#c8102e}.site-header{background:var(--brand-primary)}');
  assert.equal(r.primary, '#c8102e');
});

test('logo colours referee the CSS', () => {
  const r = run('.btn{background:#5e211c}.btn:hover{background:#5e211c}header .menu a{color:#5e211c}', [['#ffd23c', 'logo', 12], ['#231f20', 'logo', 6]]);
  assert.equal(r.primary, '#ffd23c');
});

test('a black/charcoal brand stays black instead of promoting a stray widget colour', () => {
  const r = run('header{background:#111111}.btn{background:#111111}footer{background:#111}.cky-btn{background:#1863dc}', [['#111111', 'logo', 8]]);
  assert.equal(kindOf(r.primary), 'dark');
});

test('secondary prefers a contrasting colour over a shade of the primary', () => {
  const r = run('.btn{background:#1a3668}header{background:#1a3668}footer{background:#000e35}.top-bar{background:#000e35}.cta{background:#dc1c2e}',
    [['#1a3668', 'logo', 14], ['#dc1c2e', 'logo', 5]]);
  assert.equal(r.primary, '#1a3668');
  assert.equal(r.secondary, '#dc1c2e');
});

test('block pages are recognised; ordinary pages with vendor scripts are not', () => {
  const big = '<p>' + 'x'.repeat(40000) + '</p>';
  assert.equal(detectBlockedPage(403, '<title>Just a moment...</title>', 'Just a moment...').reason, 'cloudflare');
  assert.equal(detectBlockedPage(429, '<title>Vercel Security Checkpoint</title>', 'Vercel Security Checkpoint').reason, 'vercel');
  assert.equal(detectBlockedPage(200, '<title>Parked Domain name on Hostinger DNS system</title>', 'Parked Domain name on Hostinger DNS system').reason, 'parked');
  assert.equal(detectBlockedPage(200, '<script src="/cdn-cgi/challenge-platform/h/b/scripts/x.js"></script>' + big, 'Smith Real Estate'), null);
  assert.equal(detectBlockedPage(200, '<button class="g-recaptcha" data-sitekey="x">Send</button></form>' + big, 'Smith Real Estate'), null);
});

console.log(`\n${n} passed`);
