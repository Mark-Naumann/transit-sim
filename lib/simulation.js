// lib/simulation.js
// -----------------------------------------------------------------------------
// The "brain" of the demo. Given the route data and the current time, it works
// out where every bus is and when the next buses reach a stop.
//
// Time is stored as a simple "clock" object so it is easy to test:
//   { day: 0-6 (0 = Sunday), minutes: minutes since midnight in Santa Fe }
//   Example: Monday 5:29am  ->  { day: 1, minutes: 329 }
// -----------------------------------------------------------------------------

const data = require('../data/routes.json');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ============================================================================
// 1. Time helpers
// ============================================================================

// Turn a real Date into a Santa Fe (America/Denver) clock.
// Intl.DateTimeFormat handles daylight saving time for us.
function getDenverClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: data.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type).value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const minutes = Number(get('hour')) * 60 + Number(get('minute')) + Number(get('second')) / 60;
  return { day, minutes };
}

// "05:30" -> 330 (minutes since midnight)
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// 330 -> "5:30 AM"
function formatTime(minutes) {
  const total = Math.round(minutes) % (24 * 60);
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

// Sunday -> "sunday", Saturday -> "saturday", Mon-Fri -> "weekday"
function dayType(day) {
  if (day === 0) return 'sunday';
  if (day === 6) return 'saturday';
  return 'weekday';
}

// ============================================================================
// 2. Route helpers (timetable math)
// ============================================================================

// A "pattern" is the full list of stops one trip visits, with the number of
// minutes after departure that the bus reaches each one.
//   Loop:          A -> B -> C -> D -> A
//   Out-and-back:  A -> B -> C -> B -> A
function buildPattern(route) {
  const stops = route.stops;
  const legs = route.travelMinutes;
  const lastIndex = stops.length - 1;
  const pattern = [{ stop: stops[0], offset: 0 }];
  let t = 0;

  // Outbound: first stop to last stop.
  for (let i = 0; i < lastIndex; i++) {
    t += legs[i];
    pattern.push({ stop: stops[i + 1], offset: t });
  }

  if (route.shape === 'loop') {
    // The last travel time is from the last stop back to the first.
    t += legs[lastIndex];
    pattern.push({ stop: stops[0], offset: t });
  } else {
    // Out-and-back: drive the same stops in reverse.
    for (let i = lastIndex - 1; i >= 0; i--) {
      t += legs[i];
      pattern.push({ stop: stops[i], offset: t });
    }
  }

  // Add a "heading to" label to each pattern entry (not needed for loops).
  pattern.forEach((entry, index) => {
    if (route.shape === 'loop') entry.headingTo = null;
    else entry.headingTo = index < lastIndex ? stops[lastIndex].name : stops[0].name;
  });

  return pattern;
}

// Work out each route's pattern once, when the file loads.
const routes = data.routes.map((route) => {
  const pattern = buildPattern(route);
  return { ...route, pattern, tripMinutes: pattern[pattern.length - 1].offset };
});

// List every trip departure time (minutes since midnight) on a given day.
function getTripStarts(route, day) {
  const service = route.service[dayType(day)];
  if (!service) return []; // no buses that day

  const starts = [];
  const last = toMinutes(service.lastTrip);
  for (let t = toMinutes(service.firstTrip); t <= last; t += service.headwayMinutes) {
    starts.push(t);
  }
  return starts;
}

// Where is a bus that has been driving for `elapsed` minutes on this route?
// Returns the stop it last passed, the next stop, and a map position
// (we slide the bus in a straight line between the two stops).
function positionOnTrip(route, elapsed) {
  const p = route.pattern;
  for (let i = 0; i < p.length - 1; i++) {
    if (elapsed >= p[i].offset && elapsed < p[i + 1].offset) {
      const fraction = (elapsed - p[i].offset) / (p[i + 1].offset - p[i].offset);
      return {
        lastStop: p[i].stop,
        nextStop: p[i + 1].stop,
        headingTo: p[i].headingTo,
        lat: p[i].stop.lat + (p[i + 1].stop.lat - p[i].stop.lat) * fraction,
        lng: p[i].stop.lng + (p[i + 1].stop.lng - p[i].stop.lng) * fraction,
      };
    }
  }
  // Exactly at the end of the trip: the bus is at the final stop.
  const end = p[p.length - 1].stop;
  return { lastStop: end, nextStop: null, headingTo: null, lat: end.lat, lng: end.lng };
}

// ============================================================================
// 3. DATA SOURCE: the only part that would change for a real GTFS feed.
//    Everything else (API answers, the map) only calls these two functions.
// ============================================================================

// Where is every bus right now?
// Real-data version: read a GTFS-realtime "VehiclePositions" feed instead.
function getVehiclePositions(clock) {
  const vehicles = [];
  for (const route of routes) {
    for (const start of getTripStarts(route, clock.day)) {
      const elapsed = clock.minutes - start;
      if (elapsed >= 0 && elapsed <= route.tripMinutes) {
        const pos = positionOnTrip(route, elapsed);
        vehicles.push({
          id: `${route.id}-${formatTime(start).replace(/\W/g, '')}`, // e.g. "2-330PM"
          routeId: route.id,
          color: route.color,
          lat: pos.lat,
          lng: pos.lng,
          lastStop: pos.lastStop.name,
          nextStop: pos.nextStop ? pos.nextStop.name : null,
          headingTo: pos.headingTo,
          departedAt: formatTime(start),
        });
      }
    }
  }
  return vehicles;
}

// When do the next buses reach a stop today? (Returns up to `count`.)
// Real-data version: read a GTFS-realtime "TripUpdates" feed instead.
function getArrivals(route, stopId, clock, count = 2) {
  const arrivals = [];
  const starts = getTripStarts(route, clock.day);
  starts.forEach((start, tripIndex) => {
    // Skip the last pattern entry: the trip ends there, so nobody boards.
    route.pattern.slice(0, -1).forEach((entry) => {
      const arrivalTime = start + entry.offset;
      if (entry.stop.id === stopId && arrivalTime >= clock.minutes) {
        const elapsed = clock.minutes - start;
        let busNear = null; // null = this bus hasn't left yet
        if (elapsed >= 0) {
          busNear = positionOnTrip(route, elapsed).lastStop.name;
        } else if (route.shape === 'loop' && tripIndex > 0) {
          // On a loop, the same bus is still finishing its previous lap.
          const lapElapsed = clock.minutes - starts[tripIndex - 1];
          if (lapElapsed <= route.tripMinutes) busNear = positionOnTrip(route, lapElapsed).lastStop.name;
        }
        arrivals.push({
          minutesAway: Math.round(arrivalTime - clock.minutes),
          arrivalTime: formatTime(arrivalTime),
          headingTo: entry.headingTo,
          busCurrentlyNear: busNear,
          departsFirstStopAt: formatTime(start),
        });
      }
    });
  });
  arrivals.sort((a, b) => a.minutesAway - b.minutesAway);
  return arrivals.slice(0, count);
}

// ============================================================================
// 4. Loose matching for what a caller says ("the library", "route two"...)
// ============================================================================

const FILLER_WORDS = new Set(['the', 'a', 'an', 'at', 'to', 'and', 'stop', 'bus', 'rd', 'road', 'dr', 'drive', 'ave', 'avenue']);

// "the Main Library!" -> ["main", "library"]
function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bsaint\b/g, 'st')
    .replace(/['’.]/g, '') // "St. Michael's" -> "st michaels"
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !FILLER_WORDS.has(w));
}

const NUMBER_WORDS = { one: '1', two: '2', three: '3', four: '4' };

// "2", "Route 2", "route two", "hospital loop" -> the Route 2 object
function findRoute(query) {
  const tokens = words(query).map((w) => NUMBER_WORDS[w] || w);
  const byNumber = routes.find((r) => tokens.includes(r.id));
  if (byNumber) return byNumber;
  return routes.find((r) => words(r.name).some((w) => tokens.includes(w))) || null;
}

// Score each stop by how many of the caller's words appear in its name or
// aliases, and pick the best one. "the library" -> "Main Library".
function findStop(route, query) {
  const queryWords = words(query);
  if (queryWords.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const stop of route.stops) {
    for (const label of [stop.name, stop.id, ...(stop.aliases || [])]) {
      const labelWords = words(label.replace(/-/g, ' '));
      const score = queryWords.filter((w) => labelWords.includes(w)).length;
      if (score > bestScore) {
        best = stop;
        bestScore = score;
      }
    }
  }
  return best;
}

// ============================================================================
// 5. The answer used by both APIs: data + one sentence an agent can say
// ============================================================================

function minutesPhrase(m) {
  if (m < 1) return 'less than a minute';
  return m === 1 ? '1 minute' : `${m} minutes`;
}

function answerNextBus(routeQuery, stopQuery, clock) {
  const route = findRoute(routeQuery);
  if (!route) {
    const list = routes.map((r) => `Route ${r.id} ${r.name}`).join(', ');
    return { found: false, message: `I couldn't find that route. Juniper Valley Transit runs ${list}.` };
  }

  const stop = findStop(route, stopQuery);
  if (!stop) {
    const list = route.stops.map((s) => s.name).join(', ');
    return {
      found: false,
      route: { id: route.id, name: route.name },
      stops: route.stops.map((s) => s.name),
      message: `I couldn't find that stop on Route ${route.id}. Its stops are: ${list}.`,
    };
  }

  const result = {
    found: true,
    route: { id: route.id, name: route.name },
    stop: { id: stop.id, name: stop.name },
    now: formatTime(clock.minutes),
    arrivals: getArrivals(route, stop.id, clock, 2),
  };
  const label = `Route ${route.id}`;

  // Case 1: no more buses today -> find the first one on the next service day.
  if (result.arrivals.length === 0) {
    for (let daysAhead = 1; daysAhead <= 7; daysAhead++) {
      const futureDay = (clock.day + daysAhead) % 7;
      const [first] = getArrivals(route, stop.id, { day: futureDay, minutes: 0 }, 1);
      if (first) {
        const when = daysAhead === 1 ? 'tomorrow' : `on ${DAY_NAMES[futureDay]}`;
        result.nextService = { day: DAY_NAMES[futureDay], arrivalTime: first.arrivalTime };
        result.message = `There are no more ${label} buses to ${stop.name} today. The first bus ${when} reaches it at ${first.arrivalTime}.`;
        return result;
      }
    }
  }

  // Case 2: there are buses coming today.
  const [next, after] = result.arrivals;
  const heading = (a) => (a.headingTo ? ` heading to ${a.headingTo}` : '');
  const firstStart = toMinutes(route.service[dayType(clock.day)].firstTrip);

  let message = '';
  if (clock.minutes < firstStart) {
    message += `${label} service starts at ${formatTime(firstStart)} today. `;
  }
  message += `The next ${label} bus reaches ${stop.name} in ${minutesPhrase(next.minutesAway)}${heading(next)}`;
  message += after
    ? `, then another in ${minutesPhrase(after.minutesAway)}.`
    : `. That's the last ${label} bus there today.`;
  if (next.busCurrentlyNear) {
    message += ` It's currently near ${next.busCurrentlyNear}.`;
  } else if (clock.minutes >= firstStart) {
    message += ` That bus leaves ${route.stops[0].name} at ${next.departsFirstStopAt}.`;
  }

  result.message = message;
  return result;
}

// Everything the map page needs in one go: routes, stops, buses, departures.
function getLiveSnapshot(clock) {
  return {
    now: formatTime(clock.minutes),
    day: DAY_NAMES[clock.day],
    routes: routes.map((route) => ({
      id: route.id,
      name: route.name,
      color: route.color,
      stops: route.stops.map(({ id, name, lat, lng }) => ({ id, name, lat, lng })),
      // The line to draw: every stop in order (closing the loop for Route 2).
      path: route.stops
        .concat(route.shape === 'loop' ? [route.stops[0]] : [])
        .map((s) => [s.lat, s.lng]),
      nextDepartures: getArrivals(route, route.stops[0].id, clock, 3).map((a) => a.arrivalTime),
    })),
    vehicles: getVehiclePositions(clock),
  };
}

module.exports = {
  getDenverClock,
  getVehiclePositions,
  getArrivals,
  answerNextBus,
  getLiveSnapshot,
  findRoute,
  findStop,
  getTripStarts,
  formatTime,
  routes,
};
