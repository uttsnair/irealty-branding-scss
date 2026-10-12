// Local dev server: serves public/ and routes /api/* to the real handlers.
// Usage: node scripts/dev-server.js [port]   (then open /studio/)
const http = require('http'), fs = require('fs'), path = require('path');
const handlers = { '/api/extract': require('../api/extract.js'), '/api/extract-from-page': require('../api/extract-from-page.js') };
const PORT = +process.argv[2] || 3055, ROOT = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const handler = handlers[u.pathname];
  if (handler) {
    req.query = Object.fromEntries(u.searchParams);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    return handler(req, res);
  }
  let p = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!p.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
}).listen(PORT, () => console.log('Brand Studio dev server on http://localhost:' + PORT + '/studio/'));
