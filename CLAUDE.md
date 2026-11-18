# Instructions for AI assistants working on this repo

- The owner is new to coding. Explain each step in plain, simple words before doing it.
- Keep code simple and well commented so the owner can explain it in an interview.
- Keep any API keys or secrets in a `.env` file, never in the code.
- Never commit `.env` (it is listed in `.gitignore`).
- Run `npm test` after changing anything in `lib/` or `data/`.
- Route data lives only in `data/routes.json`; "where are the buses" logic lives in the
  DATA SOURCE section of `lib/simulation.js` (`getVehiclePositions()` / `getArrivals()`).
- This is a fictional agency (Juniper Valley Transit). Do not add real agency names,
  logos, or branding, and keep the "demo, not affiliated with the City of Santa Fe" note.
