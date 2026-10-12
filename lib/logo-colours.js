// Read brand colours from the logo's actual pixels (PNG, JPG, WebP, GIF or SVG).
// The logo is the single most reliable statement of a brand's colours — far more
// than anything in the CSS — so it gets the heaviest evidence weight.

const sharp = require('sharp');
const { toHex, kindOf } = require('./brand-colours');

// Returns { colours: [{ hex, share }], background, reversed } or null if unreadable.
// `share` is the fraction of the logo's visible (non-background) pixels.
async function logoColours(buf) {
  let raw;
  try {
    raw = await sharp(buf, { density: 144, animated: false, limitInputPixels: 40_000_000 })
      .resize(96, 96, { fit: 'inside', withoutEnlargement: true }) // upscaling a favicon only adds blur
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (e) { return null; }
  const { data, info } = raw;
  const W = info.width, H = info.height, C = info.channels;
  const px = (x, y) => { const i = (y * W + x) * C; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };

  // opaque corners = a solid background box around the mark (e.g. JPG logos); ignore it
  const corners = [px(0, 0), px(W - 1, 0), px(0, H - 1), px(W - 1, H - 1)].filter((c) => c[3] >= 200);
  let bg = null;
  if (corners.length >= 3) {
    const avg = [0, 1, 2].map((k) => corners.reduce((s, c) => s + c[k], 0) / corners.length);
    const spread = Math.max(...corners.map((c) => Math.abs(c[0] - avg[0]) + Math.abs(c[1] - avg[1]) + Math.abs(c[2] - avg[2])));
    if (spread < 40) bg = avg;
  }

  const buckets = new Map();
  let total = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = px(x, y);
      if (a < 160) continue;
      if (bg && Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) < 36) continue;
      const key = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
      const o = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      o.n++; o.r += r; o.g += g; o.b += b;
      buckets.set(key, o);
      total++;
    }
  }
  if (!total) return null;

  // merge neighbouring buckets (anti-aliasing produces many near-duplicates). Each
  // group keeps the colour of its most common bucket — the solid core of the mark —
  // because edge pixels are blends with the background and would wash it out.
  const list = [...buckets.values()].map((o) => ({ n: o.n, r: o.r / o.n, g: o.g / o.n, b: o.b / o.n })).sort((a, b) => b.n - a.n);
  const merged = [];
  for (const c of list) {
    const home = merged.find((m) => Math.abs(m.r - c.r) + Math.abs(m.g - c.g) + Math.abs(m.b - c.b) < 54);
    if (home) home.n += c.n; else merged.push({ ...c });
  }
  // a group that is just a blend of two others (anti-aliased edge between the mark and
  // the background, or between two colours) shouldn't count as a colour of its own
  const isBlend = (c) => merged.some((a) => a !== c && a.n > c.n && merged.some((b) => b !== c && b !== a && b.n > c.n && blendOf(c, a, b)));
  for (const c of merged) if (c.n < total * 0.2 && isBlend(c)) c.blend = true;
  const colours = merged.filter((c) => !c.blend)
    .map((c) => ({ hex: toHex(c.r, c.g, c.b), share: c.n / total }))
    .filter((c) => c.share >= 0.03)
    .sort((a, b) => b.share - a.share)
    .slice(0, 6);

  // a "reversed" logo (white/light mark meant for dark headers) says nothing about colour
  const visible = colours.filter((c) => kindOf(c.hex) !== 'light');
  const reversed = visible.reduce((s, c) => s + c.share, 0) < 0.15;
  return { colours, background: bg ? toHex(...bg) : null, reversed };
}

// is c (roughly) a mix of a and b?
function blendOf(c, a, b) {
  let t = 0, den = 0;
  for (const k of ['r', 'g', 'b']) { t += (c[k] - b[k]) * (a[k] - b[k]); den += (a[k] - b[k]) ** 2; }
  if (den < 900) return false; // a and b too similar to be distinct ends
  t /= den;
  if (t < 0.12 || t > 0.88) return false;
  const err = ['r', 'g', 'b'].reduce((s, k) => s + Math.abs(c[k] - (b[k] + t * (a[k] - b[k]))), 0);
  return err < 24;
}

module.exports = { logoColours };
