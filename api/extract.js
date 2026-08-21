// Brand Studio — website brand extractor
// Vercel serverless function. Endpoint: /api/extract?url=https://example.com
// Returns best-guess primary/secondary colours, header/body fonts, logo candidates.
// Best-effort: the user reviews and corrects in the tool.

const cheerio = require('cheerio');

const TIMEOUT_MS = 9000;
const MAX_CSS_FILES = 16;
const MAX_BYTES = 2_000_000;

// ---------- stylesheet triage ----------
// Real-world sites (WordPress themes especially) link 15-30+ stylesheets. Most of
// that is vendor/icon-font/grid boilerplate that never carries a brand colour — the
// actual brand accent usually lives in the theme's own stylesheet or, for themes
// like Salient/Avada/Divi that expose a "customizer" colour picker, in a generated
// "dynamic"/"custom" styles file. Fetching stylesheets in raw document order (as
// before, capped at a low count) reliably grabs the vendor noise and misses the
// one file that actually has the brand colour. Classify and prioritise instead.
function classifyStylesheet(url) {
  const u = url.toLowerCase();
  if (/dynamic|customi[sz]er|theme-?option|theme-?colou?r|accent-?colou?r/.test(u)) return 'dynamic';
  if (/font-?awesome|iconsmind|icon-?font|glyphicon|fontello|dashicons/.test(u)) return 'icon';
  if (/grid-system|off-?canvas|magnific|js_composer|animate\.css|swiper|slick|owl-carousel|select2|flatpickr|lightbox|stripe|estimate|composer/.test(u)) return 'vendor';
  if (/\/plugins\//.test(u)) return 'plugin';
  if (/\/themes\//.test(u) || /style\.css/.test(u)) return 'theme';
  return 'other';
}
const STYLESHEET_PRIORITY = { dynamic: 0, theme: 1, other: 2, plugin: 3, vendor: 4, icon: 5 };
// Colour hits get weighted by source: a theme's own/customizer-generated CSS is a
// far stronger brand signal than a payment-widget or icon-font stylesheet, which
// would otherwise flood the frequency count with unrelated colours.
const STYLESHEET_WEIGHT = { dynamic: 6, theme: 2, other: 1, plugin: 0.4, vendor: 0.15, icon: 0.05, inline: 3 };

// ---------- safety: block private / internal targets (basic SSRF guard) ----------
function hostLooksPrivate(host) {
  host = (host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BrandStudioBot/1.0)' },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.slice(0, MAX_BYTES).toString('utf8');
    return { text, finalUrl: r.url || url, status: r.status, contentType: r.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- colour helpers ----------
function normHex(c) {
  if (!c) return null;
  c = String(c).trim().toLowerCase();
  let m;
  if ((m = c.match(/^#([0-9a-f]{3})$/))) return '#' + m[1].split('').map((x) => x + x).join('');
  if ((m = c.match(/^#([0-9a-f]{6})$/))) return c;
  if ((m = c.match(/^#([0-9a-f]{8})$/))) return '#' + m[1].slice(0, 6); // drop alpha
  if ((m = c.match(/^rgba?\(([^)]+)\)/))) {
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    if (p.length >= 3) {
      const a = p[3] === undefined ? 1 : p[3];
      if (a < 0.4) return null; // mostly transparent, ignore
      const h = p.slice(0, 3).map((n) => {
        let v = Math.max(0, Math.min(255, Math.round(n))).toString(16);
        return v.length < 2 ? '0' + v : v;
      }).join('');
      return '#' + h;
    }
  }
  return null;
}
function rgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function lum(hex) {
  const [r, g, b] = rgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
function sat(hex) {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}
function isNeutral(hex) {
  return sat(hex) < 0.12 || lum(hex) > 240 || lum(hex) < 12;
}

// Colours that ship as framework / CMS defaults — almost never the real brand.
// A frequency counter over the stylesheet will over-count these (they're referenced
// by every default button/link rule), so they must not win primary/secondary unless
// there is genuinely nothing else to go on.
const FRAMEWORK_DEFAULTS = new Set([
  '#1779ba', '#14679e', '#126195', '#1468a0',            // Zurb Foundation
  '#007bff', '#0069d9', '#0062cc',                       // Bootstrap 4
  '#0d6efd', '#0b5ed7', '#0a58ca',                       // Bootstrap 5
  '#337ab7', '#2e6da4', '#286090', '#23527c', '#428bca', // Bootstrap 3
  '#0056b3',                                             // Bootstrap link
  '#0073aa', '#007cba', '#2271b1', '#135e96', '#0071a1', // WordPress / Gutenberg
  '#3273dc', '#485fc7', '#00d1b2',                       // Bulma
  '#1eaedb', '#0fa0ce',                                  // Skeleton
  '#0000ee', '#0645ad', '#1a0dab', '#0066cc',            // generic default link blues
]);
function isFrameworkDefault(hex) { return !!hex && FRAMEWORK_DEFAULTS.has(hex); }

function extractColours(cssChunks, signals) {
  signals = signals || {};
  // Back-compat: a plain string is treated as one 'other'-weighted chunk (also
  // how the test hook / any external caller passing a single string still works).
  if (typeof cssChunks === 'string') cssChunks = [{ text: cssChunks, weight: 1 }];
  cssChunks = cssChunks || [];

  const inlineColours = signals.inlineColours || [];
  // declared brand signals — trusted over CSS frequency
  const themeHex = (function () { const h = normHex(signals.themeColor); return h && !isNeutral(h) ? h : null; })();
  const tileHex = (function () { const h = normHex(signals.tileColor); return h && !isNeutral(h) ? h : null; })();
  const logoColours = (signals.logoColours || [])
    .map(normHex).filter((h) => h && !isNeutral(h) && !isFrameworkDefault(h));

  const counts = new Map();
  const bump = (raw, weight) => {
    const h = normHex(raw);
    if (!h) return;
    counts.set(h, (counts.get(h) || 0) + weight);
  };
  // colours from inline style attributes (often header/buttons) get a small boost
  inlineColours.forEach((c) => bump(c, 3));
  // colours in each CSS source, weighted by how likely that source is to carry
  // the real brand colour (theme/customizer CSS) vs. noise (vendor/icon CSS)
  const re = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)/g;
  cssChunks.forEach(({ text, weight }) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text || ''))) bump(m[0], weight);
  });

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  const brandReal = ranked.filter((h) => !isNeutral(h) && !isFrameworkDefault(h)); // genuine brand-ish colours
  const brandFallback = ranked.filter((h) => !isNeutral(h) && isFrameworkDefault(h)); // last resort only

  // A declared brand signal beats raw CSS frequency. This is the key fix: a framework
  // default (e.g. Foundation's #1779ba) is often the most-repeated colour in the CSS,
  // but the site's own theme-color / tile-color / logo is what the brand actually is.
  const primary = themeHex || tileHex || logoColours[0] || brandReal[0] || brandFallback[0] || ranked[0] || '#333333';

  let secondary = '#666666';
  const secondaryPool = [tileHex, logoColours[0], logoColours[1], ...brandReal, themeHex];
  for (const h of secondaryPool) { if (h && h !== primary) { secondary = h; break; } }

  // palette: signals + real brand colours first, then neutrals; framework defaults dropped entirely
  const palette = []; const seen = new Set();
  const pushUnique = (h) => { if (h && !seen.has(h)) { seen.add(h); palette.push(h); } };
  [primary, secondary, themeHex, tileHex].forEach(pushUnique);
  logoColours.forEach(pushUnique);
  brandReal.forEach(pushUnique);
  ranked.forEach((h) => { if (!isFrameworkDefault(h)) pushUnique(h); });

  return {
    primary,
    secondary,
    palette: palette.slice(0, 14),
    themeColor: themeHex,
    tileColor: tileHex,
    logoColours,
    filteredFrameworkColours: brandFallback.filter((h) => h !== primary),
  };
}

// ---------- font helpers ----------
function cleanFamily(decl) {
  if (!decl) return null;
  const first = decl.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  const generic = ['inherit', 'initial', 'unset', 'sans-serif', 'serif', 'monospace', 'system-ui', '-apple-system', 'blinkmacsystemfont'];
  if (!first || generic.includes(first.toLowerCase())) return null;
  if (/[:{}();]/.test(first)) return null;        // CSS property leakage, e.g. "object-fit: cover"
  if (first.length > 40 || first.length < 2) return null;
  return first;
}

// turn "playfair-display" into "Playfair Display", preferring a proper-cased variant if one exists
function prettyFont(name, pool) {
  if (!name) return name;
  const norm = name.toLowerCase().replace(/[-_]+/g, ' ').trim();
  const match = (pool || []).find((f) => f.toLowerCase().replace(/[-_]+/g, ' ').trim() === norm && /[A-Z]|\s/.test(f));
  if (match) return match;
  if (/^[a-z0-9-]+$/.test(name)) return name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return name;
}

function extractFonts($, cssText) {
  const google = [];
  $('link[href*="fonts.googleapis.com"]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const fams = href.match(/family=([^&]+)/g) || [];
    fams.forEach((seg) => {
      seg.replace('family=', '').split('|').forEach((fam) => {
        const name = decodeURIComponent(fam.split(':')[0]).replace(/\+/g, ' ').trim();
        if (name) google.push(name);
      });
    });
  });

  // walk CSS rule blocks to find heading vs body fonts
  let headFont = null, bodyFont = null;
  const all = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let r;
  while ((r = ruleRe.exec(cssText))) {
    const selector = r[1].toLowerCase();
    const decls = r[2];
    const fm = decls.match(/font-family\s*:\s*([^;}]+)/i);
    if (!fm) continue;
    const fam = cleanFamily(fm[1]);
    if (!fam) continue;
    all.push(fam);
    if (!headFont && /\b(h1|h2|h3|\.title|\.heading|header)\b/.test(selector)) headFont = fam;
    if (!bodyFont && /(^|[,\s])(body|html|p|\.body)([,\s{]|$)/.test(selector)) bodyFont = fam;
  }

  const pool = [...new Set([...google, ...all])];
  // fallbacks
  if (!headFont) headFont = google[0] || pool[0] || null;
  if (!bodyFont) bodyFont = google[1] || google[0] || pool.find((f) => f !== headFont) || pool[0] || null;

  headFont = prettyFont(headFont, pool);
  bodyFont = prettyFont(bodyFont, pool);

  // dedupe allFonts case-insensitively, preferring the proper-cased/spaced variant
  const seen = new Map();
  pool.map((f) => prettyFont(f, pool)).forEach((f) => {
    const k = f.toLowerCase();
    if (!seen.has(k)) seen.set(k, f);
  });

  return { headFont, bodyFont, googleFonts: [...new Set(google)], allFonts: [...seen.values()].slice(0, 12) };
}

// ---------- logo helpers ----------
function extractLogos($, base, cssText) {
  const cands = [];
  const add = (u, score) => {
    if (!u) return;
    try {
      const abs = new URL(u, base).href;
      if (/^data:/.test(abs)) return;
      if (/\.svg(\?|$)/i.test(abs)) score += 45;                                   // real logos are often SVG
      if (/(_\d{2,4}x\d{2,4}_|[-/]crop|1200x630|og[-_]?image|social|share|hero|banner)/i.test(abs)) score -= 55; // share-card / hero, not a logo
      cands.push({ url: abs, score });
    } catch (e) {}
  };
  $('header img, nav img, .header img, #header img, .navbar img, .logo img, img.logo, a.logo img').each((i, el) => {
    add($(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src'), 100 - i);
  });
  $('img').each((i, el) => {
    const hay = [$(el).attr('src'), $(el).attr('alt'), $(el).attr('class'), $(el).attr('id')].join(' ');
    if (/logo|brand/i.test(hay)) add($(el).attr('src') || $(el).attr('data-src'), 75 - i);
  });
  // CSS background-image logos (common when the header logo isn't an <img>)
  const bgRe = /\.logo[^{}]*\{[^{}]*background(?:-image)?\s*:[^{}]*url\(([^)]+)\)/gi;
  let bm;
  while ((bm = bgRe.exec(cssText || ''))) add(bm[1].replace(/['"]/g, '').trim(), 70);
  $('[class*="logo" i], [id*="logo" i]').each((i, el) => {
    const st = $(el).attr('style') || '';
    const u = st.match(/url\(([^)]+)\)/i);
    if (u) add(u[1].replace(/['"]/g, '').trim(), 65);
  });
  $('meta[property="og:logo"]').each((i, el) => add($(el).attr('content'), 60));
  $('link[rel="apple-touch-icon"]').each((i, el) => add($(el).attr('href'), 40));
  $('meta[property="og:image"]').each((i, el) => add($(el).attr('content'), 18)); // usually a share card, low
  $('link[rel~="icon"]').each((i, el) => add($(el).attr('href'), 22));

  const best = new Map();
  cands.forEach((c) => { if (!best.has(c.url) || best.get(c.url) < c.score) best.set(c.url, c.score); });
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, 8);
}

// pull brand colours straight out of an SVG logo. Positive logos carry the brand
// colour; reverse/white logos won't — which is fine, theme-color covers those.
async function fetchLogoColours(logoUrl) {
  if (!logoUrl || !/\.svg(\?|$)/i.test(logoUrl)) return [];
  try {
    const r = await fetchText(logoUrl);
    if (!/svg/i.test(r.contentType || '') && !/<svg/i.test(r.text)) return [];
    const hits = (r.text.match(/#[0-9a-fA-F]{3,8}\b/g) || []).concat(r.text.match(/rgba?\([^)]+\)/g) || []);
    const counts = new Map();
    hits.forEach((c) => { const h = normHex(c); if (h) counts.set(h, (counts.get(h) || 0) + 1); });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  } catch (e) { return []; }
}

// ---------- reference image gallery (photos, hero/banner, brand graphics) ----------
// These are for the person to eyeball and download by hand, then re-host on S3.
// The tool never wires these URLs into the SCSS or a module.
function extractImages($, base, logoSet) {
  const out = new Map(); // absUrl -> score
  const TRACK = /(facebook\.com\/tr|doubleclick|google-analytics|googletagmanager|\/pixel|spacer\.|blank\.gif|1x1\.|\/ads?\/)/i;
  const add = (u, score, w, h) => {
    if (!u) return;
    try {
      const abs = new URL(u.trim(), base).href;
      if (/^data:/i.test(abs)) return;
      if (TRACK.test(abs)) return;
      if (logoSet && logoSet.has(abs)) return;              // already shown under "logo"
      const isSvg = /\.svg(\?|$)/i.test(abs);
      if (isSvg && /icon|sprite|arrow|chevron|bullet|favicon/i.test(abs)) return;
      if ((w && w > 0 && w < 64) || (h && h > 0 && h < 64)) return; // tiny = icon/spacer
      if (out.get(abs) === undefined || out.get(abs) < score) out.set(abs, score);
    } catch (e) {}
  };
  // largest candidate from a srcset string
  const fromSrcset = (ss) => {
    if (!ss) return '';
    const parts = ss.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  };
  $('img').each((i, el) => {
    const $el = $(el);
    let src = $el.attr('src') || $el.attr('data-src') || $el.attr('data-lazy-src') || '';
    const ss = fromSrcset($el.attr('srcset') || $el.attr('data-srcset'));
    if (ss) src = ss;
    const w = parseInt($el.attr('width'), 10) || 0;
    const h = parseInt($el.attr('height'), 10) || 0;
    const hay = [$el.attr('class'), $el.attr('id'), $el.attr('alt')].join(' ').toLowerCase();
    let score = 50 - i;
    if (/hero|banner|slide|feature|cover|masthead/.test(hay)) score += 60; // hero/banner to the front
    if (w >= 600 || h >= 400) score += 25;
    add(src, score, w, h);
  });
  $('picture source').each((i, el) => add(fromSrcset($(el).attr('srcset')), 40 - i));
  // inline background-image on any element (hero sections often use these)
  $('[style]').each((i, el) => {
    const st = $(el).attr('style') || '';
    const m = st.match(/background(?:-image)?\s*:[^;]*url\(([^)]+)\)/i);
    if (m) add(m[1].replace(/['"]/g, ''), 45);
  });
  $('meta[property="og:image"]').each((i, el) => add($(el).attr('content'), 45));
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, 24);
}

// binary fetch for the download proxy (images can be larger than the HTML/CSS cap)
const IMG_MAX = 12_000_000;
async function fetchBinary(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BrandStudioBot/1.0)' },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return { buf, status: r.status, contentType: r.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- main handler ----------
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // ---- download proxy: /api/extract?img=<url>&name=<filename> ----
  // Browsers can't force-download a cross-origin image, so we stream it back with an
  // attachment disposition. Image content only; same SSRF guards as the extractor.
  let imgParam = (req.query && req.query.img) || '';
  if (Array.isArray(imgParam)) imgParam = imgParam[0];
  if (imgParam) {
    let iu;
    try { iu = new URL(imgParam); } catch (e) { res.status(400).json({ error: 'Invalid image URL' }); return; }
    if (!/^https?:$/.test(iu.protocol) || hostLooksPrivate(iu.hostname)) { res.status(400).json({ error: 'Image URL not allowed' }); return; }
    try {
      const img = await fetchBinary(iu.href);
      if (!/^image\//i.test(img.contentType)) { res.status(415).json({ error: 'That URL is not an image.' }); return; }
      if (img.buf.length > IMG_MAX) { res.status(413).json({ error: 'Image is too large to proxy.' }); return; }
      let name = (req.query && req.query.name) || '';
      if (Array.isArray(name)) name = name[0];
      if (!name) { name = (iu.pathname.split('/').pop() || 'image').split('?')[0] || 'image'; }
      name = name.replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'image';
      if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
        const ext = (img.contentType.split('/')[1] || 'jpg').split(';')[0].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
        name += '.' + ext;
      }
      res.setHeader('Content-Type', img.contentType);
      res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).end(img.buf);
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      res.status(aborted ? 504 : 502).json({ error: aborted ? 'The image took too long.' : 'Could not fetch that image.' });
    }
    return;
  }

  let url = (req.query && req.query.url) || '';
  if (Array.isArray(url)) url = url[0];
  if (!url) { res.status(400).json({ error: 'Missing ?url= parameter' }); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  let parsed;
  try { parsed = new URL(url); } catch (e) { res.status(400).json({ error: 'Invalid URL' }); return; }
  if (!/^https?:$/.test(parsed.protocol) || hostLooksPrivate(parsed.hostname)) {
    res.status(400).json({ error: 'URL not allowed' }); return;
  }

  try {
    const page = await fetchText(parsed.href);
    if (!/html/i.test(page.contentType) && !/<html|<!doctype/i.test(page.text)) {
      res.status(422).json({ error: 'That URL did not return a web page.' }); return;
    }
    const $ = cheerio.load(page.text);
    const base = page.finalUrl;

    // gather CSS: inline <style> (weighted like page-authored CSS), then linked
    // stylesheets — prioritised so a theme's own/customizer CSS is fetched before
    // vendor/icon-font boilerplate when there are more links than the fetch cap.
    let css = '';
    const cssChunks = [];
    $('style').each((i, el) => { const t = $(el).html() || ''; css += '\n' + t; cssChunks.push({ text: t, weight: STYLESHEET_WEIGHT.inline }); });

    const cssLinks = [];
    $('link[rel="stylesheet"], link[as="style"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) { try { cssLinks.push(new URL(href, base).href); } catch (e) {} }
    });
    const prioritised = [...cssLinks].sort(
      (a, b) => STYLESHEET_PRIORITY[classifyStylesheet(a)] - STYLESHEET_PRIORITY[classifyStylesheet(b)]
    );
    const toFetch = prioritised.slice(0, MAX_CSS_FILES);
    const cssTexts = await Promise.allSettled(toFetch.map((u) => fetchText(u)));
    cssTexts.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      css += '\n' + r.value.text;
      cssChunks.push({ text: r.value.text, weight: STYLESHEET_WEIGHT[classifyStylesheet(toFetch[i])] });
    });

    // inline style="" attributes (colours)
    const inlineColours = [];
    $('[style]').each((i, el) => {
      const st = $(el).attr('style') || '';
      const ms = st.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)/g);
      if (ms) inlineColours.push(...ms);
    });

    const themeColor = $('meta[name="theme-color"]').attr('content') || null;
    const tileColor = $('meta[name="msapplication-TileColor"]').attr('content')
      || $('meta[name="msapplication-navbutton-color"]').attr('content') || null;
    const fonts = extractFonts($, css);
    const logos = extractLogos($, base, css);
    // best-effort: read brand colours from the first SVG logo candidate
    const svgLogo = logos.find((u) => /\.svg(\?|$)/i.test(u));
    const logoColours = await fetchLogoColours(svgLogo);
    const colours = extractColours(cssChunks, { themeColor, tileColor, logoColours, inlineColours });
    const images = extractImages($, base, new Set(logos));

    const title = ($('title').first().text() || '').trim().slice(0, 80);
    const siteName = $('meta[property="og:site_name"]').attr('content') || title || parsed.hostname;

    res.status(200).json({
      ok: true,
      url: parsed.href,
      finalUrl: base,
      siteName,
      primary: colours.primary,
      secondary: colours.secondary,
      themeColor: colours.themeColor,
      tileColor: colours.tileColor,
      palette: colours.palette,
      filteredFrameworkColours: colours.filteredFrameworkColours,
      headFont: fonts.headFont,
      bodyFont: fonts.bodyFont,
      googleFonts: fonts.googleFonts,
      allFonts: fonts.allFonts,
      logo: logos[0] || null,
      logoCandidates: logos,
      images: images,
      notes: [
        'Best-guess extraction — review and correct before generating SCSS.',
        'Primary prefers the site theme-color / tile-color / logo colour over raw CSS frequency.',
        'Known framework defaults (e.g. Foundation #1779ba, Bootstrap blues) are filtered out of the brand colours.',
        'Logo is for reference/upload — it is not stored in the SCSS.',
        'Images are reference only — download and re-host on S3; they are never wired into the SCSS or a module.',
      ],
    });
  } catch (err) {
    const aborted = err && (err.name === 'AbortError');
    res.status(aborted ? 504 : 502).json({
      error: aborted ? 'The website took too long to respond.' : 'Could not read that website.',
      detail: String((err && err.message) || err).slice(0, 200),
    });
  }
};

// ---------- test hooks (safe for Vercel: attaching props to the handler export) ----------
module.exports._internal = { extractColours, normHex, isFrameworkDefault, isNeutral, extractImages };
