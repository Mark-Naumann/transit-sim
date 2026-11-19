# transit-sim — Juniper Valley Transit (JVT) Live Demo

> **Demo only.** Juniper Valley Transit is a fictional agency. The routes use real
> Santa Fe, New Mexico streets and landmarks, but this project is **not affiliated
> with the City of Santa Fe** or any real transit agency.

🎬 **Demo video:** coming soon · 🚌 **Live map:** https://transit-sim-sigma.vercel.app

**Used by:** Jordan v10 ([transit-agent](https://github.com/Mark-Naumann/transit-agent)), the
JVT voice agent, whose `get_next_bus` (tool v4) and `plan_trip` tools call `/api/vapi`.

## What it does

- **Live map** (`/`): four bus routes drawn on an OpenStreetMap map of Santa Fe, with
  bus markers that move every 5 seconds and a sidebar showing each route's next departures.
- **Next-bus API** (`GET /api/next-bus?route=2&stop=library`): returns the next two
  arrivals at a stop, how many minutes away they are, and where the bus is now.
  **`route` is optional**: `/api/next-bus?stop=sheridan` checks every route that serves
  the stop ("Route 3 reaches Sheridan Transit Center in 9 minutes, Route 1 in 14 minutes…").
- **Trip planner** (`GET /api/plan-trip?from=mall&to=hospital`): the best trip using the
  live simulated times, direct or with one transfer at Sheridan Transit Center:
  *"Take Route 1 from Santa Fe Place Mall to Sheridan Transit Center, then transfer to
  Route 2 to Christus St. Vincent hospital. Next bus leaves in 14 minutes, about 1 hour
  3 minutes total."*
- **Voice-agent API** (`POST /api/vapi`): a webhook for a [Vapi](https://vapi.ai) voice
  agent. A caller can ask "When's the next Route 1 bus to the mall?" and the agent
  reads back a short answer such as:
  *"The next Route 1 bus reaches Santa Fe Place Mall in 10 minutes heading to Sheridan
  Transit Center, then another in 25 minutes. It's 2 stops away, just left Cerrillos and
  St. Michael's."* The location always describes the **same bus** as the first arrival
  (the same bus ID shown on the map).
- **Office background audio** (`/audio/office-quiet.mp3`): a very quiet, 30-second,
  seamlessly looping office ambience for the voice agent's background sound.

No database, no paid services, no API keys.

## How it works

```
Caller ──(phone)──▶ Vapi voice agent ──(tool call, JSON)──▶ /api/vapi
                                                              │
                                                              ▼
                                         lib/simulation.js  ◀── data/routes.json
                                         (schedule math using the current
                                          America/Denver time)
                                                              │
Caller ◀──(speech)── Vapi ◀──(one short sentence)─────────────┘
```

1. **Route data** lives in one file, `data/routes.json`: stops (with approximate
   latitude/longitude), travel minutes between stops, first/last trip, and headway
   (minutes between buses) for weekdays, Saturday and Sunday.
2. **The simulation** (`lib/simulation.js`) needs only the clock. If a trip left
   Sheridan Transit Center 10 minutes ago, and we know how long each leg takes, we know
   exactly where that bus is. Between stops, the bus slides along real streets:
   `routes.json` stores road **waypoints** for each leg (fetched once from the free
   OpenStreetMap router OSRM by `scripts/fetch-waypoints.js`), so the map lines and
   the buses follow the roads.
3. **The APIs** (`api/*.js`) are Vercel serverless functions. They read the request,
   ask the simulation, and return JSON. They always return HTTP 200 (even for
   "stop not found") so the voice agent can read the message out loud.
4. **The map** (`public/index.html`) is plain HTML + JavaScript with Leaflet. It calls
   `/api/live` every 5 seconds.

### Routes

| Route | Stops | Service |
|---|---|---|
| 1 Cerrillos | Sheridan TC → Railyard → Cerrillos & St. Michael's → Cerrillos & Rodeo → Santa Fe Place Mall (and back) | Every 15 min weekdays, 30 min Saturday |
| 2 Hospital Loop | Sheridan TC → Main Library → Christus St. Vincent → St. Michael's & Llano → Sheridan TC | Every 30 min |
| 3 College | Sheridan TC → South Capitol station → Rodeo & Richards → Santa Fe Community College (and back) | Every 20 min, weekdays only |
| 4 Museum Hill | Sheridan TC → Canyon Rd → Museum Hill (and back) | Every 60 min |

System hours: Mon–Fri 5:30am–10pm, Sat 7am–8pm, no Sunday service.

### Using it with Vapi

Create custom **tools** (functions) in Vapi, both with the server URL
`https://<your-vercel-url>/api/vapi`. The webhook picks the tool by its name:

| Tool name | Parameters (strings) | What it answers |
|---|---|---|
| `get_next_bus` | `stop` (required), `route` (optional) | Next arrivals at a stop |
| `plan_trip` | `from`, `to` (both required) | Best trip, with one transfer at Sheridan if needed |

Vapi sends:

```json
{ "message": { "type": "tool-calls",
  "toolCallList": [ { "id": "call_1", "function": { "name": "get_next_bus",
    "arguments": { "route": "2", "stop": "the library" } } } ] } }
```

and gets back:

```json
{ "results": [ { "toolCallId": "call_1", "result": "The next Route 2 bus reaches Main Library in ..." } ] }
```

Stop and route names are matched loosely: "the library", "Main Library", "route two",
"hospital loop", "St. Vincent" all work. If a stop isn't found, the answer lists the
stops on that route. After the last bus, it says when the first bus runs tomorrow (or
on Monday, if tomorrow is Sunday).

**Places that aren't stops.** `routes.json` also has a short list of well-known places
(the Plaza, the Roundhouse, Meow Wolf, the Folk Art Museum, the airport…). Ask for one
and the answer starts with the closest stop: *"Museum of International Folk Art isn't a
bus stop. The closest stop is Museum Hill, about 0.1 miles away."* Anything else gets the
list of stops rather than a guess.

**How the trip planner works** (`lib/planner.js`): it checks every route for a direct
ride from A to B, then every "ride to Sheridan, walk 2 minutes, ride from Sheridan"
combination, and picks the one that arrives first (ties: fewer transfers, then the one
that leaves later so you wait less).

## Swapping in a real GTFS feed

The fake data is kept behind a small, clearly marked **DATA SOURCE** section in
`lib/simulation.js`:

- `getVehiclePositions(clock)` — where every bus is right now
- `getArrivals(route, stopId, clock)` — the next arrivals at a stop

The map and both APIs only call these, so to use a real agency's data you change
just that section:

1. Replace `data/routes.json` with the agency's static **GTFS** files (`stops.txt`,
   `routes.txt`, `trips.txt`, `stop_times.txt`, `shapes.txt`), converted to the same shape.
2. Have `getVehiclePositions()` read the **GTFS-realtime VehiclePositions** feed.
3. Have `getArrivals()` read the **GTFS-realtime TripUpdates** feed (real predicted
   arrival times, including delays).

The voice-agent sentence, the loose name matching, and the map don't need to change.

## Run it locally

You need [Node.js](https://nodejs.org) 18 or newer. There is nothing to install.

```bash
npm start        # open http://localhost:3000
npm test         # run the schedule tests
```

Try the API in a second terminal:

```bash
curl "http://localhost:3000/api/next-bus?route=2&stop=library"
```

```bash
curl "http://localhost:3000/api/plan-trip?from=mall&to=hospital"
```

## Project layout

```
data/routes.json      all route, stop and schedule data (the fake "feed")
lib/simulation.js     schedule math, bus positions, name/place matching, spoken answers
lib/planner.js        trip planner (direct or one transfer at Sheridan)
lib/http.js           helper to send JSON responses
api/next-bus.js       GET  /api/next-bus   (route optional)
api/plan-trip.js      GET  /api/plan-trip
api/vapi.js           POST /api/vapi  (Vapi webhook: get_next_bus and plan_trip tools)
api/live.js           GET  /api/live  (data for the map)
public/index.html     the live map page
public/audio/         office-quiet.mp3 background ambience for the voice agent
test/                 tests for the schedule math (node --test)
dev-server.js         tiny local server for `npm start` (Vercel doesn't use it)
scripts/fetch-waypoints.js    one-time: get street paths between stops from OSRM
                              (re-run after moving a stop: node scripts/fetch-waypoints.js)
scripts/make-office-audio.py  one-time: generate the background audio (numpy + ffmpeg)
```

## What I'd do next

- **Exact stop positions**: a few stops sit on a side road instead of the named street,
  which makes small detours in the line; move them onto the street and re-run
  `scripts/fetch-waypoints.js` (with real data, GTFS `shapes.txt` replaces this).
- **Real data**: plug in a live GTFS-realtime feed as described above.
- **Both directions in the voice answer**: let the caller say which way they're going
  ("toward the mall") instead of listing whichever bus comes first.
- **Timed transfers**: line up schedules at Sheridan (a "pulse") so riders don't wait
  half an hour between buses, e.g. mall → hospital is 35 minutes of riding but over an
  hour door to door today.
- **Real geocoding**: look up any address (e.g. OpenStreetMap Nominatim) instead of a
  fixed list of landmarks, and include walking time to the stop in trip plans.
- **Security**: check Vapi's secret header on `/api/vapi` so only my agent can call it
  (the secret would live in `.env` and in Vercel's environment variables).
- **Holidays and service alerts**: special schedules and "detour" messages.
- **Smoother animation**: move markers continuously between updates.
- **Accessibility**: a text-only list of buses for screen readers.

## Related projects

| Repo | What it is |
|---|---|
| [transit-agent](https://github.com/Mark-Naumann/transit-agent) | Jordan, the Vapi voice agent that uses this API |
| [painting-agent](https://github.com/Mark-Naumann/painting-agent) | Sam, my other voice agent (painting company receptionist) |
| [call-analyzer](https://github.com/Mark-Naumann/call-analyzer) | AI quality review of every call, with real findings |
| [call-analytics](https://github.com/Mark-Naumann/call-analytics) | Python + SQLite monitoring for both agents |
