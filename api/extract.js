// Brand Studio — website brand extractor
// Vercel serverless function. Endpoint: /api/extract?url=https://example.com
// Returns best-guess primary/secondary colours, header/body fonts, logo candidates.
// Best-effort: the user reviews and corrects in the tool.

const cheerio = require('cheerio');

const TIMEOUT_MS = 9000;
const MAX_CSS_FILES = 6;
const MAX_BYTES = 2_000_000;

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

function extractColours(cssText, themeColor, inlineColours) {
  const counts = new Map();
  const bump = (raw, weight) => {
    const h = normHex(raw);
    if (!h) return;
    counts.set(h, (counts.get(h) || 0) + weight);
  };

  // theme-color is a strong brand signal
  if (themeColor) bump(themeColor, 40);
  // colours from inline style attributes (often header/buttons) get a small boost
  inlineColours.forEach((c) => bump(c, 3));

  // all colours in the CSS text
  const re = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)/g;
  let m;
  while ((m = re.exec(cssText))) bump(m[0], 1);

  // separate brand-ish (saturated, mid-tone) from neutrals
  const all = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const brandish = all.filter(([h]) => !isNeutral(h)).map(([h]) => h);
  const palette = all.map(([h]) => h).slice(0, 14);

  const primary = brandish[0] || all[0]?.[0] || '#333333';
  // secondary: next brand colour that's visibly different from primary
  let secondary = '#666666';
  for (const h of brandish.slice(1)) {
    if (Math.abs(lum(h) - lum(primary)) > 25 || h !== primary) { secondary = h; break; }
  }

  return { primary, secondary, palette, themeColor: normHex(themeColor) };
}

// ---------- font helpers ----------
function cleanFamily(decl) {
  if (!decl) return null;
  const first = decl.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  const generic = ['inherit', 'initial', 'unset', 'sans-serif', 'serif', 'monospace', 'system-ui', '-apple-system', 'blinkmacsystemfont'];
  if (!first || generic.includes(first.toLowerCase())) return null;
  return first;
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

  const uniq = [...new Set([...google, ...all])];
  // fallbacks
  if (!headFont) headFont = google[0] || uniq[0] || null;
  if (!bodyFont) bodyFont = google[1] || google[0] || uniq.find((f) => f !== headFont) || uniq[0] || null;

  return { headFont, bodyFont, googleFonts: [...new Set(google)], allFonts: uniq.slice(0, 12) };
}

// ---------- logo helpers ----------
function extractLogos($, base) {
  const cands = [];
  const add = (u, score) => {
    if (!u) return;
    try {
      const abs = new URL(u, base).href;
      if (/^data:/.test(abs)) return;
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
  $('meta[property="og:logo"], meta[property="og:image"]').each((i, el) => add($(el).attr('content'), 45));
  $('link[rel="apple-touch-icon"]').each((i, el) => add($(el).attr('href'), 35));
  $('link[rel~="icon"]').each((i, el) => add($(el).attr('href'), 25));

  const best = new Map();
  cands.forEach((c) => { if (!best.has(c.url) || best.get(c.url) < c.score) best.set(c.url, c.score); });
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, 6);
}

// ---------- main handler ----------
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

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

    // gather CSS: inline <style>, then linked stylesheets (capped)
    let css = '';
    $('style').each((i, el) => { css += '\n' + $(el).html(); });

    const cssLinks = [];
    $('link[rel="stylesheet"], link[as="style"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) { try { cssLinks.push(new URL(href, base).href); } catch (e) {} }
    });
    const toFetch = cssLinks.slice(0, MAX_CSS_FILES);
    const cssTexts = await Promise.allSettled(toFetch.map((u) => fetchText(u)));
    cssTexts.forEach((r) => { if (r.status === 'fulfilled') css += '\n' + r.value.text; });

    // inline style="" attributes (colours)
    const inlineColours = [];
    $('[style]').each((i, el) => {
      const st = $(el).attr('style') || '';
      const ms = st.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)/g);
      if (ms) inlineColours.push(...ms);
    });

    const themeColor = $('meta[name="theme-color"]').attr('content') || null;
    const colours = extractColours(css, themeColor, inlineColours);
    const fonts = extractFonts($, css);
    const logos = extractLogos($, base);

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
      palette: colours.palette,
      headFont: fonts.headFont,
      bodyFont: fonts.bodyFont,
      googleFonts: fonts.googleFonts,
      allFonts: fonts.allFonts,
      logo: logos[0] || null,
      logoCandidates: logos,
      notes: [
        'Best-guess extraction — review and correct before generating SCSS.',
        'Colours are guessed from CSS frequency; the real brand primary may be lower in the palette.',
        'Logo is for reference/upload — it is not stored in the SCSS.',
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
