// lib/planner.js
// -----------------------------------------------------------------------------
// Trip planner: "How do I get from the mall to the hospital?"
//
// It works like a person reading the timetable:
//   1. Figure out which stops the caller means (loose matching, landmarks too).
//   2. Direct trips: any route that goes from A to B.
//   3. One transfer: ride any route from A to Sheridan Transit Center, then
//      catch the first bus of any route from Sheridan to B.
//   4. Pick the option that ARRIVES earliest. On a tie, prefer fewer transfers,
//      then the one that leaves later (less waiting around).
// Times come from the same simulated schedule as the live map.
// -----------------------------------------------------------------------------

const sim = require('./simulation');

const HUB_ID = 'sheridan'; // the only transfer point
const TRANSFER_MINUTES = 2; // time to walk between buses at the hub

// Every trip on ONE route that takes you from stop A to stop B, boarding at or
// after `earliest` (minutes since midnight). One ride per trip.
function ridesBetween(route, fromId, toId, day, earliest) {
  const rides = [];
  const p = route.pattern;
  for (const start of sim.getTripStarts(route, day)) {
    let best = null;
    // Board anywhere except the last stop (the trip ends there)...
    for (let i = 0; i < p.length - 1; i++) {
      if (p[i].stop.id !== fromId || start + p[i].offset < earliest) continue;
      // ...and get off the first time the bus reaches B after that
      // (getting off at the last stop is fine).
      const j = p.findIndex((entry, k) => k > i && entry.stop.id === toId);
      if (j === -1) continue;
      const ride = { route, board: start + p[i].offset, arrive: start + p[j].offset, headingTo: p[i].headingTo };
      // Same trip, several ways to board? Keep the one that gets there first.
      if (!best || ride.arrive < best.arrive || (ride.arrive === best.arrive && ride.board > best.board)) best = ride;
    }
    if (best) rides.push(best);
  }
  return rides;
}

// All trip options from A to B on one day, leaving at or after `earliest`.
function findOptions(fromId, toId, day, earliest) {
  const options = [];

  // Direct: one bus all the way.
  for (const route of sim.routes) {
    for (const ride of ridesBetween(route, fromId, toId, day, earliest)) options.push([ride]);
  }

  // One transfer at Sheridan Transit Center.
  if (fromId !== HUB_ID && toId !== HUB_ID) {
    for (const route1 of sim.routes) {
      for (const leg1 of ridesBetween(route1, fromId, HUB_ID, day, earliest)) {
        // The first bus from the hub to B on any route, after a short walk.
        let leg2 = null;
        for (const route2 of sim.routes) {
          const [first] = ridesBetween(route2, HUB_ID, toId, day, leg1.arrive + TRANSFER_MINUTES)
            .sort((a, b) => a.arrive - b.arrive);
          if (first && (!leg2 || first.arrive < leg2.arrive)) leg2 = first;
        }
        if (leg2) options.push([leg1, leg2]);
      }
    }
  }

  return options;
}

// Earliest arrival wins; then fewer transfers; then the later departure.
function bestOption(options) {
  const arrive = (o) => o[o.length - 1].arrive;
  return options.sort((a, b) => arrive(a) - arrive(b) || a.length - b.length || b[0].board - a[0].board)[0] || null;
}

// "about 35 minutes" / "about 1 hour 12 minutes"
function durationPhrase(minutes) {
  const m = Math.round(minutes);
  if (m < 60) return `${m} minutes`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  const hourText = hours === 1 ? '1 hour' : `${hours} hours`;
  return rest === 0 ? hourText : `${hourText} ${rest} minutes`;
}

// One short sentence describing the legs.
function describeLegs(legs, fromStop, toStop) {
  const name = (stop) => sim.spoken(stop.name);
  const [leg1, leg2] = legs;
  if (!leg2) return `Take Route ${leg1.route.id} from ${name(fromStop)} to ${name(toStop)}.`;
  const second = leg2.route.id === leg1.route.id ? `catch the next Route ${leg2.route.id}` : `transfer to Route ${leg2.route.id}`;
  return `Take Route ${leg1.route.id} from ${name(fromStop)} to Sheridan Transit Center, then ${second} to ${name(toStop)}.`;
}

// The answer used by /api/plan-trip and the Vapi plan_trip tool.
function planTrip(fromQuery, toQuery, clock) {
  const from = sim.findPlace(fromQuery);
  if (!from) return { found: false, message: sim.notFoundMessage(fromQuery) };
  const to = sim.findPlace(toQuery);
  if (!to) return { found: false, message: sim.notFoundMessage(toQuery) };

  // Notes like "Meow Wolf isn't a bus stop. The closest stop is ..."
  const notes = from.note + to.note;

  if (from.stop.id === to.stop.id) {
    return {
      found: true,
      from: { stop: from.stop.name, place: from.place && from.place.name },
      to: { stop: to.stop.name, place: to.place && to.place.name },
      legs: [],
      message: `${notes}Those are at the same stop, ${sim.spoken(from.stop.name)}, so you don't need a bus.`,
    };
  }

  // Try the rest of today first, then the next days (from midnight).
  for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
    const day = (clock.day + daysAhead) % 7;
    const earliest = daysAhead === 0 ? clock.minutes : 0;
    const best = bestOption(findOptions(from.stop.id, to.stop.id, day, earliest));
    if (!best) continue;

    const first = best[0];
    const last = best[best.length - 1];
    const result = {
      found: true,
      from: { stop: from.stop.name, place: from.place && from.place.name },
      to: { stop: to.stop.name, place: to.place && to.place.name },
      legs: best.map((leg, i) => ({
        route: { id: leg.route.id, name: leg.route.name },
        from: i === 0 ? from.stop.name : 'Sheridan Transit Center',
        to: i === best.length - 1 ? to.stop.name : 'Sheridan Transit Center',
        departs: sim.formatTime(leg.board),
        arrives: sim.formatTime(leg.arrive),
      })),
      transfers: best.length - 1,
      day: sim.DAY_NAMES[day],
    };

    const legsSentence = describeLegs(best, from.stop, to.stop);
    if (daysAhead === 0) {
      result.leavesInMinutes = Math.round(first.board - clock.minutes);
      result.totalMinutes = Math.round(last.arrive - clock.minutes);
      result.message = `${notes}${legsSentence} Next bus leaves in ${sim.minutesPhrase(result.leavesInMinutes)}, ` +
        `about ${durationPhrase(result.totalMinutes)} total.`;
    } else {
      const when = daysAhead === 1 ? 'tomorrow' : `on ${sim.DAY_NAMES[day]}`;
      result.message = `${notes}There's no trip today that gets you there. The first one ${when}: ` +
        `${legsSentence.charAt(0).toLowerCase()}${legsSentence.slice(1, -1)}, leaving at ${sim.formatTime(first.board)} ` +
        `and arriving at ${sim.formatTime(last.arrive)}.`;
    }
    return result;
  }

  return { found: false, message: `${notes}I couldn't find a trip between those stops this week.` };
}

module.exports = { planTrip, ridesBetween, findOptions, durationPhrase, TRANSFER_MINUTES };
