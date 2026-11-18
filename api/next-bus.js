// api/next-bus.js
// GET /api/next-bus?route=2&stop=library
// Returns the next 2 arrivals at that stop, as JSON, plus a spoken-style message.

const { answerNextBus, getDenverClock } = require('../lib/simulation');
const { sendJson } = require('../lib/http');

module.exports = (req, res) => {
  const { route, stop } = req.query || {};

  if (!route || !stop) {
    return sendJson(res, 200, {
      found: false,
      message: 'Please include a route and a stop, for example /api/next-bus?route=2&stop=library',
    });
  }

  const answer = answerNextBus(route, stop, getDenverClock(new Date()));
  // Always 200, even for "not found", so an AI agent can read the message.
  sendJson(res, 200, answer);
};
