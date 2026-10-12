// Brand Studio — website brand extractor
// Vercel serverless function. Endpoint: /api/extract?url=https://example.com
// Returns best-guess primary/secondary colours, header/body fonts, logo candidates.
// Best-effort: the user reviews and corrects in the tool.

const cheerio = require('cheerio');
const { createEvidence, collectCssEvidence, buildResult, normHex, kindOf, isFrameworkDefault } = require('../lib/brand-colours');
const { logoColours } = require('../lib/logo-colours');
const { detectBlockedPage } = require('../lib/page-guard');

const TIMEOUT_MS = 9000;
const PAGE_TIMEOUT_MS = 14000; // the homepage itself: some agency sites are slow to first byte
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
// Colour evidence gets weighted by source: a theme's own/customizer-generated CSS is a
// far stronger brand signal than a payment-widget or icon-font stylesheet.
const STYLESHEET_WEIGHT = { dynamic: 2, theme: 1.2, other: 1, plugin: 0.4, vendor: 0.15, icon: 0.05, inline: 1.5 };

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

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
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

// ---------- logo + inline colour evidence ----------
// Read the first few logo candidates' pixels; a reversed (white) logo is kept but
// flagged so the caller can fall through to the next candidate.
async function readLogoColours($, base, logos) {
  const icons = new Set();
  $('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').each((i, el) => {
    try { icons.add(new URL($(el).attr('href'), base).href); } catch (e) {}
  });
  const cands = logos.filter((u) => !/\.ico(\?|$)/i.test(u)).slice(0, 3);
  const reads = await Promise.all(cands.map(async (u) => {
    try {
      const u2 = new URL(u);
      if (hostLooksPrivate(u2.hostname)) return null;
      const img = await fetchBinary(u);
      if (img.status >= 400 || img.buf.length > IMG_MAX) return null;
      const r = await logoColours(img.buf);
      // favicons/app icons are brand-coloured but a weaker signal than the real logo
      return r ? { url: u, weight: icons.has(u) ? 8 : 14, ...r } : null;
    } catch (e) { return null; }
  }));
  return reads.filter(Boolean);
}

// style="" attributes: page builders write header/button colours inline
function collectInlineEvidence($, ev) {
  $('[style]').each((i, el) => {
    const st = $(el).attr('style') || '';
    if (!/#|rgb|hsl/i.test(st)) return;
    const $el = $(el);
    let ctx = 'inline', w = 0.4;
    if ($el.is('button, .btn, .button, a[class*="btn"], a[class*="button"]')) { ctx = 'button'; w = 2; }
    else if ($el.closest('header, nav, .header, #header, .navbar').length) { ctx = 'header'; w = 2; }
    else if ($el.closest('footer, .footer, #footer').length) { ctx = 'footer'; w = 1.5; }
    st.split(';').forEach((d) => {
      const i2 = d.indexOf(':'); if (i2 < 0) return;
      const prop = d.slice(0, i2).trim().toLowerCase();
      const kind = prop.startsWith('background') ? 'bg' : prop.startsWith('border') ? 'border' : prop === 'color' ? 'fg' : null;
      if (!kind) return;
      const toks = d.slice(i2 + 1).match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)/g) || [];
      toks.slice(0, 1).forEach((t) => ev.add(t, ctx, kind === 'bg' ? w : w * 0.4, kind));
    });
  });
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
    const page = await fetchText(parsed.href, PAGE_TIMEOUT_MS);
    const $ = cheerio.load(page.text);
    const title = ($('title').first().text() || '').trim().slice(0, 80);

    // Bot walls, security checkpoints and error pages are not the agency's site.
    // Reading colours off them is worse than useless, so stop and say why.
    const blocked = detectBlockedPage(page.status, page.text, title);
    if (blocked) {
      res.status(422).json({
        error: blocked.message,
        blocked: blocked.reason,
        hint: 'Upload the agency\u2019s logo (PNG/SVG) or brand guide PDF instead \u2014 the colours are read straight from that.',
      });
      return;
    }
    if (!/html/i.test(page.contentType) && !/<html|<!doctype/i.test(page.text)) {
      res.status(422).json({ error: 'That URL did not return a web page.' }); return;
    }
    const base = page.finalUrl;
    const warnings = [];

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
    const prioritised = [...new Set(cssLinks)].sort(
      (a, b) => STYLESHEET_PRIORITY[classifyStylesheet(a)] - STYLESHEET_PRIORITY[classifyStylesheet(b)]
    );
    const toFetch = prioritised.slice(0, MAX_CSS_FILES);

    const logos = extractLogos($, base, '');
    // stylesheets and logo images download in parallel
    const [cssTexts, logoReads] = await Promise.all([
      Promise.allSettled(toFetch.map((u) => fetchText(u))),
      readLogoColours($, base, logos),
    ]);
    cssTexts.forEach((r, i) => {
      if (r.status !== 'fulfilled' || r.value.status >= 400) return;
      css += '\n' + r.value.text;
      cssChunks.push({ text: r.value.text, weight: STYLESHEET_WEIGHT[classifyStylesheet(toFetch[i])] });
    });
    // CSS background-image logos only show up once the stylesheets are in
    const allLogos = [...new Set([...logos, ...extractLogos($, base, css)])].slice(0, 8);

    // ---- colour evidence ----
    const ev = createEvidence();
    collectCssEvidence(ev, cssChunks);
    collectInlineEvidence($, ev);
    const themeColor = normHex($('meta[name="theme-color"]').first().attr('content'));
    const tileColor = normHex($('meta[name="msapplication-TileColor"]').attr('content')
      || $('meta[name="msapplication-navbutton-color"]').attr('content'));
    if (themeColor) ev.add(themeColor, 'meta', 2.5);
    if (tileColor) ev.add(tileColor, 'meta', 2);
    const logoRead = logoReads.find((l) => !l.reversed) || null;
    if (logoRead) {
      logoRead.colours.forEach((c) => {
        const k = kindOf(c.hex);
        if (k === 'chromatic') ev.add(c.hex, 'logo', logoRead.weight * Math.min(1, 0.35 + c.share * 2));
        else if (k === 'dark') ev.add(c.hex, 'logo', logoRead.weight * 0.6 * Math.min(1, 0.3 + c.share * 2));
      });
    } else if (logoReads.length) {
      warnings.push('The logo is white/reversed, so it couldn\u2019t confirm the brand colour \u2014 colours come from the site styling.');
    } else {
      warnings.push('Couldn\u2019t read colours from the logo \u2014 colours come from the site styling only.');
    }
    const colours = buildResult(ev);
    if ($('body').text().replace(/\s+/g, ' ').trim().length < 300 && cssChunks.length < 3) {
      warnings.push('This site draws itself with JavaScript, so there was little styling to read. Double-check the colours, or upload the logo.');
    }
    if (colours.confidence === 'low') warnings.push('Low confidence in these colours \u2014 compare them against the logo before using them.');

    const fonts = extractFonts($, css);
    const images = extractImages($, base, new Set(allLogos));
    const siteName = $('meta[property="og:site_name"]').attr('content') || title || parsed.hostname;
    const logo = (logoRead && logoRead.url) || allLogos[0] || null;

    res.status(200).json({
      ok: true,
      url: parsed.href,
      finalUrl: base,
      siteName,
      primary: colours.primary,
      secondary: colours.secondary,
      confidence: colours.confidence,
      primarySources: colours.primarySources,
      secondarySources: colours.secondarySources,
      palette: colours.palette,
      paletteDetail: colours.paletteDetail,
      themeColor,
      tileColor,
      logoColours: logoRead ? logoRead.colours : [],
      warnings,
      headFont: fonts.headFont,
      bodyFont: fonts.bodyFont,
      googleFonts: fonts.googleFonts,
      allFonts: fonts.allFonts,
      logo,
      logoCandidates: [...new Set([logo, ...allLogos].filter(Boolean))].slice(0, 8),
      images: images,
      notes: [
        'Best-guess extraction \u2014 review and correct before generating SCSS.',
        'Colours are ranked by where the site uses them: logo pixels, buttons, header, the theme\u2019s named brand colours, then everything else.',
        'Framework, page-builder and social-widget default colours are discounted.',
        'Logo is for reference/upload \u2014 it is not stored in the SCSS.',
        'Images are reference only \u2014 download and re-host on S3; they are never wired into the SCSS or a module.',
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
module.exports._internal = { normHex, isFrameworkDefault, extractImages, detectBlockedPage };
