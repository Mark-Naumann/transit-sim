// dev-server.js
// A tiny local web server for trying the app on your own computer:  npm start
// It imitates Vercel: files in /public are served as pages, and /api/<name>
// runs api/<name>.js. (On Vercel itself, this file is not used.)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API request -> run the matching file in /api
  if (url.pathname.startsWith('/api/')) {
    const name = path.basename(url.pathname);
    const file = path.join(__dirname, 'api', `${name}.js`);
    if (!fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    // Collect the request body, then hand it to the API like Vercel does.
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      req.query = Object.fromEntries(url.searchParams);
      try {
        req.body = raw ? JSON.parse(raw) : {};
      } catch {
        req.body = raw;
      }
      require(file)(req, res);
    });
    return;
  }

  // A real file in /public (like /audio/office-quiet.mp3) -> send that file.
  // path.normalize + the startsWith check stop "../" tricks from leaving /public.
  const publicDir = path.join(__dirname, 'public');
  const file = path.join(publicDir, path.normalize(decodeURIComponent(url.pathname)));
  if (file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)] || 'application/octet-stream');
    return fs.createReadStream(file).pipe(res);
  }

  // Anything else -> serve the map page.
  res.setHeader('Content-Type', 'text/html');
  fs.createReadStream(path.join(publicDir, 'index.html')).pipe(res);
});

// What kind of file each extension is, so the browser knows how to open it.
const CONTENT_TYPES = { '.html': 'text/html', '.mp3': 'audio/mpeg', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

server.listen(PORT, () => console.log(`transit-sim running at http://localhost:${PORT}`));
