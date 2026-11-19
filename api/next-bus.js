// api/next-bus.js
// GET /api/next-bus?route=2&stop=library   -> next 2 arrivals on Route 2
// GET /api/next-bus?stop=sheridan          -> route is optional: next bus on
//                                             every route that serves the stop
// Returns JSON plus a spoken-style "message".

const { answerNextBus, getDenverClock } = require('../lib/simulation');
const { sendJson } = require('../lib/http');

module.exports = (req, res) => {
  const { route, stop } = req.query || {};

  if (!stop) {
    return sendJson(res, 200, {
      found: false,
      message: 'Please include a stop, for example /api/next-bus?stop=library (route is optional: &route=2)',
    });
  }

  const answer = answerNextBus(route, stop, getDenverClock(new Date()));
  // Always 200, even for "not found", so an AI agent can read the message.
  sendJson(res, 200, answer);
};
