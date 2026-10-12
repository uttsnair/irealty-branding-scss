// Brand Studio — extract from a page the user's own browser read.
// POST /api/extract-from-page
//
// The Brand Studio bookmarklet (public/studio/collector.js) runs on an agency site
// that shows our server a bot check, reads the rendered page, and form-POSTs the
// observations here in a new tab (field `payload`, JSON). This never contacts the
// agency's site except to fetch a logo image when the browser couldn't read it.
//
// - form POST  -> an HTML hand-off page that delivers the result to an open Studio
//                 tab (BroadcastChannel) or opens the Studio with it (sessionStorage)
// - JSON POST  -> the same JSON shape as GET /api/extract (the Studio's
//                 "Paste page data" fallback, and tests)

const { extractFromPage, MAX_PAYLOAD_BYTES } = require('../lib/page-evidence');

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_PAYLOAD_BYTES) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Vercel pre-parses JSON and urlencoded bodies into req.body; the local dev
// server doesn't, so fall back to reading the stream.
async function readPayload(req, isForm) {
  let body;
  try { body = req.body; } catch (e) { throw Object.assign(new Error('bad body'), { code: 400 }); }
  if (body === undefined) {
    const raw = await readRaw(req);
    body = isForm ? Object.fromEntries(new URLSearchParams(raw)) : raw;
  }
  let p = isForm ? body && body.payload : body;
  if (Buffer.isBuffer(p)) p = p.toString('utf8');
  if (typeof p === 'string') {
    if (p.length > MAX_PAYLOAD_BYTES) throw Object.assign(new Error('too large'), { code: 413 });
    try { p = JSON.parse(p); } catch (e) { throw Object.assign(new Error('bad json'), { code: 400 }); }
  }
  return p;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// JSON inside <script>: no "</script>", no HTML comment openers, no JS line separators
const scriptJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function handoffPage(status, body) {
  const ok = status === 200 && body.ok;
  const msg = ok
    ? 'Sending ' + esc(new URL(body.url).hostname) + ' to Brand Studio…'
    : esc(body.error || 'Something went wrong reading that page.') + (body.hint ? '<br>' + esc(body.hint) : '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brand Studio</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6f9;color:#1f2733;font:15px/1.5 system-ui,-apple-system,sans-serif}
.card{max-width:440px;margin:16px;background:#fff;border:1px solid #d8dee7;border-radius:10px;padding:22px 24px}
h1{font-size:16px;margin:0 0 8px}p{margin:0 0 12px}a{color:#2f6df0}.err{color:#b54708}
</style></head><body><div class="card"><h1>Brand Studio</h1><p id="msg"${ok ? '' : ' class="err"'}>${msg}</p>
<p><a href="/studio/">Open Brand Studio</a></p></div>
${ok ? `<script>
(function(){
  var data = ${scriptJson(body)};
  var id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  var msg = document.getElementById('msg'), taken = false, ch = null;
  function openHere(){
    try { sessionStorage.setItem('brandStudio.pageExtraction', JSON.stringify(data)); } catch (e) {}
    location.replace('/studio/');
  }
  try { ch = new BroadcastChannel('brand-studio'); } catch (e) {}
  if (!ch) { openHere(); return; }
  ch.onmessage = function(e){ if (e.data && e.data.type === 'page-extraction-taken' && e.data.id === id) taken = true; };
  ch.postMessage({ type: 'page-extraction', id: id, data: data });
  setTimeout(function(){
    if (!taken) { ch.close(); openHere(); return; }
    ch.close();
    msg.textContent = 'Done — the colours, fonts and logo are in your open Brand Studio tab. You can close this tab.';
    try { window.close(); } catch (e) {}
  }, 900);
})();
</script>` : ''}</body></html>`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST the page data from the Brand Studio bookmark.' });
    return;
  }
  const isForm = /application\/x-www-form-urlencoded/i.test(req.headers['content-type'] || '');
  let status, body;
  try {
    const payload = await readPayload(req, isForm);
    ({ status, body } = await extractFromPage(payload));
  } catch (err) {
    status = err && err.code === 413 ? 413 : err && err.code === 400 ? 400 : 500;
    body = { error: status === 413 ? 'That page sent too much data.' : status === 400 ? 'That page data wasn’t recognised.' : 'Could not read the page data.' };
  }
  res.setHeader('Cache-Control', 'no-store');
  if (isForm) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.status(status).end(handoffPage(status, body));
    return;
  }
  res.status(status).json(body);
};

module.exports._internal = { readPayload, handoffPage, scriptJson };
