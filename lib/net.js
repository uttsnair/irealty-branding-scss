// Network helpers shared by the extractor endpoints: an honest bot user agent,
// a basic SSRF guard and a size-capped binary fetch.

const UA = 'Mozilla/5.0 (compatible; BrandStudioBot/1.0)';
const TIMEOUT_MS = 9000;
const IMG_MAX = 12_000_000;

// block private / internal targets (basic SSRF guard)
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

// binary fetch for logos and the download proxy (images can be larger than the HTML/CSS cap)
async function fetchBinary(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA } });
    const buf = Buffer.from(await r.arrayBuffer());
    return { buf, status: r.status, contentType: r.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { UA, TIMEOUT_MS, IMG_MAX, hostLooksPrivate, fetchBinary };
