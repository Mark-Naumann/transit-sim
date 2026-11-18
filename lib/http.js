// lib/http.js
// Small helper so every API sends JSON the same way.

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store'); // bus times change every second
  res.setHeader('Access-Control-Allow-Origin', '*'); // allow tools like Vapi to call us
  res.end(JSON.stringify(body, null, 2));
}

module.exports = { sendJson };
