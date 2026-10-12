// Brand extraction from what the user's own browser saw (the Brand Studio
// bookmarklet, public/studio/collector.js), for sites that show the server-side
// extractor a bot check.
//
// The browser sends measured observations instead of CSS source: the computed
// colours of the header, buttons, footer, headings and links (with element area),
// :root brand variables, meta theme-color, the logo's pixels or inline-SVG fills,
// and fonts. These become the same evidence /api/extract collects from stylesheets,
// ranked by the same buildResult(), so both paths answer in the same shape.

const { createEvidence, collectCssEvidence, buildResult, normHex, kindOf, CONTEXT_WEIGHT } = require('./brand-colours');
const { logoColours, addLogoEvidence } = require('./logo-colours');
const { detectBlockedPage } = require('./page-guard');
const { cleanFamily, prettyFont, googleFamilies } = require('./fonts');
const { IMG_MAX, hostLooksPrivate, fetchBinary } = require('./net');

const MAX_PAYLOAD_BYTES = 2_500_000;
const OBS_CONTEXTS = new Set(['header', 'button', 'footer', 'heading', 'link', 'generic']);
const OBS_KINDS = new Set(['bg', 'fg', 'border']);
const TYPICAL_BUTTON_AREA = 6000; // ~150×40px
// computed :root variables include every widget library's defaults (Swiper's
// --swiper-theme-color is iOS blue on every site that has a carousel)
const VENDOR_VAR_RE = /^--(swiper|tw|plyr|pswp|glide|splide|toastify|fancybox|f-|lg-|mfp|select2|flatpickr|wp-admin|wp-components)/i;

// One observation's weight. Starts from the stylesheet weight for that context and
// property (a button background counts like a `.btn{background}` rule), then scales
// with how many elements use the colour (sqrt, so 40 links don't drown the header)
// and how big they are compared with a typical button.
function observationWeight(ctx, kind, area, count) {
  const n = Math.max(1, count || 1);
  const size = Math.min(1.5, Math.max(0.5, Math.sqrt((area || 0) / n / TYPICAL_BUTTON_AREA)));
  return CONTEXT_WEIGHT[ctx][kind] * Math.min(3, Math.sqrt(n)) * size;
}

function httpUrl(u) {
  try {
    const x = new URL(String(u));
    return /^https?:$/.test(x.protocol) ? x.href : null; // href percent-encodes quotes
  } catch (e) { return null; }
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

// Add the page observations to an evidence set.
function collectPageEvidence(ev, p) {
  arr(p.obs, 400).forEach((o) => {
    if (!Array.isArray(o)) return;
    const [ctx, kind, hex, area, count] = o;
    if (!OBS_CONTEXTS.has(ctx) || !OBS_KINDS.has(kind)) return;
    ev.add(hex, ctx, observationWeight(ctx, kind, +area || 0, +count || 1), kind);
  });
  // brand variables go through the stylesheet reader, so --primary / --brand-colour
  // naming rules (and the WordPress preset exclusions) are applied identically
  const decls = arr(p.vars, 200)
    .filter((v) => Array.isArray(v) && /^--[a-z0-9_-]{1,80}$/i.test(v[0]) && !VENDOR_VAR_RE.test(v[0]) && normHex(v[1]))
    .map(([name, val]) => name + ':' + normHex(val));
  if (decls.length) collectCssEvidence(ev, [{ text: ':root{' + decls.join(';') + '}', weight: 1.2 }]);
  const themeColor = normHex(p.themeColor);
  const tileColor = normHex(p.tileColor);
  if (themeColor) ev.add(themeColor, 'meta', 2.5);
  if (tileColor) ev.add(tileColor, 'meta', 2);
  return { themeColor, tileColor };
}

// inline-SVG fills ([hex, area] pairs) -> the same shape logoColours() returns
function svgFillColours(fills) {
  const list = arr(fills, 24).map((f) => Array.isArray(f) && { hex: normHex(f[0]), area: +f[1] || 0 }).filter((f) => f && f.hex && f.area > 0);
  const total = list.reduce((s, f) => s + f.area, 0);
  if (!total) return null;
  const byHex = new Map();
  list.forEach((f) => byHex.set(f.hex, (byHex.get(f.hex) || 0) + f.area / total));
  const colours = [...byHex].map(([hex, share]) => ({ hex, share })).filter((c) => c.share >= 0.03)
    .sort((a, b) => b.share - a.share).slice(0, 6);
  const reversed = colours.filter((c) => kindOf(c.hex) !== 'light').reduce((s, c) => s + c.share, 0) < 0.15;
  return { colours, reversed };
}

// Logo reads in order of trust: pixels the browser could read, inline-SVG fills,
// then (only if neither worked) a server fetch of the candidate URLs, which a bot
// wall will often refuse too.
async function readPageLogo(logo, deps) {
  const cands = arr(logo && logo.candidates, 8).map((c) => c && { url: httpUrl(c.url), kind: str(c.kind, 8) }).filter((c) => c && c.url);
  const isIcon = (u) => cands.some((c) => c.url === u && c.kind === 'icon');
  const reads = [];
  const px = logo && logo.pixels;
  const m = px && typeof px.dataUrl === 'string' && px.dataUrl.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (m && m[1].length < 3_000_000) {
    const r = await logoColours(Buffer.from(m[1], 'base64'));
    const url = httpUrl(px.url);
    if (r) reads.push({ url, weight: isIcon(url) ? 8 : 14, via: 'pixels', ...r });
  }
  const svg = logo && logo.svg;
  if (svg) {
    const fromFills = svgFillColours(svg.fills);
    if (fromFills) reads.push({ url: null, weight: 14, via: 'svg', ...fromFills });
    else if (typeof svg.markup === 'string' && svg.markup.length < 60000 && /^<svg[\s>]/i.test(svg.markup)) {
      const r = await logoColours(Buffer.from(svg.markup));
      if (r) reads.push({ url: null, weight: 12, via: 'svg', ...r });
    }
  }
  // a pixel read of the top candidate outranks an SVG elsewhere in the header
  if (reads.length > 1 && reads[0].via === 'pixels' && cands[0] && reads[0].url !== cands[0].url) reads.reverse();
  if (!reads.some((r) => !r.reversed) && deps.fetchBinary) {
    const remote = await Promise.all(cands.filter((c) => !/\.ico(\?|$)/i.test(c.url) && !reads.some((r) => r.url === c.url)).slice(0, 3).map(async (c) => {
      try {
        if (hostLooksPrivate(new URL(c.url).hostname)) return null;
        const img = await deps.fetchBinary(c.url);
        if (img.status >= 400 || img.buf.length > IMG_MAX || !/^image\//i.test(img.contentType)) return null;
        const r = await logoColours(img.buf);
        return r ? { url: c.url, weight: c.kind === 'icon' ? 8 : 14, via: 'fetch', ...r } : null;
      } catch (e) { return null; }
    }));
    reads.push(...remote.filter(Boolean));
  }
  return { reads, candidates: cands.map((c) => c.url) };
}

function pageFonts(f) {
  f = f || {};
  const google = [...new Set(arr(f.google, 6).flatMap((h) => googleFamilies(httpUrl(h))))];
  // loaded web fonts include icon and carousel fonts, which are never the brand's type
  const ICON_FONT = /awesome|icomoon|icons?\b|glyph|dashicons|fontello|eicons|slick|swiper|star(?:s)?$/i;
  const families = [f.head, f.sub, f.body, ...arr(f.all, 24)].map((x) => cleanFamily(str(x, 200))).filter((x) => x && !ICON_FONT.test(x));
  const pool = [...new Set([...google, ...families])];
  const seen = new Map();
  pool.map((x) => prettyFont(x, pool)).forEach((x) => { if (!seen.has(x.toLowerCase())) seen.set(x.toLowerCase(), x); });
  const head = cleanFamily(str(f.head, 200)) || cleanFamily(str(f.sub, 200));
  const body = cleanFamily(str(f.body, 200));
  return {
    headFont: head ? prettyFont(head, pool) : google[0] || null,
    bodyFont: body ? prettyFont(body, pool) : google[1] || google[0] || null,
    googleFonts: google,
    allFonts: [...seen.values()].slice(0, 12),
  };
}

// payload -> { status, body } where body matches GET /api/extract's response
async function extractFromPage(p, deps) {
  deps = deps || { fetchBinary };
  if (!p || typeof p !== 'object' || p.v !== 1) return { status: 400, body: { error: 'That page data wasn’t recognised. Drag the bookmark from Brand Studio again and retry.' } };
  const url = httpUrl(p.url);
  if (!url) return { status: 400, body: { error: 'The bookmark only works on a website (an http or https page).' } };
  const title = str(p.title, 120);
  // the user clicked the bookmark while their own browser was still on a challenge/error page
  const blocked = detectBlockedPage(200, '<title>' + title + '</title>', title);
  if (blocked) {
    return { status: 422, body: { error: 'Your browser was still showing a check or error page (“' + title.slice(0, 60) + '”), not the agency’s site.', blocked: blocked.reason, hint: 'Wait for the website to finish loading, then click the bookmark again.' } };
  }

  const ev = createEvidence();
  const warnings = [];
  const { themeColor, tileColor } = collectPageEvidence(ev, p);
  const { reads, candidates } = await readPageLogo(p.logo, deps);
  const logoRead = addLogoEvidence(ev, reads, warnings);
  if (!reads.length && candidates.length) {
    // browsers show cross-site images but don't let a page read their pixels
    warnings[warnings.length - 1] = 'The logo is hosted where neither your browser nor Brand Studio can read its colours, so colours come from the site styling. To confirm them, right-click the logo on the site, save it, and upload it under Upload files.';
  }
  if (!ev.items.length) return { status: 422, body: { error: 'No colours could be read from that page. Upload the logo instead.' } };
  const colours = buildResult(ev);
  if (colours.confidence === 'low') warnings.push('Low confidence in these colours — compare them against the logo before using them.');

  const fonts = pageFonts(p.fonts);
  const logo = (logoRead && logoRead.url) || candidates[0] || null;
  const host = new URL(url).hostname;
  return {
    status: 200,
    body: {
      ok: true,
      source: 'browser',
      url,
      finalUrl: url,
      siteName: str(p.siteName, 120) || title || host,
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
      logoCandidates: [...new Set([logo, ...candidates].filter(Boolean))].slice(0, 8),
      images: arr(p.images, 24).map(httpUrl).filter(Boolean),
      notes: [
        'Read from the page as your browser showed it (Brand Studio bookmark).',
        'Colours are ranked by where the site uses them: logo pixels, buttons, header, the theme’s named brand colours, then everything else.',
        'Logo is for reference/upload — it is not stored in the SCSS.',
        'Images are reference only — download and re-host on S3; they are never wired into the SCSS or a module.',
      ],
    },
  };
}

module.exports = { MAX_PAYLOAD_BYTES, observationWeight, collectPageEvidence, svgFillColours, readPageLogo, pageFonts, extractFromPage };
