// test/schedule.test.js
// Run with:  npm test
// Each test uses a fake clock so results don't depend on the real time.
//   { day: 1, minutes: 329 }  =  Monday 5:29am

const test = require('node:test');
const assert = require('node:assert');
const sim = require('../lib/simulation');

const at = (day, hh, mm) => ({ day, minutes: hh * 60 + mm });
const MONDAY = 1;
const SATURDAY = 6;
const SUNDAY = 0;

test('a bus at 5:29am Monday says service starts at 5:30', () => {
  const answer = sim.answerNextBus('1', 'Sheridan Transit Center', at(MONDAY, 5, 29));
  assert.match(answer.message, /starts at 5:30 AM/);
  assert.strictEqual(answer.arrivals[0].minutesAway, 1);
});

test('Route 2 next two arrivals at the library are 30 minutes apart', () => {
  // Trips leave Sheridan every 30 min; library is 3 min after departure.
  // At 10:00 the 10:00 trip reaches the library at 10:03, the next at 10:33.
  const answer = sim.answerNextBus('2', 'library', at(MONDAY, 10, 0));
  assert.deepStrictEqual(answer.arrivals.map((a) => a.minutesAway), [3, 33]);
  // At exactly 10:00 the 10:00 bus is leaving Sheridan, 1 stop from the library.
  assert.strictEqual(answer.arrivals[0].bus.justLeft, 'Sheridan Transit Center');
  assert.strictEqual(answer.arrivals[0].bus.stopsAway, 1);
});

test('location describes the SAME bus as the first arrival, in plain words', () => {
  // Route 1, Monday 10:13. The 10:00 bus left Cerrillos & St. Michael's at 10:12
  // and reaches the Mall at 10:23 (Cerrillos & Rodeo is in between).
  const clock = at(MONDAY, 10, 13);
  const answer = sim.answerNextBus('1', 'the mall', clock);
  const next = answer.arrivals[0];

  assert.strictEqual(next.minutesAway, 10);
  assert.strictEqual(next.bus.id, '1-1000AM');
  assert.match(answer.message, /It's 2 stops away, just left Cerrillos and St\. Michael's\./);

  // The map must show that same bus at that same spot.
  const onMap = sim.getVehiclePositions(clock).find((v) => v.id === next.bus.id);
  assert.strictEqual(onMap.lastStop, next.bus.justLeft);
});

test('every minute of a weekday, at every stop, the location matches the arriving bus', () => {
  for (let minute = 0; minute < 24 * 60; minute++) {
    const clock = { day: MONDAY, minutes: minute };
    const buses = sim.getVehiclePositions(clock);
    for (const route of sim.routes) {
      for (const stop of route.stops) {
        const [next] = sim.getArrivals(route, stop.id, clock, 1);
        if (!next || next.bus.status !== 'on-the-way') continue;
        const onMap = buses.find((v) => v.id === next.bus.id);
        assert.ok(onMap, `bus ${next.bus.id} should be on the map at minute ${minute}`);
        assert.strictEqual(onMap.lastStop, next.bus.justLeft);
        assert.ok(next.bus.stopsAway >= 0);
      }
    }
  }
});

test('the old bug: Route 2 no longer describes the previous lap\'s bus', () => {
  // At 10:20 the 10:00 bus is near St. Michael's & Llano, but the next bus to
  // the library is the 10:30 trip, which hasn't left Sheridan yet.
  const answer = sim.answerNextBus('2', 'library', at(MONDAY, 10, 20));
  assert.strictEqual(answer.arrivals[0].minutesAway, 13);
  assert.strictEqual(answer.arrivals[0].bus.id, '2-1030AM');
  assert.match(answer.message, /hasn't left yet\. It leaves Sheridan Transit Center at 10:30 AM\./);
  assert.doesNotMatch(answer.message, /Llano/);
});

test('loose stop names all match the Main Library', () => {
  const route2 = sim.findRoute('2');
  for (const name of ['library', 'the library', 'Main Library', 'main library stop']) {
    assert.strictEqual(sim.findStop(route2, name).id, 'library', name);
  }
  assert.strictEqual(sim.findStop(route2, 'the hospital').id, 'hospital');
  assert.strictEqual(sim.findStop(route2, "St. Michael's").id, 'stmichaels-llano');
});

test('loose route names work', () => {
  assert.strictEqual(sim.findRoute('Route 2').id, '2');
  assert.strictEqual(sim.findRoute('route two').id, '2');
  assert.strictEqual(sim.findRoute('museum hill').id, '4');
});

test('after the last trip, it says when the first bus runs tomorrow', () => {
  const answer = sim.answerNextBus('4', 'museum hill', at(MONDAY, 23, 0));
  assert.match(answer.message, /no more Route 4 buses/);
  assert.match(answer.message, /tomorrow reaches it at 5:42 AM/); // 5:30 + 5 + 7
});

test('Saturday night skips Sunday and points to Monday', () => {
  const answer = sim.answerNextBus('1', 'railyard', at(SATURDAY, 21, 0));
  assert.match(answer.message, /on Monday reaches it at 5:34 AM/);
});

test('Route 3 does not run on Saturday', () => {
  assert.deepStrictEqual(sim.getTripStarts(sim.findRoute('3'), SATURDAY), []);
});

test('Route 1 runs every 15 minutes on weekdays and 30 on Saturday', () => {
  const route1 = sim.findRoute('1');
  const weekday = sim.getTripStarts(route1, MONDAY);
  const saturday = sim.getTripStarts(route1, SATURDAY);
  assert.strictEqual(weekday[1] - weekday[0], 15);
  assert.strictEqual(saturday[1] - saturday[0], 30);
});

test('unknown stop returns the list of stops on that route', () => {
  const answer = sim.answerNextBus('2', 'airport', at(MONDAY, 10, 0));
  assert.strictEqual(answer.found, false);
  assert.match(answer.message, /Main Library/);
});

test('no buses on the map on Sunday, some on Monday midday', () => {
  assert.strictEqual(sim.getVehiclePositions(at(SUNDAY, 12, 0)).length, 0);
  assert.ok(sim.getVehiclePositions(at(MONDAY, 12, 0)).length > 0);
});

test('a bus between two stops sits on the street line drawn on the map', () => {
  // Route 4 trip leaves at 12:30; Sheridan -> Canyon Rd takes 5 min.
  // At 12:32:30 the bus is halfway there, somewhere on the drawn street path.
  const clock = { day: MONDAY, minutes: 12 * 60 + 32.5 };
  const bus = sim.getVehiclePositions(clock).find((v) => v.id === '4-1230PM');
  assert.strictEqual(bus.lastStop, 'Sheridan Transit Center');
  assert.strictEqual(bus.nextStop, 'Canyon Rd');

  // Distance from the bus to the nearest piece of the line (should be ~0).
  const line = sim.getLiveSnapshot(clock).routes.find((r) => r.id === '4').path;
  const distanceToPiece = ([px, py], [ax, ay], [bx, by]) => {
    const len = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len));
    return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
  };
  const closest = Math.min(...line.slice(1).map((p, i) => distanceToPiece([bus.lat, bus.lng], line[i], p)));
  assert.ok(closest < 1e-9, `bus is ${closest} degrees off the line`);
  assert.ok(line.length > 10, 'route line should follow streets, not just connect 3 stops');
});

test('real time is converted to Santa Fe time', () => {
  // 12:29 UTC on Monday Nov 16, 2026 = 5:29am in Santa Fe (UTC-7 in winter).
  const clock = sim.getDenverClock(new Date('2026-11-16T12:29:00Z'));
  assert.strictEqual(clock.day, MONDAY);
  assert.strictEqual(clock.minutes, 329);
});
