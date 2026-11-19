// api/vapi.js
// POST /api/vapi  -  the webhook a Vapi voice agent calls when it uses our tool.
//
// Vapi sends:
//   { "message": { "type": "tool-calls",
//                  "toolCallList": [ { "id": "abc", "function": { "name": "...",
//                                      "arguments": { "route": "2", "stop": "library" } } } ] } }
// We reply:
//   { "results": [ { "toolCallId": "abc", "result": "The next Route 2 bus..." } ] }
//
// Two tools are handled, chosen by function.name:
//   get_next_bus(stop, route?)  - next arrivals (route is optional)
//   plan_trip(from, to)         - best trip, with one transfer at Sheridan if needed

const { answerNextBus, getDenverClock } = require('../lib/simulation');
const { planTrip } = require('../lib/planner');
const { sendJson } = require('../lib/http');

// Vapi may send arguments as an object or as a JSON string. Handle both.
function readArguments(call) {
  const args = (call.function && call.function.arguments) || {};
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args;
}

module.exports = (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 200, { message: 'This endpoint expects a POST from Vapi.' });
  }

  // Vercel usually parses JSON for us; if it arrives as text, parse it ourselves.
  let body = req.body || {};
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  const message = body.message || {};
  const calls = message.toolCallList || message.toolCalls || [];

  if (message.type !== 'tool-calls' || calls.length === 0) {
    return sendJson(res, 200, { results: [] });
  }

  const clock = getDenverClock(new Date());
  const results = calls.map((call) => {
    const args = readArguments(call);
    const toolName = (call.function && call.function.name) || '';

    // plan_trip(from, to) -> trip planner. Anything else (get_next_bus) -> next bus.
    const answer = toolName === 'plan_trip'
      ? planTrip(args.from, args.to, clock)
      : answerNextBus(args.route, args.stop, clock); // route is optional
    return { toolCallId: call.id, result: answer.message };
  });

  sendJson(res, 200, { results });
};
