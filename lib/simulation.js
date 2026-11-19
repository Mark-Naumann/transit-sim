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

// The street path of one "leg" (stop i to the next stop), as [[lat, lng], ...].
// It starts and ends at the stops, with the road waypoints from routes.json
// in between, so lines and buses follow real streets.
function legPath(route, i) {
  const from = route.stops[i];
  const to = route.stops[(i + 1) % route.stops.length];
  const waypoints = (route.waypoints && route.waypoints[i]) || [];
  return [[from.lat, from.lng], ...waypoints, [to.lat, to.lng]];
}

// A "pattern" is the full list of stops one trip visits, with the number of
// minutes after departure that the bus reaches each one, and the street path
// to the next stop.
//   Loop:          A -> B -> C -> D -> A
//   Out-and-back:  A -> B -> C -> B -> A   (coming back uses the same streets, reversed)
function buildPattern(route) {
  const stops = route.stops;
  const legs = route.travelMinutes;
  const lastIndex = stops.length - 1;
  const pattern = [{ stop: stops[0], offset: 0 }];
  let t = 0;

  // Outbound: first stop to last stop.
  for (let i = 0; i < lastIndex; i++) {
    pattern[pattern.length - 1].pathToNext = legPath(route, i);
    t += legs[i];
    pattern.push({ stop: stops[i + 1], offset: t });
  }

  if (route.shape === 'loop') {
    // The last travel time is from the last stop back to the first.
    pattern[pattern.length - 1].pathToNext = legPath(route, lastIndex);
    t += legs[lastIndex];
    pattern.push({ stop: stops[0], offset: t });
  } else {
    // Out-and-back: drive the same stops in reverse.
    for (let i = lastIndex - 1; i >= 0; i--) {
      pattern[pattern.length - 1].pathToNext = legPath(route, i).slice().reverse();
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

// Each trip gets an ID like "2-1030AM" (route + departure time).
// The map and the API answers both use it, so they always talk about the same bus.
function vehicleId(route, start) {
  return `${route.id}-${formatTime(start).replace(/\W/g, '')}`;
}

// Find the point that is `fraction` (0 to 1) of the way along a street path,
// measured by distance, so the bus moves along the road, around corners.
function pointAlong(path, fraction) {
  // Longitude degrees are shorter than latitude degrees this far north.
  const lngScale = Math.cos((path[0][0] * Math.PI) / 180);
  const pieceLength = (a, b) => Math.hypot(b[0] - a[0], (b[1] - a[1]) * lngScale);

  let total = 0;
  for (let i = 0; i < path.length - 1; i++) total += pieceLength(path[i], path[i + 1]);

  let remaining = total * fraction;
  for (let i = 0; i < path.length - 1; i++) {
    const piece = pieceLength(path[i], path[i + 1]);
    if (remaining <= piece && piece > 0) {
      const f = remaining / piece;
      return [path[i][0] + (path[i + 1][0] - path[i][0]) * f, path[i][1] + (path[i + 1][1] - path[i][1]) * f];
    }
    remaining -= piece;
  }
  return path[path.length - 1];
}

// Where is a bus that has been driving for `elapsed` minutes on this route?
// Returns the stop it last passed (and its position in the pattern), the next
// stop, and a map position along the street between the two.
function positionOnTrip(route, elapsed) {
  const p = route.pattern;
  for (let i = 0; i < p.length - 1; i++) {
    if (elapsed >= p[i].offset && elapsed < p[i + 1].offset) {
      const fraction = (elapsed - p[i].offset) / (p[i + 1].offset - p[i].offset);
      const [lat, lng] = pointAlong(p[i].pathToNext, fraction);
      return { lastIndex: i, lastStop: p[i].stop, nextStop: p[i + 1].stop, headingTo: p[i].headingTo, lat, lng };
    }
  }
  // Exactly at the end of the trip: the bus is at the final stop.
  const end = p[p.length - 1].stop;
  return { lastIndex: p.length - 1, lastStop: end, nextStop: null, headingTo: null, lat: end.lat, lng: end.lng };
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
          id: vehicleId(route, start), // e.g. "2-330PM"
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

// Describe where one specific bus (the trip that left at `start`) is right now,
// compared with the stop the caller is waiting at (`stopIndex` in the pattern).
function describeBus(route, start, stopIndex, clock) {
  const elapsed = clock.minutes - start;
  const bus = { id: vehicleId(route, start), departsAt: formatTime(start) };

  if (elapsed < 0) {
    bus.status = 'not-departed'; // still waiting at the first stop
    return bus;
  }
  const position = positionOnTrip(route, elapsed);
  bus.status = 'on-the-way';
  bus.justLeft = position.lastStop.name;
  bus.stopsAway = stopIndex - position.lastIndex; // 0 = it's at the stop right now

  // Out-and-back routes: will the bus reach the end of the line and turn
  // around before it gets to this stop? (Then the caller should hear that.)
  const endIndex = route.stops.length - 1;
  if (route.shape !== 'loop' && position.lastIndex < endIndex && stopIndex > endIndex) {
    bus.turnsAroundAt = route.stops[endIndex].name;
  }
  return bus;
}

// When do the next buses reach a stop today? (Returns up to `count`.)
// Real-data version: read a GTFS-realtime "TripUpdates" feed instead.
function getArrivals(route, stopId, clock, count = 2) {
  const arrivals = [];
  for (const start of getTripStarts(route, clock.day)) {
    // Skip the last pattern entry: the trip ends there, so nobody boards.
    route.pattern.slice(0, -1).forEach((entry, stopIndex) => {
      const arrivalTime = start + entry.offset;
      if (entry.stop.id === stopId && arrivalTime >= clock.minutes) {
        arrivals.push({
          minutesAway: Math.round(arrivalTime - clock.minutes),
          arrivalTime: formatTime(arrivalTime),
          headingTo: entry.headingTo,
          // Where THIS bus (the one making this arrival) is right now.
          bus: describeBus(route, start, stopIndex, clock),
        });
      }
    });
  }
  arrivals.sort((a, b) => a.minutesAway - b.minutesAway);
  return arrivals.slice(0, count);
}

// ============================================================================
// 4. Loose matching for what a caller says ("the library", "route two"...)
// ============================================================================

// Words that don't help tell places apart. "Santa Fe" is in almost every name,
// so "Santa Fe Opera" must not match "Santa Fe Place Mall" just because of it.
const FILLER_WORDS = new Set([
  'the', 'a', 'an', 'at', 'to', 'and', 'of', 'stop', 'bus', 'rd', 'road', 'dr', 'drive', 'ave', 'avenue',
  'santa', 'fe', 'new', 'mexico', 'nm',
]);

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

// How many of the caller's words appear in a stop's or place's name/aliases.
function matchScore(queryWords, item) {
  let best = 0;
  for (const label of [item.name, item.id || '', ...(item.aliases || [])]) {
    const labelWords = words(label.replace(/-/g, ' '));
    best = Math.max(best, queryWords.filter((w) => labelWords.includes(w)).length);
  }
  return best;
}

// Pick the best-matching item from a list (or null if no words match).
function bestMatch(query, items) {
  const queryWords = words(query);
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const score = matchScore(queryWords, item);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return { item: best, score: bestScore };
}

// Find a stop on ONE route. "the library" -> "Main Library".
function findStop(route, query) {
  return bestMatch(query, route.stops).item;
}

// Every stop in the system, once each (Sheridan is on all four routes).
const allStops = [...new Map(routes.flatMap((r) => r.stops).map((s) => [s.id, s])).values()];
const places = data.places || [];

// Straight-line distance in miles between two points on the map ("haversine").
function milesBetween(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3959 * 2 * Math.asin(Math.sqrt(h)); // 3959 = Earth's radius in miles
}

// Find what the caller means, across ALL stops and well-known places.
// Returns { stop, place, miles, note } or null.
//   - a stop:  "the library"  -> Main Library
//   - a place: "Meow Wolf"    -> the closest stop, plus a note to say out loud
function findPlace(query) {
  const stopMatch = bestMatch(query, allStops);
  const placeMatch = bestMatch(query, places);

  // A stop wins ties: if a stop matches as well as a landmark, use the stop.
  if (stopMatch.item && stopMatch.score >= placeMatch.score) {
    return { stop: stopMatch.item, place: null, miles: 0, note: '' };
  }
  if (!placeMatch.item) return null;

  const place = placeMatch.item;
  const nearest = allStops
    .map((stop) => ({ stop, miles: milesBetween(place, stop) }))
    .sort((a, b) => a.miles - b.miles)[0];
  const miles = Math.round(nearest.miles * 10) / 10;
  const far = miles > 1 ? ', so you may want a ride to get there' : '';
  return {
    stop: nearest.stop,
    place,
    miles,
    note: `${place.name} isn't a bus stop. The closest stop is ${spoken(nearest.stop.name)}, about ${miles} ${miles === 1 ? 'mile' : 'miles'} away${far}. `,
  };
}

// The message when we can't find a stop or place at all.
function notFoundMessage(query) {
  const list = allStops.map((s) => spoken(s.name)).join(', ');
  return `I couldn't find a stop or place called "${query}". Juniper Valley Transit stops are: ${list}.`;
}

// ============================================================================
// 5. The answer used by both APIs: data + one sentence an agent can say
// ============================================================================

// How a person would SAY a stop name: "Cerrillos Rd & St. Michael's Dr"
// becomes "Cerrillos and St. Michael's". Other names stay the same.
function spoken(name) {
  if (!name.includes(' & ')) return name;
  return name
    .split(' & ')
    .map((street) => street.replace(/\s(Rd|Dr|St|Ave)$/, ''))
    .join(' and ');
}

function minutesPhrase(m) {
  if (m < 1) return 'less than a minute';
  return m === 1 ? '1 minute' : `${m} minutes`;
}

// "a", "a and b", "a, b and c"
function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// True when the caller didn't name a route ("", null, "any", "not sure"...).
function noRouteGiven(routeQuery) {
  return !routeQuery || /^\s*(any|all|unknown|none|not sure|n\/a)?\s*(route|routes)?\s*$/i.test(String(routeQuery));
}

// Next buses at a stop on EVERY route that serves it (route not given).
function answerNextBusAnyRoute(stopQuery, clock) {
  const found = findPlace(stopQuery);
  if (!found) return { found: false, message: notFoundMessage(stopQuery) };

  const { stop, note } = found;
  const placeName = found.place ? found.place.name : null;
  const servingRoutes = routes.filter((r) => r.stops.some((s) => s.id === stop.id));

  // Only one route stops here: give the full single-route answer.
  if (servingRoutes.length === 1) {
    const answer = answerNextBus(servingRoutes[0].id, stop.name, clock);
    return { ...answer, place: placeName, message: note + answer.message };
  }

  // Several routes stop here (Sheridan Transit Center): the next bus on each.
  const byRoute = servingRoutes.map((route) => ({
    route: { id: route.id, name: route.name },
    arrivals: getArrivals(route, stop.id, clock, 2),
  }));
  const running = byRoute.filter((r) => r.arrivals.length > 0)
    .sort((a, b) => a.arrivals[0].minutesAway - b.arrivals[0].minutesAway);
  const finished = byRoute.filter((r) => r.arrivals.length === 0);

  let message = note;
  if (running.length > 0) {
    // "Route 3 reaches Sheridan Transit Center in 9 minutes, Route 1 in 14 minutes and ..."
    const parts = running.map((r, i) => {
      const when = minutesPhrase(r.arrivals[0].minutesAway);
      return i === 0 ? `Route ${r.route.id} reaches ${spoken(stop.name)} in ${when}` : `Route ${r.route.id} in ${when}`;
    });
    message += `${joinList(parts)}.`;
    if (finished.length > 0) {
      const names = joinList(finished.map((r) => `Route ${r.route.id}`));
      message += ` ${names} ${finished.length === 1 ? 'has' : 'have'} no more trips there today.`;
    }
  } else {
    // Nothing more today: find the first bus on the next day with service.
    for (let daysAhead = 1; daysAhead <= 7; daysAhead++) {
      const futureDay = (clock.day + daysAhead) % 7;
      const firsts = servingRoutes
        .map((route) => ({ route, first: getArrivals(route, stop.id, { day: futureDay, minutes: 0 }, 1)[0] }))
        .filter((r) => r.first)
        .sort((a, b) => a.first.minutesAway - b.first.minutesAway); // minutes after midnight
      if (firsts.length > 0) {
        const when = daysAhead === 1 ? 'tomorrow' : `on ${DAY_NAMES[futureDay]}`;
        message += `There are no more buses at ${spoken(stop.name)} today. The first one ${when} is Route ${firsts[0].route.id} at ${firsts[0].first.arrivalTime}.`;
        break;
      }
    }
  }

  return {
    found: true,
    stop: { id: stop.id, name: stop.name },
    place: placeName,
    now: formatTime(clock.minutes),
    routes: byRoute,
    message,
  };
}

// The next 2 buses on one route at one stop. If no route is given, every
// route that serves the stop is checked instead (see answerNextBusAnyRoute).
function answerNextBus(routeQuery, stopQuery, clock) {
  if (noRouteGiven(routeQuery)) return answerNextBusAnyRoute(stopQuery, clock);

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
  message += `The next ${label} bus reaches ${spoken(stop.name)} in ${minutesPhrase(next.minutesAway)}${heading(next)}`;
  message += after
    ? `, then another in ${minutesPhrase(after.minutesAway)}.`
    : `. That's the last ${label} bus there today.`;

  // Where is that SAME next bus right now? (next.bus belongs to the first arrival.)
  const bus = next.bus;
  if (bus.status === 'on-the-way' && bus.stopsAway === 0) {
    message += ` It's at ${spoken(stop.name)} now.`;
  } else if (bus.status === 'on-the-way') {
    const stops = bus.stopsAway === 1 ? '1 stop' : `${bus.stopsAway} stops`;
    const turnAround = bus.turnsAroundAt ? `, and will turn around at ${spoken(bus.turnsAroundAt)} first` : '';
    message += ` It's ${stops} away, just left ${spoken(bus.justLeft)}${turnAround}.`;
  } else if (clock.minutes >= firstStart) {
    message += ` That bus hasn't left yet. It leaves ${route.stops[0].name} at ${bus.departsAt}.`;
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
      // The line to draw: the street path of each leg, joined together.
      // (Out-and-back routes come back on the same streets, so we draw the way out.)
      path: route.pattern
        .slice(0, route.shape === 'loop' ? -1 : route.stops.length - 1)
        .flatMap((entry, i) => (i === 0 ? entry.pathToNext : entry.pathToNext.slice(1))),
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
  findPlace,
  notFoundMessage,
  spoken,
  minutesPhrase,
  getTripStarts,
  formatTime,
  routes,
  DAY_NAMES,
};
