// api/plan-trip.js
// GET /api/plan-trip?from=mall&to=hospital
// Finds the best trip (direct, or one transfer at Sheridan Transit Center)
// using the live simulated times. Returns JSON plus a spoken-style "message".

const { getDenverClock } = require('../lib/simulation');
const { planTrip } = require('../lib/planner');
const { sendJson } = require('../lib/http');

module.exports = (req, res) => {
  const { from, to } = req.query || {};

  if (!from || !to) {
    return sendJson(res, 200, {
      found: false,
      message: 'Please include where you are starting and where you are going, for example /api/plan-trip?from=mall&to=hospital',
    });
  }

  // Always 200, even for "not found", so an AI agent can read the message.
  sendJson(res, 200, planTrip(from, to, getDenverClock(new Date())));
};
