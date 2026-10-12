// Font-name helpers shared by the extractor endpoints.

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

// family names from a Google Fonts stylesheet URL (css and css2 forms)
function googleFamilies(href) {
  const out = [];
  (String(href || '').match(/family=([^&]+)/g) || []).forEach((seg) => {
    let v = seg.replace('family=', '');
    try { v = decodeURIComponent(v); } catch (e) {}
    // "|" separates families in the css API; it is often percent-encoded (%7C)
    v.split('|').forEach((fam) => {
      const name = fam.split(':')[0].replace(/\+/g, ' ').replace(/['"].*$/, '').trim();
      if (name && name.length <= 40) out.push(name);
    });
  });
  return out;
}

module.exports = { cleanFamily, prettyFont, googleFamilies };
