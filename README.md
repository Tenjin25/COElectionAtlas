# CO Election Atlas

Interactive Colorado election atlas (2000-2024) with county, congressional, state house, and state senate views.

## Features

- Contest explorer for statewide and district-level elections
- County and district map views with margins, winners, and trend context
- District contest slices in `data/district_contests`
- Crosswalk-based district aggregation workflow scripts in `scripts/`

## Local Run

1. Start a local server from the project root:
   - `python -m http.server 8000`
2. Open:
   - `http://localhost:8000/index.html`

Note: Use `http://localhost` (not `file://`) so JSON/CSV fetches work correctly.

## Key Paths

- `index.html` - app UI and map logic
- `data/contests/` - county-level contest slices + manifest
- `data/district_contests/` - district-level contest slices + manifest
- `data/crosswalks_cd118_from_2008/` - district crosswalk inputs
- `scripts/` - build and aggregation scripts

## Data Build Scripts

- `scripts/build_co_elections_aggregated.py`
- `scripts/build_crosswalks_co.py`
- `scripts/build_district_statewide_from_crosswalks.mjs`
- `scripts/build_precinct_id_bridge_report.mjs`
- `scripts/validate_contest_manifests.mjs`

## Quick Data Check

- Run: `node scripts/validate_contest_manifests.mjs`
- Purpose: verifies every file listed in `data/contests/manifest.json` and `data/district_contests/manifest.json` actually exists.

## License

Project data/code usage follows the source dataset licensing and attribution requirements.
