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

  // Anything else -> serve the map page.
  const page = path.join(__dirname, 'public', 'index.html');
  res.setHeader('Content-Type', 'text/html');
  fs.createReadStream(page).pipe(res);
});

server.listen(PORT, () => console.log(`transit-sim running at http://localhost:${PORT}`));
