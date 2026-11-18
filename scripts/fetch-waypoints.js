// scripts/fetch-waypoints.js
// -----------------------------------------------------------------------------
// One-time helper: makes route lines follow real streets.
//
// For every pair of neighboring stops, it asks OSRM (a free, open-source route
// planner that uses OpenStreetMap roads) for the driving path between them,
// keeps just enough points to follow the road's turns, and saves them in
// data/routes.json as "waypoints".
//
// Run with:  node scripts/fetch-waypoints.js
// Re-run it whenever you move a stop. The app itself never calls OSRM.
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'routes.json');
const OSRM = 'https://router.project-osrm.org/route/v1/driving';

// How closely to follow the road (in degrees; 0.0001 is about 10 meters).
// Bigger = fewer points, smaller = more detail.
const TOLERANCE = 0.0001;

// Ask OSRM for the road path from stop A to stop B. Returns [[lat, lng], ...].
async function roadPath(a, b) {
  // OSRM wants "longitude,latitude" order.
  const url = `${OSRM}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OSRM returned HTTP ${response.status}`);
  const data = await response.json();
  return data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
}

// Distance from point p to the line from a to b (good enough for a few km).
function distanceToLine(p, a, b) {
  const [x, y] = p;
  const [x1, y1] = a;
  const [x2, y2] = b;
  const lengthSquared = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  if (lengthSquared === 0) return Math.hypot(x - x1, y - y1);
  const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / lengthSquared));
  return Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1)));
}

// Douglas-Peucker simplification: keep the point that bends away from a
// straight line the most, then repeat on each half. Straight roads end up
// with very few points; curvy roads keep more.
function simplify(points) {
  if (points.length < 3) return points;
  let farthest = 0;
  let farthestIndex = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distanceToLine(points[i], points[0], points[points.length - 1]);
    if (d > farthest) {
      farthest = d;
      farthestIndex = i;
    }
  }
  if (farthest <= TOLERANCE) return [points[0], points[points.length - 1]];
  const left = simplify(points.slice(0, farthestIndex + 1));
  const right = simplify(points.slice(farthestIndex));
  return left.slice(0, -1).concat(right);
}

const round = (n) => Math.round(n * 100000) / 100000; // ~1 meter

async function main() {
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));

  for (const route of data.routes) {
    route.waypoints = [];
    // One leg per travelMinutes entry (loops include the leg back to the start).
    for (let i = 0; i < route.travelMinutes.length; i++) {
      const from = route.stops[i];
      const to = route.stops[(i + 1) % route.stops.length];
      const road = simplify(await roadPath(from, to));
      // Drop the first and last point: those are the stops themselves.
      route.waypoints.push(road.slice(1, -1).map(([lat, lng]) => [round(lat), round(lng)]));
      console.log(`Route ${route.id}: ${from.name} -> ${to.name}: ${road.length - 2} waypoints`);
      await new Promise((r) => setTimeout(r, 1100)); // be polite to the free server
    }
  }

  // Save, keeping each [lat, lng] pair on one line so the file stays readable.
  const text = JSON.stringify(data, null, 2).replace(
    /\[\s+(-?\d+(?:\.\d+)?),\s+(-?\d+(?:\.\d+)?)\s+\]/g,
    '[$1, $2]'
  );
  fs.writeFileSync(FILE, text + '\n');
  console.log('Saved waypoints to data/routes.json');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
