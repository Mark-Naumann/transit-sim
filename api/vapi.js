// api/vapi.js
// POST /api/vapi  -  the webhook a Vapi voice agent calls when it uses our tool.
//
// Vapi sends:
//   { "message": { "type": "tool-calls",
//                  "toolCallList": [ { "id": "abc", "function": { "name": "...",
//                                      "arguments": { "route": "2", "stop": "library" } } } ] } }
// We reply:
//   { "results": [ { "toolCallId": "abc", "result": "The next Route 2 bus..." } ] }

const { answerNextBus, getDenverClock } = require('../lib/simulation');
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
    const { route, stop } = readArguments(call);
    const answer = answerNextBus(route, stop, clock);
    return { toolCallId: call.id, result: answer.message };
  });

  sendJson(res, 200, { results });
};
