// Run the extractor handler locally against a list of sites; prints primary/secondary/palette.
// Usage: node scripts/run-extract.js site1 site2 ...   (JSON lines on stdout)
const handler = require('../api/extract.js');
async function run(url) {
  return new Promise((resolve) => {
    const res = {
      _s: 200, setHeader() {}, status(s) { this._s = s; return this; },
      json(o) { resolve({ status: this._s, ...o }); }, end() { resolve({ status: this._s }); },
    };
    handler({ method: 'GET', query: { url } }, res).catch((e) => resolve({ error: String(e) }));
  });
}
(async () => {
  const sites = process.argv.slice(2);
  await Promise.all(sites.map(async (s) => {
    const t = Date.now();
    const d = await run(s);
    console.log(JSON.stringify({ site: s, ms: Date.now() - t, p: d.primary, pSrc: d.primarySources, s: d.secondary, sSrc: d.secondarySources, conf: d.confidence, pal: (d.palette || []).slice(2, 7), logo: (d.logo||"").slice(-50), err: d.error, warn: d.warnings }));
  }));
})();
