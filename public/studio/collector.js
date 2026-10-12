/* Brand Studio page collector.
 *
 * Runs as a bookmarklet on an agency's website, in the user's own browser, for
 * sites that show a bot check to the server-side extractor (Cloudflare, Vercel
 * checkpoint, 403s). It only reads what the browser is already showing: computed
 * colours of the header, buttons, footer, headings and links; the page's brand
 * CSS variables; the logo; fonts. It then POSTs that to the Studio in a new tab
 * (a form POST, so nothing goes in a URL), where /api/extract-from-page ranks it
 * with the same evidence model as /api/extract.
 *
 * The Studio page turns this function into the bookmarklet with toString(), so it
 * must stay self-contained: no line comments, explicit semicolons, no outer
 * variables. `opts.dryRun` returns the payload instead of sending it (tests).
 */
function brandStudioCollect(STUDIO, opts) {
  opts = opts || {};
  var doc = document, win = window;
  if (!opts.dryRun && STUDIO && location.origin === STUDIO) {
    alert('Open the agency’s website in this tab first, then click the Brand Studio bookmark.');
    return null;
  }

  var cv = doc.createElement('canvas'); cv.width = cv.height = 1;
  var cx = cv.getContext('2d', { willReadFrequently: true });
  function h2(n) { n = Math.max(0, Math.min(255, Math.round(n))); return (n < 16 ? '0' : '') + n.toString(16); }
  /* any computed colour -> '#rrggbb', or null when (mostly) transparent */
  function hex(c) {
    if (!c || c === 'transparent' || c === 'none' || c.indexOf('url(') === 0) return null;
    var m = c.match(/^rgba?\(([^)]+)\)/);
    if (m) {
      var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
      if (p.length < 3) return null;
      if (p.length > 3 && p[3] < 0.4) return null;
      return '#' + h2(p[0]) + h2(p[1]) + h2(p[2]);
    }
    try {
      cx.clearRect(0, 0, 1, 1); cx.fillStyle = 'rgba(0,0,0,0)'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
      var d = cx.getImageData(0, 0, 1, 1).data;
      return d[3] < 102 ? null : '#' + h2(d[0]) + h2(d[1]) + h2(d[2]);
    } catch (e) { return null; }
  }
  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return null; } }
  function vis(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    var s = win.getComputedStyle(el);
    if (s.visibility === 'hidden' || parseFloat(s.opacity) < 0.15) return null;
    return { r: r, s: s, a: Math.round(r.width * r.height) };
  }
  var NOISE = '[class*="cookie" i],[id*="cookie" i],[class*="consent" i],[id*="consent" i],[class*="gdpr" i],[class*="social" i],[class*="share" i],[class*="chat" i],[id*="chat" i],[class*="intercom" i],[class*="recaptcha" i],[class*="alert" i],[class*="toast" i],[class*="badge" i],[class*="modal" i],[class*="trustindex" i],[class*="ti-widget" i],[class*="review" i],[class*="rating" i],[class*="testimonial" i],[class*="elfsight" i],#brand-studio-toast';
  function noisy(el) { try { return !!el.closest(NOISE); } catch (e) { return false; } }
  function ownText(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  }

  /* ---- colour observations, aggregated as [context, kind, hex, area, count] ---- */
  var agg = {};
  function obs(ctx, kind, c, area) {
    var x = hex(c); if (!x) return;
    var k = ctx + '|' + kind + '|' + x;
    if (!agg[k]) agg[k] = [ctx, kind, x, 0, 0];
    agg[k][3] += Math.min(area, 400000); agg[k][4]++;
  }
  function all(sel, max) { try { return Array.prototype.slice.call(doc.querySelectorAll(sel), 0, max); } catch (e) { return []; } }
  var HEADER = 'header,nav,[role="banner"],.header,#header,.navbar,.site-header,#masthead,.masthead,.top-bar,.topbar';
  var FOOTER = 'footer,[role="contentinfo"],.footer,#footer,.site-footer';
  var BUTTON = 'button,a[role="button"],input[type="submit"],input[type="button"],[class*="btn" i],[class*="button" i],[class*="cta" i]';
  /* a class *token* has to say button ("btn", "btn-primary", "hero__cta"); "buttons" or
     "sf-menu-buttons" on a menu container doesn't count */
  var BTN_TOKEN = /^(btn|button|cta)([-_].*)?$|[-_](btn|button|cta)$/i;
  function isButton(el) {
    if (/^(BUTTON|INPUT)$/.test(el.tagName) || el.getAttribute('role') === 'button') return true;
    var cls = typeof el.className === 'string' ? el.className : '';
    if (!cls.split(/\s+/).some(function (t) { return BTN_TOKEN.test(t); })) return false;
    return el.querySelectorAll('a,button,li').length < 2;
  }
  var seen = new Set();
  function region(rootSel, ctx, maxPer) {
    all(rootSel, 12).forEach(function (root) {
      if (noisy(root)) return;
      var els = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*'), 0, maxPer));
      els.forEach(function (el) {
        if (seen.has(el) || noisy(el) || isButton(el)) return;
        seen.add(el);
        var v = vis(el); if (!v) return;
        obs(ctx, 'bg', v.s.backgroundColor, v.a);
        /* text, and icon glyphs (menu/search/phone icons take the brand colour) */
        if (ownText(el) || /^(I|SVG)$/i.test(el.tagName) || /icon|lines/i.test(typeof el.className === 'string' ? el.className : '')) obs(ctx, 'fg', el.tagName.toLowerCase() === 'svg' ? v.s.fill : v.s.color, Math.max(v.a, 400));
      });
    });
  }
  all(BUTTON, 400).filter(isButton).slice(0, 160).forEach(function (el) {
    if (noisy(el)) return;
    var v = vis(el); if (!v || v.a > 120000) return;
    seen.add(el);
    obs('button', 'bg', v.s.backgroundColor, v.a);
    if ((el.textContent || el.value || '').trim()) obs('button', 'fg', v.s.color, v.a);
    if (parseFloat(v.s.borderTopWidth) >= 1 && v.s.borderTopStyle !== 'none') obs('button', 'border', v.s.borderTopColor, v.a);
  });
  region(HEADER, 'header', 300);
  region(FOOTER, 'footer', 400);
  all('h1,h2,h3,h4,h5,h6', 80).forEach(function (el) {
    if (seen.has(el) || noisy(el)) return;
    var v = vis(el); if (v) obs('heading', 'fg', v.s.color, v.a);
  });
  all('a[href]', 400).forEach(function (el) {
    if (seen.has(el) || noisy(el) || el.closest(HEADER + ',' + FOOTER)) return;
    var v = vis(el); if (v && ownText(el)) obs('link', 'fg', v.s.color, v.a);
  });
  /* large coloured bands (hero strips, CTA sections) outside the header/footer */
  all('body > *, section, main > *, article, aside, div', 2500).forEach(function (el) {
    if (seen.has(el) || noisy(el)) return;
    var r = el.getBoundingClientRect();
    if (r.width * r.height < 40000) return;
    var v = vis(el); if (v) obs('generic', 'bg', v.s.backgroundColor, v.a);
  });
  var obsList = Object.keys(agg).map(function (k) { return agg[k]; })
    .sort(function (a, b) { return b[3] - a[3]; }).slice(0, 220);

  /* ---- brand-ish CSS custom properties on :root (computed, so cross-origin sheets count) ---- */
  var vars = [], root = win.getComputedStyle(doc.documentElement);
  for (var i = 0; i < root.length && vars.length < 150; i++) {
    var name = root[i];
    if (name.indexOf('--') !== 0 || !/colou?r|clr|primary|secondary|brand|accent|main|theme|highlight|corporate/i.test(name)) continue;
    var val = root.getPropertyValue(name).trim();
    if (!val || val.length > 60 || !/^(#|rgb|hsl|oklch|oklab|lab|lch|color\()/i.test(val)) continue;
    var hv = hex(val); if (hv) vars.push([name, hv]);
  }

  /* ---- logo ---- */
  var cands = [];
  function cand(u, score, kind) {
    u = abs(u); if (!u || /^data:/i.test(u)) return;
    if (/\.svg(\?|$)/i.test(u)) score += 45;
    if (/(_\d{2,4}x\d{2,4}_|[-\/]crop|1200x630|og[-_]?image|social|share|hero|banner)/i.test(u)) score -= 55;
    cands.push({ url: u, score: score, kind: kind });
  }
  var logoImgs = [];
  ['[class*="logo" i] img, [id*="logo" i] img, img[class*="logo" i]', 'a[href="/"] img, a[rel="home"] img', 'header img, nav img, .header img, #header img, .navbar img'].forEach(function (sel) {
    all(sel, 12).forEach(function (el) { if (logoImgs.indexOf(el) < 0 && !noisy(el)) logoImgs.push(el); });
  });
  logoImgs.forEach(function (el, i) { cand(el.currentSrc || el.src, 100 - i, 'img'); });
  all('img', 300).forEach(function (el, i) {
    var hay = [el.getAttribute('src'), el.alt, el.className, el.id].join(' ');
    if (/logo|brand/i.test(hay)) { cand(el.currentSrc || el.src, 75 - i, 'img'); if (logoImgs.indexOf(el) < 0) logoImgs.push(el); }
  });
  all('[class*="logo" i], [id*="logo" i]', 30).forEach(function (el) {
    var m = (win.getComputedStyle(el).backgroundImage || '').match(/url\(["']?([^"')]+)/);
    if (m) cand(m[1], 70, 'bg');
  });
  all('meta[property="og:logo"]', 2).forEach(function (el) { cand(el.content, 60, 'img'); });
  all('link[rel="apple-touch-icon"], link[rel~="icon"]', 6).forEach(function (el) { cand(el.href, /apple/.test(el.rel) ? 40 : 22, 'icon'); });
  var best = {};
  cands.forEach(function (c) { if (!best[c.url] || best[c.url].score < c.score) best[c.url] = c; });
  var candidates = Object.keys(best).map(function (k) { return best[k]; })
    .sort(function (a, b) { return b.score - a.score; }).slice(0, 8)
    .map(function (c) { return { url: c.url, kind: c.kind }; });

  /* pixels of the first logo <img> the browser lets us read (same-origin or CORS-enabled) */
  var pixels = null;
  logoImgs.slice(0, 6).some(function (el) {
    if (!el.complete || !el.naturalWidth || /^data:/i.test(el.currentSrc || el.src) || !vis(el)) return false;
    try {
      var sc = Math.min(1, 200 / Math.max(el.naturalWidth, el.naturalHeight));
      var c2 = doc.createElement('canvas');
      c2.width = Math.max(1, Math.round(el.naturalWidth * sc)); c2.height = Math.max(1, Math.round(el.naturalHeight * sc));
      c2.getContext('2d').drawImage(el, 0, 0, c2.width, c2.height);
      pixels = { url: abs(el.currentSrc || el.src), dataUrl: c2.toDataURL('image/png') };
      return true;
    } catch (e) { return false; }
  });

  /* an inline <svg> logo: read the computed fill of each shape (page CSS included) */
  var svg = null;
  var svgs = [];
  ['[class*="logo" i] svg, svg[class*="logo" i], [id*="logo" i] svg', 'a[href="/"] svg, a[rel="home"] svg', 'header svg, nav svg, .header svg, #header svg'].forEach(function (sel) {
    all(sel, 12).forEach(function (el) { if (svgs.indexOf(el) < 0) svgs.push(el); });
  });
  svgs.slice(0, 16).some(function (el) {
    var v = vis(el); if (!v || v.r.width < 40 || noisy(el)) return false;
    var fills = {};
    Array.prototype.slice.call(el.querySelectorAll('path,rect,circle,ellipse,polygon,polyline,text,tspan,use'), 0, 600).forEach(function (s) {
      var st = win.getComputedStyle(s), r = s.getBoundingClientRect(), a = Math.max(1, r.width * r.height);
      [st.fill, parseFloat(st.strokeWidth) >= 1 ? st.stroke : null].forEach(function (f, j) {
        var x = hex(f); if (x) fills[x] = (fills[x] || 0) + (j ? a * 0.15 : a);
      });
    });
    var list = Object.keys(fills).map(function (k) { return [k, Math.round(fills[k])]; });
    if (!list.length) return false;
    svg = { fills: list.sort(function (a, b) { return b[1] - a[1]; }).slice(0, 12), markup: el.outerHTML.length <= 40000 ? el.outerHTML : null };
    return true;
  });

  /* ---- fonts ---- */
  function fam(sel) { var el = doc.querySelector(sel); return el ? win.getComputedStyle(el).fontFamily : null; }
  var fontsAll = [];
  ['h1', 'h2', 'h3', 'body', 'p', 'button', 'nav a', 'header a'].forEach(function (s) { var f = fam(s); if (f) fontsAll.push(f); });
  try { doc.fonts.forEach(function (f) { if (f.status === 'loaded') fontsAll.push(f.family); }); } catch (e) {}
  var fonts = {
    head: fam('h1') || fam('h2'), sub: fam('h2'), body: fam('p') || fam('body'),
    all: fontsAll.filter(function (f, i) { return fontsAll.indexOf(f) === i; }).slice(0, 20),
    google: all('link[href*="fonts.googleapis.com"]', 6).map(function (l) { return l.href; }),
  };

  /* ---- reference images (photos, hero banners) ---- */
  var imgs = {}, logoSet = {};
  candidates.forEach(function (c) { logoSet[c.url] = 1; });
  all('img', 400).forEach(function (el) {
    var u = abs(el.currentSrc || el.src); if (!u || /^data:/i.test(u) || logoSet[u]) return;
    var r = el.getBoundingClientRect();
    if ((r.width >= 180 && r.height >= 110) || el.naturalWidth >= 600) imgs[u] = Math.max(imgs[u] || 0, r.width * r.height);
  });
  all('section, div, [class*="hero" i], [class*="banner" i]', 1500).forEach(function (el) {
    var r = el.getBoundingClientRect(); if (r.width * r.height < 80000) return;
    var m = (win.getComputedStyle(el).backgroundImage || '').match(/url\(["']?([^"')]+)/);
    var u = m && abs(m[1]); if (u && !/^data:/i.test(u) && !logoSet[u]) imgs[u] = Math.max(imgs[u] || 0, r.width * r.height);
  });
  var images = Object.keys(imgs).sort(function (a, b) { return imgs[b] - imgs[a]; }).slice(0, 24);

  function meta(sel) { var m = doc.querySelector(sel); return m ? (m.content || '').trim() : null; }
  var payload = {
    v: 1,
    url: location.href,
    title: (doc.title || '').trim().slice(0, 120),
    siteName: meta('meta[property="og:site_name"]'),
    themeColor: hex(meta('meta[name="theme-color"]')),
    tileColor: hex(meta('meta[name="msapplication-TileColor"]') || meta('meta[name="msapplication-navbutton-color"]')),
    obs: obsList,
    vars: vars,
    logo: { candidates: candidates, pixels: pixels, svg: svg },
    fonts: fonts,
    images: images,
  };
  if (opts.dryRun) return payload;

  /* ---- send: form POST into a new tab. No CORS needed, nothing in the URL. ---- */
  var body = JSON.stringify(payload);
  var toast = doc.createElement('div');
  toast.id = 'brand-studio-toast';
  toast.style.cssText = 'position:fixed;z-index:2147483647;top:16px;right:16px;max-width:340px;background:#1f2733;color:#fff;font:13px/1.45 system-ui,sans-serif;padding:12px 14px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.3)';
  toast.textContent = 'Sending this page’s colours, fonts and logo to Brand Studio…';
  doc.body.appendChild(toast);
  setTimeout(function () { toast.remove(); }, 5000);

  var blocked = false;
  function onCsp(e) {
    if (blocked || !/form-action/.test(e.violatedDirective || e.effectiveDirective || '')) return;
    blocked = true;
    var ta = doc.createElement('textarea'); ta.value = body; ta.style.cssText = 'position:fixed;top:-1000px';
    doc.body.appendChild(ta); ta.select();
    var ok = false; try { ok = doc.execCommand('copy'); } catch (e2) {}
    ta.remove();
    toast.textContent = ok
      ? 'This website stops pages sending data elsewhere. The page details are copied — go back to Brand Studio and click “Paste page data”.'
      : 'This website stops pages sending data elsewhere, and copying was blocked too. Upload the logo in Brand Studio instead.';
  }
  doc.addEventListener('securitypolicyviolation', onCsp);
  setTimeout(function () { doc.removeEventListener('securitypolicyviolation', onCsp); }, 4000);

  var f = doc.createElement('form');
  f.method = 'POST'; f.action = STUDIO + '/api/extract-from-page'; f.target = '_blank';
  f.acceptCharset = 'utf-8'; f.style.display = 'none';
  var inp = doc.createElement('input'); inp.type = 'hidden'; inp.name = 'payload'; inp.value = body;
  f.appendChild(inp); doc.body.appendChild(f);
  f.submit(); f.remove();
  return null;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { brandStudioCollect: brandStudioCollect };
