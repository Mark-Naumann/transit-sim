// test/planner.test.js
// Tests for "route is optional" next-bus answers, landmark matching,
// the trip planner, and the Vapi webhook choosing the right tool.
// Run with:  npm test

const test = require('node:test');
const assert = require('node:assert');
const sim = require('../lib/simulation');
const { planTrip, durationPhrase } = require('../lib/planner');
const vapiHandler = require('../api/vapi');

const at = (day, hh, mm) => ({ day, minutes: hh * 60 + mm });
const MONDAY = 1;
const SATURDAY = 6;

// ---------------------------------------------------------------------------
// Feature 1: route is optional
// ---------------------------------------------------------------------------

test('no route + a stop on one route gives that route\'s full answer', () => {
  // Only Route 1 serves the Mall. At 10:00 the 9:45 bus reaches it at 10:08.
  const answer = sim.answerNextBus(undefined, 'mall', at(MONDAY, 10, 0));
  assert.match(answer.message, /^The next Route 1 bus reaches Santa Fe Place Mall in 8 minutes/);
});

test('no route at Sheridan lists every route, soonest first', () => {
  // At 10:01: Route 3 leaves 10:10, Route 1 10:15, Routes 2 and 4 at 10:30.
  const answer = sim.answerNextBus('', 'transit center', at(MONDAY, 10, 1));
  assert.strictEqual(answer.routes.length, 4);
  assert.strictEqual(
    answer.message,
    'Route 3 reaches Sheridan Transit Center in 9 minutes, Route 1 in 14 minutes, Route 2 in 29 minutes and Route 4 in 29 minutes.'
  );
});

test('"any route" or "not sure" counts as no route', () => {
  for (const route of ['any', 'any route', 'not sure', null, '  ']) {
    const answer = sim.answerNextBus(route, 'hospital', at(MONDAY, 10, 0));
    assert.match(answer.message, /The next Route 2 bus reaches Christus St\. Vincent hospital/, String(route));
  }
});

test('no route on Saturday at Sheridan says Route 3 has no trips', () => {
  const answer = sim.answerNextBus('', 'sheridan', at(SATURDAY, 10, 1));
  assert.match(answer.message, /Route 3 has no more trips there today\./);
});

test('no route, late at night: first bus tomorrow', () => {
  const answer = sim.answerNextBus('', 'sheridan', at(MONDAY, 23, 0));
  assert.match(answer.message, /no more buses at Sheridan Transit Center today\. The first one tomorrow is Route 1 at 5:30 AM/);
});

test('a landmark that is not a stop names the closest stop', () => {
  const answer = sim.answerNextBus('', 'the folk art museum', at(MONDAY, 10, 0));
  assert.match(answer.message, /^Museum of International Folk Art isn't a bus stop\. The closest stop is Museum Hill, about 0\.1 miles away\./);
  assert.match(answer.message, /Route 4/);
});

test('an unknown place lists the stops instead of guessing', () => {
  const answer = sim.answerNextBus('', 'Santa Fe Opera', at(MONDAY, 10, 0));
  assert.strictEqual(answer.found, false);
  assert.match(answer.message, /couldn't find a stop or place called "Santa Fe Opera"/);
  assert.match(answer.message, /Main Library/);
});

// ---------------------------------------------------------------------------
// Feature 2: trip planner
// ---------------------------------------------------------------------------

test('direct trip: mall to railyard on Route 1', () => {
  // 9:45 trip reaches the Mall at 10:08 and the Railyard (on the way back) at 10:27.
  const plan = planTrip('mall', 'railyard', at(MONDAY, 10, 0));
  assert.strictEqual(plan.transfers, 0);
  assert.strictEqual(plan.message, 'Take Route 1 from Santa Fe Place Mall to Railyard. Next bus leaves in 8 minutes, about 27 minutes total.');
});

test('transfer trip: mall to hospital changes to Route 2 at Sheridan', () => {
  const plan = planTrip('the mall', 'hospital', at(MONDAY, 10, 0));
  assert.strictEqual(plan.transfers, 1);
  assert.deepStrictEqual(plan.legs.map((l) => l.route.id), ['1', '2']);
  assert.strictEqual(plan.legs[0].to, 'Sheridan Transit Center');
  assert.match(plan.message, /^Take Route 1 from Santa Fe Place Mall to Sheridan Transit Center, then transfer to Route 2 to Christus St\. Vincent hospital\./);
  // Route 1 gets to Sheridan at 10:31 or 10:46; Route 2 leaves at 11:00, reaches
  // the hospital at 11:12. Both arrive together, so it picks the LATER first bus
  // (10:23) to save waiting: leaves in 23 minutes, 72 minutes total.
  assert.strictEqual(plan.leavesInMinutes, 23);
  assert.strictEqual(plan.totalMinutes, 72);
  assert.match(plan.message, /Next bus leaves in 23 minutes, about 1 hour 12 minutes total\.$/);
});

test('the transfer leaves time to walk between buses', () => {
  const plan = planTrip('canyon road', 'community college', at(MONDAY, 9, 0));
  const [leg1, leg2] = plan.legs;
  const minutes = (t) => {
    const [, h, m, ampm] = t.match(/(\d+):(\d+) (AM|PM)/);
    return ((Number(h) % 12) + (ampm === 'PM' ? 12 : 0)) * 60 + Number(m);
  };
  assert.ok(minutes(leg2.departs) - minutes(leg1.arrives) >= 2);
});

test('trip from a landmark says which stop is closest first', () => {
  const plan = planTrip('Museum of International Folk Art', 'library', at(MONDAY, 9, 0));
  assert.match(plan.message, /^Museum of International Folk Art isn't a bus stop\. The closest stop is Museum Hill/);
  assert.match(plan.message, /Take Route 4 from Museum Hill to Sheridan Transit Center, then transfer to Route 2 to Main Library\./);
});

test('no trip today (Route 3 on Saturday) gives the first one on Monday', () => {
  const plan = planTrip('mall', 'college', at(SATURDAY, 10, 0));
  assert.strictEqual(plan.day, 'Monday');
  assert.match(plan.message, /There's no trip today that gets you there\. The first one on Monday: take Route 1/);
});

test('same stop: no bus needed', () => {
  const plan = planTrip('the plaza', 'Sheridan Transit Center', at(MONDAY, 9, 0));
  assert.match(plan.message, /same stop, Sheridan Transit Center, so you don't need a bus/);
});

test('unknown place in a trip plan', () => {
  const plan = planTrip('mall', 'the moon', at(MONDAY, 9, 0));
  assert.strictEqual(plan.found, false);
  assert.match(plan.message, /couldn't find a stop or place called "the moon"/);
});

test('trip length is spoken naturally', () => {
  assert.strictEqual(durationPhrase(35), '35 minutes');
  assert.strictEqual(durationPhrase(60), '1 hour');
  assert.strictEqual(durationPhrase(132), '2 hours 12 minutes');
});

// ---------------------------------------------------------------------------
// The Vapi webhook picks the right tool by name
// ---------------------------------------------------------------------------

// Call the real /api/vapi handler with a fake request and capture the reply.
function callVapi(toolCalls) {
  const req = { method: 'POST', body: { message: { type: 'tool-calls', toolCallList: toolCalls } } };
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(text) { this.body = JSON.parse(text); },
  };
  vapiHandler(req, res);
  return res;
}

test('/api/vapi handles plan_trip and get_next_bus (without a route) together', () => {
  const res = callVapi([
    { id: 'a', function: { name: 'plan_trip', arguments: { from: 'mall', to: 'hospital' } } },
    { id: 'b', function: { name: 'get_next_bus', arguments: '{"stop":"the library"}' } },
  ]);
  assert.strictEqual(res.statusCode, 200);
  const [trip, nextBus] = res.body.results;
  assert.strictEqual(trip.toolCallId, 'a');
  // (This uses the real clock, so only check what's true at any hour.)
  assert.match(trip.result, /take Route 1 from Santa Fe Place Mall to Sheridan Transit Center, then transfer to Route 2/i);
  assert.strictEqual(nextBus.toolCallId, 'b');
  assert.match(nextBus.result, /Route 2 buses? to Main Library|Route 2 bus reaches Main Library/);
});
