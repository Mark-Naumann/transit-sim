// api/live.js
// GET /api/live  -  everything the map page needs: routes, stops, buses, departures.
// The map calls this every few seconds to move the bus markers.

const { getLiveSnapshot, getDenverClock } = require('../lib/simulation');
const { sendJson } = require('../lib/http');

module.exports = (req, res) => {
  sendJson(res, 200, getLiveSnapshot(getDenverClock(new Date())));
};
