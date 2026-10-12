// Brand colour inference for the Brand Studio extractor.
//
// The old approach counted every hex code in the site's CSS and took the most
// frequent one. That rewards whatever the CSS repeats most — framework defaults,
// Tailwind/Bootstrap utility palettes, social-icon colours — rather than the brand.
//
// This version collects *evidence* about each colour instead: where it is used
// (logo pixels, button backgrounds, the header bar, CSS variables the theme names
// "primary"/"brand"/"accent", the footer, headings, links) and scores it by how
// strongly that usage implies "this is the brand colour". Near-identical shades are
// merged before ranking, so #00aeef and #00adef pool their evidence.

// ---------- colour maths ----------
function clamp255(n) { return Math.max(0, Math.min(255, Math.round(n))); }
function toHex(r, g, b) { return '#' + [r, g, b].map((n) => clamp255(n).toString(16).padStart(2, '0')).join(''); }

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

function normHex(c) {
  if (!c) return null;
  c = String(c).trim().toLowerCase();
  let m;
  if ((m = c.match(/^#([0-9a-f]{3})$/))) return '#' + m[1].split('').map((x) => x + x).join('');
  if ((m = c.match(/^#([0-9a-f]{4})$/))) return '#' + m[1].slice(0, 3).split('').map((x) => x + x).join('');
  if ((m = c.match(/^#([0-9a-f]{6})$/))) return c;
  if ((m = c.match(/^#([0-9a-f]{8})$/))) return '#' + m[1].slice(0, 6); // drop alpha
  if ((m = c.match(/^rgba?\(([^)]+)\)/))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => parseFloat(x));
    if (p.length >= 3 && p.slice(0, 3).every((n) => !isNaN(n))) {
      const a = p[3] === undefined ? 1 : p[3];
      if (a < 0.4) return null; // mostly transparent
      return toHex(p[0], p[1], p[2]);
    }
  }
  if ((m = c.match(/^hsla?\(([^)]+)\)/))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => parseFloat(x));
    if (p.length >= 3 && p.slice(0, 3).every((n) => !isNaN(n))) {
      const a = p[3] === undefined ? 1 : p[3];
      if (a < 0.4) return null;
      return toHex(...hslToRgb(p[0], p[1] / 100, p[2] / 100));
    }
  }
  return null;
}

function rgb(hex) { return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]; }

// sRGB -> CIE Lab (D65). Lab distance tracks perceived difference far better than RGB.
function lab(hex) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const [r, g, b] = rgb(hex).map(lin);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function deltaE(a, b) {
  const p = lab(a), q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
function chroma(hex) { const [, a, b] = lab(hex); return Math.hypot(a, b); }
function lightness(hex) { return lab(hex)[0]; }

// chromatic = has a real hue; dark = charcoal/navy-black that can still be a brand colour
function kindOf(hex) {
  const L = lightness(hex), C = chroma(hex);
  if (C >= 8 && L > 8 && L < 97) return 'chromatic'; // C 8+ keeps muted brand tones (taupe, sage, khaki)
  if (L <= 32) return 'dark';
  return 'light'; // whites, light/mid greys — never a brand colour on their own
}

// ---------- defaults that are almost never "the brand" ----------
// These ship with frameworks, page builders and widgets. They are penalised, not
// banned: a logo whose pixels genuinely are #ff0000 still wins on logo evidence.
const FRAMEWORK_DEFAULTS = new Set([
  // Foundation
  '#1779ba', '#14679e', '#126195', '#1468a0', '#cc4b37', '#3adb76', '#ffae00',
  // Bootstrap 3/4/5 theme + named colours
  '#337ab7', '#2e6da4', '#286090', '#23527c', '#428bca', '#5cb85c', '#5bc0de', '#f0ad4e', '#d9534f',
  '#007bff', '#0069d9', '#0062cc', '#0056b3', '#6c757d', '#28a745', '#17a2b8', '#ffc107', '#dc3545', '#343a40',
  '#0d6efd', '#0b5ed7', '#0a58ca', '#6610f2', '#6f42c1', '#d63384', '#fd7e14', '#198754', '#20c997', '#0dcaf0', '#212529',
  // WordPress admin / Gutenberg + default block palette
  '#0073aa', '#007cba', '#2271b1', '#135e96', '#0071a1', '#00a0d2', '#3858e9',
  '#cf2e2e', '#ff6900', '#fcb900', '#7bdcb5', '#00d084', '#8ed1fc', '#0693e3', '#abb8c3', '#9b51e0', '#f78da7', '#32373c',
  // Elementor kit defaults (sites that never customised their global colours)
  '#6ec1e4', '#54595f', '#7a7a7a', '#61ce70',
  // Bulma, Skeleton, Materialize, generic link blues
  '#3273dc', '#485fc7', '#00d1b2', '#1eaedb', '#0fa0ce', '#26a69a', '#ee6e73',
  '#0000ee', '#0645ad', '#1a0dab', '#0066cc', '#551a8b',
  // Tailwind palette (400–700 of each hue — the shades utility classes actually use)
  '#f87171', '#ef4444', '#dc2626', '#b91c1c', '#991b1b', '#7f1d1d',
  '#fb923c', '#f97316', '#ea580c', '#c2410c', '#fbbf24', '#f59e0b', '#d97706', '#b45309',
  '#facc15', '#eab308', '#ca8a04', '#a3e635', '#84cc16', '#65a30d',
  '#4ade80', '#22c55e', '#16a34a', '#15803d', '#34d399', '#10b981', '#059669', '#047857',
  '#2dd4bf', '#14b8a6', '#0d9488', '#22d3ee', '#06b6d4', '#0891b2', '#38bdf8', '#0ea5e9', '#0284c7',
  '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#818cf8', '#6366f1', '#4f46e5', '#4338ca',
  '#a78bfa', '#8b5cf6', '#7c3aed', '#c084fc', '#a855f7', '#9333ea', '#e879f9', '#d946ef',
  '#f472b6', '#ec4899', '#db2777', '#fb7185', '#f43f5e', '#e11d48',
  // social / third-party widget colours
  '#3b5998', '#1877f2', '#4267b2', '#1da1f2', '#55acee', '#0077b5', '#0a66c2', '#e4405f', '#c13584', '#833ab4',
  '#ff0000', '#cd201f', '#bd081c', '#e60023', '#25d366', '#128c7e', '#4285f4', '#db4437', '#ea4335', '#34a853', '#fbbc05',
  '#0070f3', '#3291ff', '#f38020', '#635bff',
  // WordPress core / Twenty* theme notice + highlight colours
  '#f0b849', '#d63638', '#00a32a', '#dba617', '#72aee6',
]);
function isFrameworkDefault(hex) { return !!hex && FRAMEWORK_DEFAULTS.has(hex); }

// ---------- CSS context classification ----------
const NOISE_RE = new RegExp([
  'alert', 'badge', 'toast', 'notice', 'error', 'danger', 'success', 'warning', 'invalid', 'valid',
  'has-[a-z0-9-]+-(?:colou?r|background)', 'wp-block', 'is-style', 'wp-admin', 'admin-?bar',
  'social', 'share', 'facebook', 'twitter', 'instagram', 'linkedin', 'youtube', 'pinterest', 'whatsapp', 'tiktok', 'google',
  'trustindex', '(?:^|[^a-z])ti-', 'review', 'rating', 'testimonial', 'elfsight', 'eapps', 'stars?(?![a-z])',
  'select2', 'datepicker', 'flatpickr', 'tooltip', 'popover', 'mejs', 'cookie', 'gdpr', 'consent', 'cky-', 'cmplz', 'grecaptcha',
  '::?selection', 'placeholder', 'disabled', 'skip-link', 'screen-reader', 'debug', 'stripe',
  '(?:text|bg|border|fill|from|to|via|ring)-(?:red|green|blue|yellow|orange|purple|pink|indigo|teal|cyan|lime|amber|emerald|sky|violet|fuchsia|rose|slate|gray|grey|zinc|neutral|stone)',
  '(?:text|bg|btn|border)-(?:success|danger|warning|info|light|dark|secondary)',
].join('|'));

function selectorContext(sel) {
  if (NOISE_RE.test(sel)) return 'noise';
  if (/(^|[^a-z-])(btn|button|cta)([^a-z]|$)|input\[type=.?(submit|button)|[-_](btn|button|cta)\b|search-?submit/.test(sel)) return 'button';
  if (/(^|[^a-z-])(header|nav|navbar|masthead|topbar|top-bar|site-branding)([^a-z]|$)|[-_](header|nav|navbar|menu)\b|#header|\.menu/.test(sel)) return 'header';
  if (/footer/.test(sel)) return 'footer';
  if (/(^|[\s>+~(])h[1-6]\b|heading|[-_]title\b|\.title\b/.test(sel)) return 'heading';
  if (/(^|[\s>+~(])a($|[\s:.#[>+~])|[-_]link\b|\.link\b/.test(sel)) return 'link';
  if (/brand|primary|accent|theme-?colou?r|logo/.test(sel)) return 'brand';
  return 'generic';
}

// weight of one rule's colour, by selector context × property kind
const CONTEXT_WEIGHT = {
  button: { bg: 3, fg: 0.8, border: 1.5 },
  header: { bg: 3, fg: 0.8, border: 0.4 },
  footer: { bg: 2, fg: 0.4, border: 0.2 },
  heading: { bg: 0.6, fg: 1.5, border: 0.3 },
  link: { bg: 0.5, fg: 1.2, border: 0.3 },
  brand: { bg: 2.5, fg: 2, border: 1 },
  generic: { bg: 0.35, fg: 0.2, border: 0.12 },
  noise: { bg: 0.02, fg: 0.02, border: 0.02 },
};
// per evidence-kind ceiling, so one bloated stylesheet can't drown out the logo
const SOURCE_CAP = { logo: 14, cssVar: 10, button: 10, header: 9, footer: 5, heading: 4, link: 3, brand: 6, generic: 3, inline: 4, meta: 4, noise: 0.3 };
const SOURCE_LABEL = {
  logo: 'Logo', cssVar: 'Theme colour setting', button: 'Buttons', header: 'Header / menu', footer: 'Footer',
  heading: 'Headings', link: 'Links', brand: 'Brand styles', generic: 'Site CSS', inline: 'Page styling', meta: 'Browser theme colour', noise: 'Widgets',
};
// evidence kinds that can legitimately make a dark neutral (charcoal/black) a brand colour —
// body text colour is everywhere and must not count
const DARK_OK = new Set(['logo', 'cssVar', 'button:bg', 'header:bg', 'footer:bg', 'brand:bg', 'meta', 'inline:bg']);

const BRAND_VAR_RE = /^--(?:.*[-_])?(primary|brand|accent|secondary|main|theme|highlight|corporate)(?:[-_](?:colou?r|clr|bg|base|default|\d+))?$/;
const COLOUR_PROPS = /^(color|background|background-color|border|border-(?:top|bottom|left|right)(?:-color)?|border-color|fill|stroke)$/;
const COLOUR_TOKEN_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)/g;

function propKind(prop) {
  if (prop.startsWith('background')) return 'bg';
  if (prop.startsWith('border') || prop === 'stroke') return 'border';
  return 'fg';
}

// ---------- evidence collection ----------
function createEvidence() {
  const items = []; // { hex, source, kind:'bg'|'fg'|'border'|null, weight }
  return {
    items,
    add(raw, source, weight, kind) {
      const hex = normHex(raw);
      if (!hex || !(weight > 0)) return;
      items.push({ hex, source, kind: kind || null, weight });
    },
  };
}

// cssChunks: [{ text, weight }] where weight reflects the stylesheet's trustworthiness
function collectCssEvidence(ev, cssChunks) {
  const vars = new Map(); // --name -> hex (first definition wins, usually :root)
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  const rules = [];
  for (const { text, weight } of cssChunks) {
    ruleRe.lastIndex = 0;
    let m;
    while ((m = ruleRe.exec(text || ''))) {
      const sel = m[1].trim().toLowerCase();
      if (sel.startsWith('@font-face') || /keyframes|^\d+%$|^from$|^to$/.test(sel)) continue;
      rules.push({ sel, body: m[2], weight });
    }
  }
  // pass 1: custom property definitions
  for (const r of rules) {
    r.body.split(';').forEach((d) => {
      const i = d.indexOf(':'); if (i < 0) return;
      const name = d.slice(0, i).trim().toLowerCase();
      if (!name.startsWith('--')) return;
      const val = d.slice(i + 1).replace(/!important/i, '').trim();
      const hex = normHex(val);
      if (!hex) return;
      if (!vars.has(name)) vars.set(name, hex);
 const bm = !/^--wp-(admin|components)-/.test(name) && name.match(BRAND_VAR_RE);
      if (bm && !/wp--preset--color--(?!primary|secondary|accent|brand)/.test(name)) {
        const strong = /primary|brand|main|corporate/.test(bm[1]) ? 5 : bm[1] === 'accent' || bm[1] === 'theme' ? 4 : 3;
        ev.add(hex, 'cssVar', strong * Math.min(1.5, r.weight), null);
      } else if (/^--e-global-color-[a-z0-9]+$/.test(name)) {
        ev.add(hex, 'cssVar', 1.2, null); // Elementor custom global colours
      }
    });
  }
  // pass 2: colour declarations, scored by where they apply
  for (const r of rules) {
    const ctxs = r.sel.split(',').map((s) => selectorContext(s.trim()));
    const order = ['button', 'header', 'brand', 'footer', 'heading', 'link', 'generic', 'noise'];
    const ctx = order.find((c) => ctxs.includes(c)) || 'generic';
    r.body.split(';').forEach((d) => {
      const i = d.indexOf(':'); if (i < 0) return;
      const prop = d.slice(0, i).trim().toLowerCase();
      if (!COLOUR_PROPS.test(prop)) return;
      const val = d.slice(i + 1);
      const kind = propKind(prop);
      const w = CONTEXT_WEIGHT[ctx][kind] * r.weight;
      const toks = val.match(COLOUR_TOKEN_RE) || [];
      const vm = val.match(/var\(\s*(--[a-z0-9_-]+)/i);
      if (vm && vars.has(vm[1].toLowerCase())) toks.push(vars.get(vm[1].toLowerCase()));
      toks.slice(0, 2).forEach((t) => ev.add(t, ctx, w, kind));
    });
  }
}

// ---------- ranking ----------
function rankColours(ev) {
  // 1. score per hex per source (capped), applying the framework-default penalty
  const perHex = new Map(); // hex -> Map(sourceKey -> score)
  for (const it of ev.items) {
    const kindOfHex = kindOf(it.hex);
    if (kindOfHex === 'light') continue;
    let w = it.weight;
    if (it.source !== 'logo' && isFrameworkDefault(it.hex)) w *= 0.08;
    const key = it.source + (it.kind ? ':' + it.kind : '');
    if (kindOfHex === 'dark' && !DARK_OK.has(key) && !DARK_OK.has(it.source)) continue;
    if (!perHex.has(it.hex)) perHex.set(it.hex, new Map());
    const m = perHex.get(it.hex);
    m.set(it.source, (m.get(it.source) || 0) + w);
  }
  const declared = new Set(ev.items.filter((it) => it.source !== 'logo').map((it) => it.hex));
  const scored = [...perHex.entries()].map(([hex, m]) => {
    let score = 0; const sources = {};
    m.forEach((v, src) => { const c = Math.min(v, SOURCE_CAP[src] || 3); score += c; sources[src] = c; });
    return { hex, score, sources, kind: kindOf(hex) };
  }).sort((a, b) => b.score - a.score);

  // 2. merge perceptually-close shades into clusters led by their best-scored member
  const clusters = [];
  for (const s of scored) {
    const home = clusters.find((c) => c.kind === s.kind && deltaE(c.hex, s.hex) < (s.kind === 'dark' ? 13 : 11));
    if (home) {
      // pooled evidence stays under the same per-source ceilings, so a theme that
      // ships twenty tints of one colour doesn't out-vote the logo on volume alone
      for (const k in s.sources) home.sources[k] = Math.min((home.sources[k] || 0) + s.sources[k], (SOURCE_CAP[k] || 3) * 1.3);
      home.score = Object.values(home.sources).reduce((x, y) => x + y, 0);
      home.members.push(s.hex);
      home.memberScore[s.hex] = s.score;
    } else clusters.push({ hex: s.hex, score: s.score, sources: { ...s.sources }, kind: s.kind, members: [s.hex], memberScore: { [s.hex]: s.score } });
  }

  // 3. the logo referees. When we could read the logo, colours that appear in it are
  //    boosted and colours that don't are discounted — a site's CSS can be full of
  //    hover shades and widget colours, but the logo is the brand.
  const logoHexes = [...new Set(ev.items.filter((it) => it.source === 'logo').map((it) => it.hex))];
  if (logoHexes.some((h) => kindOf(h) === 'chromatic')) {
    clusters.forEach((c) => {
      const dist = (m) => Math.min(...logoHexes.map((l) => deltaE(l, m)));
      const inLogo = c.members.some((m) => dist(m) < 15);
      c.inLogo = inLogo;
      // show the site's own declared value for the logo colour (the exact designer
      // hex, most-used first) rather than a blurred logo-pixel average
      const exact = c.members.filter((m) => declared.has(m) && dist(m) < 15);
      if (inLogo && exact.length) c.hex = exact.reduce((best, m) => (c.memberScore[m] > c.memberScore[best] ? m : best), exact[0]);
      else if (inLogo && !declared.has(c.hex)) c.hex = c.members.find((m) => declared.has(m)) || c.hex;
      c.score *= inLogo ? 1.6 : 0.75;
    });
  }
  // plain greys (#333, #222, #000) are default text/UI colours far more often than a
  // brand choice; a charcoal only counts in full when it carries a tint or is in the logo
  clusters.forEach((c) => {
    if (c.inLogo === undefined) c.inLogo = c.members.some((m) => logoHexes.some((l) => deltaE(l, m) < 15));
  });
  clusters.forEach((c) => { if (c.kind === 'dark' && !c.inLogo && chroma(c.hex) < 3) c.score *= 0.6; });
  clusters.sort((a, b) => b.score - a.score);
  return clusters;
}

function describe(c) {
  return Object.entries(c.sources).sort((a, b) => b[1] - a[1]).filter(([, v]) => v >= 0.3)
    .slice(0, 3).map(([k]) => SOURCE_LABEL[k] || k);
}

function hue(hex) { const [, a, b] = lab(hex); return (Math.atan2(b, a) * 180 / Math.PI + 360) % 360; }
// a secondary that is just a lighter/darker version of the primary hue isn't useful
function distinctEnough(a, b) {
  const d = deltaE(a, b);
  const dL = Math.abs(lightness(a) - lightness(b));
  if (d <= 15 || (d <= 22 && dL < 15)) return false;
  if (kindOf(a) === 'chromatic' && kindOf(b) === 'chromatic') {
    const dh = Math.abs(hue(a) - hue(b)), h = Math.min(dh, 360 - dh);
    // same hue is fine when it's a clear tonal pair (e.g. forest green + sage)
    if (h < 20 && d < 40 && dL < 15) return false;
  }
  return true;
}

function pickBrand(clusters) {
  const chromatic = clusters.filter((c) => c.kind === 'chromatic');
  const dark = clusters.filter((c) => c.kind === 'dark');
  let primary = chromatic[0] || null;
  // a black/charcoal brand (dark logo, dark header, nothing colourful anywhere) is
  // still a brand — don't invent an accent out of stray widget colours
  if (dark[0] && (!primary || primary.score < 2.5 || dark[0].score > primary.score * 2.2)) primary = dark[0];

  let secondary = null;
  if (primary) {
    // a contrasting colour makes a more useful secondary than a lighter/darker
    // sibling of the primary's own hue (navy logo next to a blue primary)
    const sibling = (c) => chroma(c.hex) > 5 && chroma(primary.hex) > 5 && (() => {
      const dh = Math.abs(hue(c.hex) - hue(primary.hex)); return Math.min(dh, 360 - dh) < 25;
    })();
    const eff = (c) => c.score * (sibling(c) ? 0.6 : 1);
    const rest = clusters
      .filter((c) => c !== primary && distinctEnough(c.hex, primary.hex) && c.score >= Math.max(1.5, primary.score * 0.05))
      .sort((a, b) => eff(b) - eff(a));
    secondary = rest[0] || null;
    // a weak chromatic runner-up shouldn't beat a well-evidenced charcoal
    const darkAlt = rest.find((c) => c.kind === 'dark');
    if (secondary && secondary.kind === 'chromatic' && darkAlt && eff(darkAlt) >= eff(secondary) * 0.7) secondary = darkAlt;
  }

  let confidence = 'low';
  if (primary) {
    const s = primary.sources;
    const strongSignals = ['logo', 'cssVar', 'button', 'header'].filter((k) => (s[k] || 0) >= 1).length;
    const runnerUp = clusters.find((c) => c !== primary && c.kind === primary.kind);
    const margin = runnerUp ? primary.score / Math.max(runnerUp.score, 0.01) : 9;
    if (strongSignals >= 2 && margin >= 1.3) confidence = 'high';
    else if (strongSignals >= 1 || margin >= 2) confidence = 'medium';
  }
  return { primary, secondary, confidence };
}

function buildResult(ev) {
  const clusters = rankColours(ev);
  const { primary, secondary, confidence } = pickBrand(clusters);
  const palette = [];
  const push = (c, role) => { if (c && !palette.some((p) => p.hex === c.hex)) palette.push({ hex: c.hex, role, sources: describe(c), score: +c.score.toFixed(2) }); };
  push(primary, 'primary');
  push(secondary, 'secondary');
  clusters.filter((c) => c.score >= 0.25).forEach((c) => push(c, null));
  return {
    primary: primary ? primary.hex : '#333333',
    secondary: secondary ? secondary.hex : '#666666',
    confidence,
    primarySources: primary ? describe(primary) : [],
    secondarySources: secondary ? describe(secondary) : [],
    paletteDetail: palette.slice(0, 14),
    palette: palette.slice(0, 14).map((p) => p.hex),
  };
}

module.exports = {
  normHex, toHex, lab, deltaE, chroma, lightness, kindOf, isFrameworkDefault,
  selectorContext, createEvidence, collectCssEvidence, rankColours, pickBrand, buildResult, CONTEXT_WEIGHT,
};
