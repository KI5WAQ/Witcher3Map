#!/usr/bin/env python3
"""
Scrape a Witcher 3 interactive map from an IGN /maps/... page and produce a
clean local JSON file for the local map viewer in data/maps/<slug>.json.

IGN's map pages embed the full map/marker/category dataset (originally sourced
from MapGenie) as a Next.js __NEXT_DATA__ JSON blob server-side. This script
fetches that page for map config (tiles, zoom, categories, icons), then
*also* calls MapGenie's own public data API directly, which carries a few
fields IGN's embed drops: each location's `region_id` and free-text
`description` -- and for entrance/exit-style markers, that description
contains a `[Local Map](...locationIds=NNN)` / `[World Map](...)` link
pointing at the connected location on the other end (which may be on a
different map entirely, e.g. a dungeon leading to its own map). We resolve
those into a `link` field on the relevant markers so the viewer can jump
straight there.

The two sources are correlated by (category, rounded lat/lng), since both
ultimately describe the same underlying MapGenie location records.

Usage:
    python scripts/scrape_map.py https://www.ign.com/maps/the-witcher-3-wild-hunt/white-orchard
    python scripts/scrape_map.py the-witcher-3-wild-hunt/skellige
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data" / "maps"
SPRITE_DIR = ROOT / "assets" / "sprites"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S
)

# Matches the "jump to the other end" link MapGenie embeds in a location's
# description, e.g. [Local Map](https://mapgenie.io/witcher-3/maps/SLUG?locationIds=123#L)
LINK_RE = re.compile(
    r"\[(?:Local Map|World Map)\]\(https://mapgenie\.io/witcher-3/maps/"
    r"([a-z0-9-]+)\?locationIds=(\d+)(?:#L)?\)"
)

# Any other markdown link, e.g. a flavor-text mention like [Abandoned Village](url).
MARKDOWN_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")


def fetch(url: str, accept_json: bool = False) -> bytes:
    headers = {"User-Agent": USER_AGENT}
    if accept_json:
        headers["Accept"] = "application/json"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def normalize_url(arg: str) -> str:
    if arg.startswith("http"):
        return arg
    return f"https://www.ign.com/maps/{arg.strip('/')}"


def extract_next_data(html: str) -> dict:
    m = NEXT_DATA_RE.search(html)
    if not m:
        raise SystemExit("Could not find __NEXT_DATA__ on the page. IGN may have changed its markup.")
    return json.loads(m.group(1))


def build_type_tree(map_obj: dict) -> list[dict]:
    """Flatten map.types into a clean list, keeping parent/child relationships
    and pulling icon sprite coordinates from map.overlays (same typeSlug)."""
    icon_by_slug = {}
    for ov in map_obj.get("overlays", []):
        icon = ov.get("markerIcon")
        if icon:
            icon_by_slug[ov["typeSlug"]] = {
                "offsetX": icon.get("offsetX", 0),
                "offsetY": icon.get("offsetY", 0),
                "width": icon.get("width"),
                "height": icon.get("height"),
                "anchorX": icon.get("anchorX"),
                "anchorY": icon.get("anchorY"),
            }

    types = []
    for t in map_obj.get("types", []):
        types.append({
            "typeSlug": t["typeSlug"],
            "name": t["typeName"],
            "parentTypeSlug": t.get("parentTypeSlug"),
            "markerCount": t.get("markerCount"),
            "icon": icon_by_slug.get(t["typeSlug"]),
        })
    return types


def fetch_mapgenie_data(map_id: int) -> dict:
    url = f"https://mapgenie.io/api/v1/maps/{map_id}/data"
    return json.loads(fetch(url, accept_json=True))


def fetch_real_tile_zoom_range(mg_slug: str) -> tuple[int, int] | None:
    """IGN's minZoom/maxZoom describe the map's overall allowed zoom range,
    but the tile *images* often stop well before maxZoom (deeper levels are
    just upscaled by the viewer on MapGenie's own site, not separate tiles).
    MapGenie's own map page embeds the real tile pyramid's zoom range as
    mapConfig.tile_sets[0].{min_zoom,tiles_max_zoom} in a `window.mapData =`
    JS assignment. Returns None if it can't be found/parsed, so callers can
    fall back to IGN's values."""
    try:
        html = fetch(f"https://mapgenie.io/witcher-3/maps/{mg_slug}").decode("utf-8")
        marker = "window.mapData = "
        start = html.index(marker) + len(marker)
        data, _ = json.JSONDecoder().raw_decode(html, start)
        tileset = data["mapConfig"]["tile_sets"][0]
        return tileset["min_zoom"], tileset["tiles_max_zoom"]
    except Exception:
        return None


def index_mapgenie_locations(locations: list[dict]) -> dict:
    """Key locations by (category_id, rounded lat, rounded lng) so they can be
    matched against IGN's marker list, which describes the same points.
    Keeps every candidate per key (not just the last one) so nearby same-
    category markers that round to the same bucket can still be disambiguated
    by nearest distance in build_markers()."""
    index: dict[tuple, list[dict]] = {}
    for loc in locations:
        key = (loc["category_id"], round(float(loc["latitude"]), 3), round(float(loc["longitude"]), 3))
        index.setdefault(key, []).append(loc)
    return index


def closest_candidate(candidates: list[dict], lat: float, lng: float) -> dict:
    return min(
        candidates,
        key=lambda loc: (float(loc["latitude"]) - lat) ** 2 + (float(loc["longitude"]) - lng) ** 2,
    )


def parse_link(description: str | None, slug_to_id: dict) -> dict | None:
    """Resolve a location's nav link to a MapGenie numeric map id, not a slug
    -- MapGenie's own canonical slugs (e.g. "skellige") sometimes differ from
    IGN's URL slugs (e.g. "skellige-isles"), and mapId is what's unambiguous
    across both this map's file and every other scraped map's file."""
    if not description:
        return None
    m = LINK_RE.search(description)
    if not m:
        return None
    mg_slug, mapgenie_location_id = m.group(1), int(m.group(2))
    return {
        "mapId": slug_to_id.get(mg_slug),
        "mgSlug": mg_slug,  # kept only as a human-readable hint if mapId can't be resolved locally
        "mapgenieId": mapgenie_location_id,
    }


def clean_description(description: str | None) -> str | None:
    """Strip the nav link (shown separately as a button), collapse any other
    markdown links down to their label text, and drop bold markers -- leaving
    just plain flavor/hint text, if any."""
    if not description:
        return None
    text = LINK_RE.sub("", description)
    text = MARKDOWN_LINK_RE.sub(r"\1", text)
    text = text.replace("**", "")
    text = re.sub(r"\n{2,}", " ", text)
    text = re.sub(r"\s+", " ", text)
    text = text.strip()
    return text or None


def build_markers(map_obj: dict, mg_index: dict, slug_to_id: dict) -> list[dict]:
    markers = []
    for ov in map_obj.get("overlays", []):
        for m in ov.get("markers", []) or []:
            key = (int(m["typeSlug"]), round(m["lat"], 3), round(m["lng"], 3))
            candidates = mg_index.get(key)
            mg_loc = closest_candidate(candidates, m["lat"], m["lng"]) if candidates else None

            marker = {
                "id": m["id"],
                "name": m["markerName"],
                "slug": m["markerSlug"],
                "typeSlug": m["typeSlug"],
                "iconSlug": m.get("iconSlug"),
                "lat": m["lat"],
                "lng": m["lng"],
                "wikiPage": m.get("wikiPage"),
                "checklistTaskId": m.get("checklistTaskId"),
            }

            if mg_loc:
                marker["mapgenieId"] = mg_loc["id"]
                marker["regionId"] = mg_loc.get("region_id")
                marker["description"] = clean_description(mg_loc.get("description"))
                marker["link"] = parse_link(mg_loc.get("description"), slug_to_id)

            markers.append(marker)
    return markers


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)

    url = normalize_url(sys.argv[1])
    print(f"Fetching {url} ...")
    html = fetch(url).decode("utf-8")
    next_data = extract_next_data(html)

    page = next_data["props"]["pageProps"]["page"]
    map_obj = page["map"]

    tileset = map_obj["tilesets"][0]
    map_id = map_obj["mapId"]

    print(f"Fetching MapGenie location data for map id {map_id} ...")
    mg_data = fetch_mapgenie_data(map_id)
    mg_index = index_mapgenie_locations(mg_data.get("locations", []))
    slug_to_id = {m["slug"]: m["id"] for m in mg_data.get("maps", [])}

    markers = build_markers(map_obj, mg_index, slug_to_id)
    matched = sum(1 for m in markers if "mapgenieId" in m)
    linked = sum(1 for m in markers if m.get("link"))
    print(f"Matched {matched}/{len(markers)} markers against MapGenie location data ({linked} carry a linked-location jump)")

    # IGN's minZoom/maxZoom describe the allowed UI zoom range, which can
    # reach deeper than the actual tile pyramid (MapGenie just doesn't
    # generate/serve tiles past a certain depth). Prefer the real tile
    # bounds so the viewer can't zoom into a blank void.
    min_zoom, max_zoom = map_obj["minZoom"], map_obj["maxZoom"]
    own_slug = next((s for s, i in slug_to_id.items() if i == map_id), None)
    if own_slug:
        real_range = fetch_real_tile_zoom_range(own_slug)
        if real_range:
            min_zoom, max_zoom = real_range
            print(f"Using MapGenie's real tile zoom range: {min_zoom}-{max_zoom} (IGN reported {map_obj['minZoom']}-{map_obj['maxZoom']})")

    out = {
        "objectSlug": map_obj["objectSlug"],
        "objectName": map_obj["objectName"],
        "mapSlug": map_obj["mapSlug"],
        "mapName": map_obj["mapName"],
        "mapId": map_id,
        "sourceUrl": url,
        "tileUrlTemplate": tileset,
        "minZoom": min_zoom,
        "maxZoom": max_zoom,
        "initialLat": map_obj["initialLat"],
        "initialLng": map_obj["initialLng"],
        "initialZoom": min(map_obj["initialZoom"], max_zoom),
        "markerSpriteUrl": map_obj["markerSpriteUrl"],
        "types": build_type_tree(map_obj),
        "markers": markers,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / f"{out['mapSlug']}.json"
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {out_path} ({len(out['markers'])} markers, {len(out['types'])} types)")

    # Vendor the marker sprite sheet locally once (shared across all maps for this game).
    SPRITE_DIR.mkdir(parents=True, exist_ok=True)
    sprite_name = out["markerSpriteUrl"].split("/")[-1].split("?")[0]
    sprite_path = SPRITE_DIR / sprite_name
    if not sprite_path.exists():
        print(f"Downloading marker sprite sheet {out['markerSpriteUrl']} ...")
        sprite_path.write_bytes(fetch(out["markerSpriteUrl"]))
        print(f"Wrote {sprite_path}")

    # Maintain an index of scraped maps for the map switcher in the UI.
    index_path = DATA_DIR / "index.json"
    index = []
    if index_path.exists():
        index = json.loads(index_path.read_text(encoding="utf-8"))
    index = [e for e in index if e["mapSlug"] != out["mapSlug"]]
    index.append({
        "mapSlug": out["mapSlug"],
        "mapName": out["mapName"],
        "objectName": out["objectName"],
        "mapId": out["mapId"],
    })
    index.sort(key=lambda e: e["mapName"])
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Updated {index_path}")


if __name__ == "__main__":
    main()
