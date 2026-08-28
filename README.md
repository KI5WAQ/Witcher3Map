# Witcher 3 Interactive Map (Local)

A local, self-hosted reproduction of the Witcher 3 interactive map (the one
embedded on IGN's wiki, which is itself powered by [MapGenie](https://mapgenie.io)'s
public data). Runs entirely as a static site on your machine — no backend,
no account, no hosting.

- Map tiles and the marker sprite sheet are the same public, unauthenticated
  assets the original site uses (streamed live from MapGenie's CDN — see
  "How it works" below).
- Everything else — the app shell, marker/category data, and all your
  completion tracking, checklists, and notes — lives locally in this repo
  and your browser's `localStorage`.

## Running it

You need any static file server (browsers block `fetch()` of local JSON
under `file://`). Python (already used by the scraper) works fine:

```bash
python -m http.server 8123
```

Then open http://127.0.0.1:8123/ in a browser.

## What's included out of the box

- **White Orchard** — all 233 markers across every category (locations,
  services, quests, items, etc.)
- Category legend with per-category and "toggle all" visibility filtering
- Marker search
- **Entrance/exit jumps** — cave and dungeon entrance/exit markers (and a
  few other narratively-linked markers) show a "Go to linked location"
  button in their popup that pans straight to the other end, even if it's
  on a different scraped region
- **Fullscreen mode** — the ⛶ button hides the sidebar and requests native
  browser fullscreen so the map fills the screen; Esc exits
- **Grandmaster Gear tab** — a component checklist for each Blood and Wine
  Grandmaster armor set (Manticore, Griffin, Wolf, Cat, Bear), transcribed
  from a user-supplied crafting guide, plus reference images for the
  Enriched Dimeritium and Infused Slyzard Hide crafting chains
  (`data/grandmaster-armor.json`)
- **Builds tab** — character build guides (mutation, skill trees, gear,
  runewords/glyphs, potions/decoctions) with real in-game icons for every
  item, sourced from the Witcher wiki's image API (`data/builds.json`,
  icons in `assets/images/builds/`). Currently has Euphoria Alchemy and
  Metamorphosis Combat-Alchemy — add more by following the same schema
- **Checklist** panel — every marker grouped by category with a checkbox;
  checking one marks it done both here and on the map (dimmed + ✓ badge)
- **Notes** — click "+ Add note", then click anywhere on the map to drop a
  pin and write your own free-text note
- All completion/notes state persists in `localStorage`, per browser

## Adding more regions

The scraper (`scripts/scrape_map.py`) pulls the same dataset from any IGN
Witcher 3 map page and drops a clean JSON file into `data/maps/`. To add
another region:

```bash
python scripts/scrape_map.py https://www.ign.com/maps/the-witcher-3-wild-hunt/velen-novigrad
python scripts/scrape_map.py https://www.ign.com/maps/the-witcher-3-wild-hunt/skellige
python scripts/scrape_map.py https://www.ign.com/maps/the-witcher-3-wild-hunt/toussaint
python scripts/scrape_map.py the-witcher-3-wild-hunt/kaer-morhen   # short form also works
```

Each run adds an entry to `data/maps/index.json`, so the new region shows
up in the map switcher at the top of the page immediately — no code changes
needed.

## How it works

IGN's map page is a Next.js app that server-renders the full map dataset
(tile URL template, zoom range, every marker's position/category, the
category tree, and the marker sprite sheet URL) into a `__NEXT_DATA__` JSON
blob in the page source — the same data MapGenie's own site uses. The
scraper fetches that page and extracts it, then also calls MapGenie's own
public data API (`mapgenie.io/api/v1/maps/<id>/data`) directly, since it
carries a couple of fields IGN's embed drops: each marker's flavor-text
description, and — for entrance/exit-style markers — a link to the
connected location on the other end (which is what powers the "Go to linked
location" jump). Nothing here talks to any private or authenticated API.

Map tile images are **not** downloaded/vendored — White Orchard alone fills
its entire tile pyramid (65k+ tiles at max zoom), so tiles are streamed live
from `tiles.mapgenie.io` on demand, exactly like the original site, and
cached by your browser as you pan/zoom. Only the small marker sprite sheet
(~120KB, shared across every region) is vendored locally in
`assets/sprites/`. This means map imagery requires an internet connection;
everything else (UI, data, your tracked progress) is fully local.

## Project layout

```
index.html              App shell
css/style.css            Styling
js/app.js                Map rendering, legend/checklist/notes logic
js/storage.js             localStorage persistence layer
vendor/leaflet/          Vendored Leaflet library (offline)
assets/sprites/          Vendored marker icon sprite sheet
data/maps/index.json     List of scraped regions (for the map switcher)
data/maps/<slug>.json    Per-region map + marker + category data
scripts/scrape_map.py    Re-run to add/update a region
```

## Notes on scope

This reproduces the map/marker/tracking experience for personal, local,
non-hosted use. Marker categories, positions, and map tile imagery
ultimately derive from Witcher 3 game assets via MapGenie/IGN — this isn't
intended for redistribution or public hosting.
