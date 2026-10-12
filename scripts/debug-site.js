// Print the ranked colour clusters + evidence for one site: node scripts/debug-site.js <site>
const handler = require('../api/extract.js');
handler({ method: 'GET', query: { url: process.argv[2] } }, {
  setHeader() {}, status() { return this; }, end() {},
  json(d) {
    console.log(d.error || '', 'primary', d.primary, 'secondary', d.secondary, d.confidence, '\nlogo', d.logo, JSON.stringify(d.logoColours));
    (d.paletteDetail || []).forEach((p) => console.log(' ', p.hex, String(p.score).padStart(6), p.role || '', p.sources.join(', ')));
  },
});
