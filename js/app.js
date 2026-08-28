// Witcher 3 local interactive map viewer.
// Loads a scraped map JSON (data/maps/<slug>.json) and renders it with Leaflet,
// using the same tile CDN and marker sprite the original map uses, but with
// completion tracking / notes / checklist kept entirely in this browser.

const SPRITE_URL = "assets/sprites/markers@2x.png";
// The sheet is a "@2x" retina asset (real pixel cells are 2x the size), but
// the offsetX/offsetY/width/height values scraped from IGN are all in
// logical 1x units. background-size must be set to the sheet's logical
// (halved) dimensions so those offsets land on the right cell.
const SPRITE_PIXEL_RATIO = 2;

// MapGenie's tiles are opaque JPGs (no alpha channel), and areas with no map
// content are baked in as solid black rather than left transparent. That
// leaves flat black squares sitting over the parchment page background
// wherever a tile is mostly/entirely "empty". This tile layer draws each
// tile into a canvas and keys near-black pixels out to transparent so the
// background shows through instead.
const BLACK_KEY_THRESHOLD = 40;

const ChromaKeyedTileLayer = L.GridLayer.extend({
  initialize: function (urlTemplate, options) {
    this._urlTemplate = urlTemplate;
    L.GridLayer.prototype.initialize.call(this, options);
  },

  createTile: function (coords, done) {
    const size = this.getTileSize();
    const tile = document.createElement("canvas");
    tile.width = size.x;
    tile.height = size.y;
    const ctx = tile.getContext("2d");

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      ctx.drawImage(img, 0, 0, size.x, size.y);
      try {
        const imageData = ctx.getImageData(0, 0, size.x, size.y);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
          if (
            data[i] < BLACK_KEY_THRESHOLD &&
            data[i + 1] < BLACK_KEY_THRESHOLD &&
            data[i + 2] < BLACK_KEY_THRESHOLD
          ) {
            data[i + 3] = 0;
          }
        }
        ctx.putImageData(imageData, 0, 0);
      } catch (e) {
        // Canvas read blocked (e.g. no CORS) - fall back to showing the tile as-is.
      }
      done(null, tile);
    };
    img.onerror = () => {
      // Tile doesn't exist outside the map's real bounds - leave it fully transparent.
      done(null, tile);
    };
    img.src = this._urlTemplate
      .replace("{z}", coords.z)
      .replace("{x}", coords.x)
      .replace("{y}", coords.y);

    return tile;
  },
});

const state = {
  map: null,
  tileLayer: null,
  mapData: null,
  markersById: new Map(), // id -> { leafletMarker, data }
  typesById: new Map(),
  rootTypes: [],
  hiddenTypes: new Set(),
  searchTerm: "",
  addingNote: false,
  noteMarkers: new Map(), // note id -> leaflet marker
  spriteSize: null, // { width, height } in logical CSS px, set once sprite loads
};
window.state = state; // exposed for console debugging

const els = {
  mapSelect: document.getElementById("map-select"),
  searchBox: document.getElementById("search-box"),
  legendTree: document.getElementById("legend-tree"),
  legendProgress: document.getElementById("legend-progress"),
  legendToggleAll: document.getElementById("legend-toggle-all"),
  checklistTree: document.getElementById("checklist-tree"),
  checklistProgress: document.getElementById("checklist-progress"),
  checklistReset: document.getElementById("checklist-reset"),
  notesList: document.getElementById("notes-list"),
  notesAddBtn: document.getElementById("notes-add-btn"),
  notesHint: document.getElementById("notes-hint"),
  tabBtns: document.querySelectorAll(".tab-btn"),
  panels: document.querySelectorAll(".panel"),
  fullscreenBtn: document.getElementById("fullscreen-btn"),
  grandmasterProgress: document.getElementById("grandmaster-progress"),
  grandmasterReset: document.getElementById("grandmaster-reset"),
  grandmasterSets: document.getElementById("grandmaster-sets"),
  grandmasterReferenceImages: document.getElementById("grandmaster-reference-images"),
  grandmasterUnlockNote: document.getElementById("grandmaster-unlock-note"),
  materialTooltip: document.getElementById("material-tooltip"),
  imageModal: document.getElementById("image-modal"),
  imageModalImg: document.getElementById("image-modal-img"),
  imageModalClose: document.getElementById("image-modal-close"),
  buildSelect: document.getElementById("build-select"),
  buildContent: document.getElementById("build-content"),
};

init();

function loadSpriteSize() {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      state.spriteSize = {
        width: img.naturalWidth / SPRITE_PIXEL_RATIO,
        height: img.naturalHeight / SPRITE_PIXEL_RATIO,
      };
      resolve();
    };
    img.src = SPRITE_URL;
  });
}

async function init() {
  wireTabs();
  wireSearch();
  wireNotesButton();
  wireFullscreenToggle();
  wireImageModal();

  await loadSpriteSize();

  const index = await fetchJson("data/maps/index.json");
  els.mapSelect.innerHTML = index
    .map((m) => `<option value="${m.mapSlug}">${m.mapName}</option>`)
    .join("");
  els.mapSelect.addEventListener("change", () => loadMap(els.mapSelect.value));

  const initialSlug = index[0].mapSlug;
  els.mapSelect.value = initialSlug;
  await loadMap(initialSlug);

  loadGrandmasterArmor();
  loadBuilds();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

// ---------- Map loading ----------

async function loadMap(mapSlug, { focusMapgenieId } = {}) {
  const mapData = await fetchJson(`data/maps/${mapSlug}.json`);
  state.mapData = mapData;
  state.hiddenTypes = Storage.getHiddenTypes(mapSlug);
  state.searchTerm = "";
  els.searchBox.value = "";

  indexTypes(mapData);

  if (!state.map) {
    state.map = L.map("map", {
      crs: L.CRS.EPSG3857,
      zoomControl: true,
    });
    state.map.on("click", onMapClick);
  }

  if (state.tileLayer) state.map.removeLayer(state.tileLayer);
  state.tileLayer = new ChromaKeyedTileLayer(mapData.tileUrlTemplate, {
    minZoom: mapData.minZoom,
    maxZoom: mapData.maxZoom,
    tileSize: 256,
    attribution: "Map tiles &copy; MapGenie, via IGN",
  }).addTo(state.map);

  state.map.setView([mapData.initialLat, mapData.initialLng], mapData.initialZoom);

  clearMarkers();
  renderMarkers(mapData);
  renderNotes(mapData.mapSlug);

  renderLegend();
  renderChecklist();
  refreshVisibility();
  updateProgressBadges();

  if (focusMapgenieId != null) focusByMapgenieId(focusMapgenieId);
}

function indexTypes(mapData) {
  state.typesById = new Map(mapData.types.map((t) => [t.typeSlug, { ...t, children: [] }]));
  state.rootTypes = [];
  for (const t of state.typesById.values()) {
    if (t.parentTypeSlug && state.typesById.has(t.parentTypeSlug)) {
      state.typesById.get(t.parentTypeSlug).children.push(t);
    } else if (!t.parentTypeSlug) {
      state.rootTypes.push(t);
    }
  }
}

function clearMarkers() {
  for (const { leafletMarker } of state.markersById.values()) {
    state.map.removeLayer(leafletMarker);
  }
  state.markersById.clear();
  for (const m of state.noteMarkers.values()) {
    state.map.removeLayer(m);
  }
  state.noteMarkers.clear();
}

// ---------- Markers ----------

function iconForType(typeSlug) {
  const type = state.typesById.get(typeSlug);
  return type && type.icon;
}

function buildDivIcon(icon) {
  const w = icon.width;
  const h = icon.height;
  const html = `<div class="marker-icon" style="
    width:${w}px;height:${h}px;
    background-image:url('${SPRITE_URL}');
    background-size:${state.spriteSize.width}px ${state.spriteSize.height}px;
    background-position:-${icon.offsetX}px -${icon.offsetY}px;
  "></div>`;
  return L.divIcon({
    html,
    className: "marker-icon-wrap",
    iconSize: [w, h],
    iconAnchor: [icon.anchorX, icon.anchorY],
    popupAnchor: [0, -h],
  });
}

function renderMarkers(mapData) {
  const objectSlug = mapData.objectSlug;
  const completed = Storage.getCompleted(objectSlug);

  for (const m of mapData.markers) {
    const icon = iconForType(m.typeSlug);
    if (!icon) continue; // skip malformed entries with no icon data

    const leafletMarker = L.marker([m.lat, m.lng], {
      icon: buildDivIcon(icon),
    });

    leafletMarker.bindPopup(() => buildPopupContent(m));
    leafletMarker.on("popupopen", (e) => wirePopup(e, m));

    state.markersById.set(m.id, { leafletMarker, data: m });
  }
}

function typeName(typeSlug) {
  const t = state.typesById.get(typeSlug);
  return t ? t.name : typeSlug;
}

function buildPopupContent(m) {
  const objectSlug = state.mapData.objectSlug;
  const isDone = Storage.getCompleted(objectSlug).has(m.id);
  const wikiLink = m.wikiPage
    ? `<a href="${state.mapData.sourceUrl}" target="_blank" rel="noopener">View on IGN wiki &rarr;</a>`
    : "";
  const description = m.description
    ? `<div class="popup-description">${escapeHtml(m.description)}</div>`
    : "";
  const linkBtn = m.link
    ? `<button class="popup-link-btn">Go to linked location &rarr;</button>`
    : "";
  return `
    <div class="popup">
      <div class="popup-title">${escapeHtml(m.name)}</div>
      <div class="popup-type">${escapeHtml(typeName(m.typeSlug))}</div>
      <label class="popup-complete">
        <input type="checkbox" class="popup-complete-checkbox" ${isDone ? "checked" : ""}>
        Mark completed
      </label>
      ${description}
      ${linkBtn}
      ${wikiLink}
    </div>
  `;
}

function wirePopup(e, m) {
  const el = e.popup.getElement();
  const cb = el.querySelector(".popup-complete-checkbox");
  cb.addEventListener("change", () => {
    const nowDone = Storage.toggleCompleted(state.mapData.objectSlug, m.id);
    markMarkerCompleted(m.id, nowDone, {});
    renderChecklist();
    updateProgressBadges();
  });

  const linkBtn = el.querySelector(".popup-link-btn");
  if (linkBtn) {
    linkBtn.addEventListener("click", () => goToLinkedLocation(m.link));
  }
}

// ---------- Entrance/exit (and other narratively-linked) marker jumps ----------

async function goToLinkedLocation(link) {
  if (link.mapId === state.mapData.mapId) {
    focusByMapgenieId(link.mapgenieId);
    return;
  }

  // MapGenie's own canonical map slugs (link.mgSlug) can differ from the IGN
  // URL slugs our files are keyed by (e.g. "skellige" vs "skellige-isles"),
  // so cross-map lookups go by the numeric mapId recorded in the index.
  const index = await fetchJson("data/maps/index.json");
  const target = index.find((e) => e.mapId === link.mapId);
  if (!target) {
    alert(
      `This leads to a map that hasn't been scraped yet ("${link.mgSlug}"). Run:\n\n` +
        `python scripts/scrape_map.py https://www.ign.com/maps/${state.mapData.objectSlug}/${link.mgSlug}`
    );
    return;
  }

  els.mapSelect.value = target.mapSlug;
  await loadMap(target.mapSlug, { focusMapgenieId: link.mapgenieId });
}

function focusByMapgenieId(mapgenieId) {
  const entry = Array.from(state.markersById.values()).find(
    (e) => e.data.mapgenieId === mapgenieId
  );
  if (!entry) return;

  // Make sure it's actually visible: clear search and un-hide its category.
  if (state.searchTerm) {
    state.searchTerm = "";
    els.searchBox.value = "";
  }
  if (state.hiddenTypes.has(entry.data.typeSlug)) {
    state.hiddenTypes.delete(entry.data.typeSlug);
    Storage.setHiddenTypes(state.mapData.mapSlug, state.hiddenTypes);
    renderLegend();
  }
  refreshVisibility();

  state.map.setView(entry.leafletMarker.getLatLng(), Math.max(state.map.getZoom(), 14));
  entry.leafletMarker.openPopup();
}

function markMarkerCompleted(markerId, done) {
  const entry = state.markersById.get(markerId);
  if (!entry) return;
  const el = entry.leafletMarker.getElement();
  if (el) el.classList.toggle("completed", done);
}

// ---------- Visibility (legend filters + search) ----------

function refreshVisibility() {
  const term = state.searchTerm.trim().toLowerCase();
  const completed = Storage.getCompleted(state.mapData.objectSlug);
  for (const [id, { leafletMarker, data }] of state.markersById.entries()) {
    const categoryHidden = state.hiddenTypes.has(data.typeSlug);
    const matchesSearch = !term || data.name.toLowerCase().includes(term);
    const visible = !categoryHidden && matchesSearch;
    setMarkerVisible(leafletMarker, visible, id, completed);
  }
}

function setMarkerVisible(marker, visible, id, completed) {
  const onMap = state.map.hasLayer(marker);
  if (visible && !onMap) {
    marker.addTo(state.map);
    markMarkerCompleted(id, completed.has(id), {});
  }
  if (!visible && onMap) state.map.removeLayer(marker);
}

// ---------- Legend panel ----------

function renderLegend() {
  els.legendTree.innerHTML = state.rootTypes
    .filter((root) => root.children.length)
    .map(renderLegendRoot)
    .join("");

  els.legendTree.querySelectorAll("[data-legend-type]").forEach((cb) => {
    cb.addEventListener("change", onLegendLeafToggle);
  });
  els.legendTree.querySelectorAll("[data-legend-root]").forEach((cb) => {
    cb.addEventListener("change", onLegendRootToggle);
  });

  els.legendToggleAll.addEventListener("click", onLegendToggleAll);
}

function renderLegendRoot(root) {
  const childRows = root.children.map(renderLegendLeaf).join("");
  const allHidden = root.children.every((c) => state.hiddenTypes.has(c.typeSlug));
  const noneHidden = root.children.every((c) => !state.hiddenTypes.has(c.typeSlug));
  return `
    <div class="legend-group">
      <label class="legend-root">
        <input type="checkbox" data-legend-root="${root.typeSlug}" ${noneHidden ? "checked" : ""} ${!noneHidden && !allHidden ? "data-indeterminate" : ""}>
        ${escapeHtml(root.name)}
      </label>
      <div class="legend-children">${childRows}</div>
    </div>
  `;
}

function renderLegendLeaf(leaf) {
  const checked = !state.hiddenTypes.has(leaf.typeSlug);
  const icon = leaf.icon;
  const swatch = icon
    ? `<span class="legend-swatch" style="
        width:${icon.width}px;height:${icon.height}px;
        background-image:url('${SPRITE_URL}');
        background-size:${state.spriteSize.width}px ${state.spriteSize.height}px;
        background-position:-${icon.offsetX}px -${icon.offsetY}px;
      "></span>`
    : "";
  return `
    <label class="legend-leaf">
      <input type="checkbox" data-legend-type="${leaf.typeSlug}" ${checked ? "checked" : ""}>
      ${swatch}
      <span class="legend-leaf-name">${escapeHtml(leaf.name)}</span>
      <span class="legend-leaf-count">${leaf.markerCount ?? ""}</span>
    </label>
  `;
}

function onLegendLeafToggle(e) {
  const typeSlug = e.target.getAttribute("data-legend-type");
  if (e.target.checked) state.hiddenTypes.delete(typeSlug);
  else state.hiddenTypes.add(typeSlug);
  Storage.setHiddenTypes(state.mapData.mapSlug, state.hiddenTypes);
  refreshVisibility();
  renderLegend();
}

function onLegendRootToggle(e) {
  const rootSlug = e.target.getAttribute("data-legend-root");
  const root = state.typesById.get(rootSlug);
  const show = e.target.checked;
  for (const child of root.children) {
    if (show) state.hiddenTypes.delete(child.typeSlug);
    else state.hiddenTypes.add(child.typeSlug);
  }
  Storage.setHiddenTypes(state.mapData.mapSlug, state.hiddenTypes);
  refreshVisibility();
  renderLegend();
}

function onLegendToggleAll() {
  const anyHidden = state.hiddenTypes.size > 0;
  if (anyHidden) {
    state.hiddenTypes.clear();
  } else {
    for (const t of state.typesById.values()) {
      if (!t.children.length) state.hiddenTypes.add(t.typeSlug);
    }
  }
  Storage.setHiddenTypes(state.mapData.mapSlug, state.hiddenTypes);
  refreshVisibility();
  renderLegend();
}

// ---------- Checklist panel ----------

function renderChecklist() {
  const objectSlug = state.mapData.objectSlug;
  const completed = Storage.getCompleted(objectSlug);

  els.checklistTree.innerHTML = state.rootTypes
    .filter((root) => root.children.length)
    .map((root) => renderChecklistRoot(root, completed))
    .join("");

  els.checklistTree.querySelectorAll("[data-checklist-marker]").forEach((cb) => {
    cb.addEventListener("change", onChecklistToggle);
  });
  els.checklistTree.querySelectorAll("[data-checklist-focus]").forEach((el) => {
    el.addEventListener("click", () => focusMarker(el.getAttribute("data-checklist-focus")));
  });

  els.checklistReset.onclick = () => {
    if (!confirm("Reset completion state for all markers on this map's game?")) return;
    Storage.resetCompleted(objectSlug);
    for (const id of state.markersById.keys()) markMarkerCompleted(id, false, {});
    renderChecklist();
    updateProgressBadges();
  };
}

function renderChecklistRoot(root, completed) {
  const leafRows = root.children.map((leaf) => renderChecklistLeaf(leaf, completed)).join("");
  return `<div class="checklist-group"><div class="checklist-root">${escapeHtml(root.name)}</div>${leafRows}</div>`;
}

function renderChecklistLeaf(leaf, completed) {
  const markers = state.mapData.markers.filter((m) => m.typeSlug === leaf.typeSlug);
  if (!markers.length) return "";
  const done = markers.filter((m) => completed.has(m.id)).length;
  const items = markers
    .map(
      (m) => `
      <label class="checklist-item">
        <input type="checkbox" data-checklist-marker="${m.id}" ${completed.has(m.id) ? "checked" : ""}>
        <span data-checklist-focus="${m.id}">${escapeHtml(m.name)}</span>
      </label>`
    )
    .join("");
  return `
    <details class="checklist-leaf">
      <summary>${escapeHtml(leaf.name)} <span class="checklist-count">${done}/${markers.length}</span></summary>
      ${items}
    </details>
  `;
}

function onChecklistToggle(e) {
  const markerId = e.target.getAttribute("data-checklist-marker");
  const nowDone = Storage.toggleCompleted(state.mapData.objectSlug, markerId);
  markMarkerCompleted(markerId, nowDone, {});
  renderChecklist();
  updateProgressBadges();
}

function focusMarker(markerId) {
  const entry = state.markersById.get(markerId);
  if (!entry) return;
  state.map.setView(entry.leafletMarker.getLatLng(), Math.max(state.map.getZoom(), 13));
  entry.leafletMarker.openPopup();
}

function updateProgressBadges() {
  const objectSlug = state.mapData.objectSlug;
  const completed = Storage.getCompleted(objectSlug);
  const total = state.mapData.markers.length;
  const done = state.mapData.markers.filter((m) => completed.has(m.id)).length;
  const text = `${done} / ${total} completed`;
  els.legendProgress.textContent = text;
  els.checklistProgress.textContent = text;
}

// ---------- Notes ----------

function wireNotesButton() {
  els.notesAddBtn.addEventListener("click", () => {
    state.addingNote = !state.addingNote;
    els.notesAddBtn.classList.toggle("active", state.addingNote);
    els.notesHint.classList.toggle("hint-active", state.addingNote);
    document.getElementById("map").style.cursor = state.addingNote ? "crosshair" : "";
  });
}

function onMapClick(e) {
  if (!state.addingNote) return;
  state.addingNote = false;
  els.notesAddBtn.classList.remove("active");
  document.getElementById("map").style.cursor = "";
  openNoteEditor(e.latlng, null);
}

function noteIcon() {
  return L.divIcon({
    html: `<div class="note-icon">&#128204;</div>`,
    className: "note-icon-wrap",
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -28],
  });
}

function renderNotes(mapSlug) {
  const notes = Storage.getNotes(mapSlug);
  for (const note of notes) {
    addNoteMarker(note);
  }
  renderNotesList();
}

function addNoteMarker(note) {
  const marker = L.marker([note.lat, note.lng], { icon: noteIcon() }).addTo(state.map);
  marker.bindPopup(() => buildNotePopup(note));
  marker.on("popupopen", (e) => wireNotePopup(e, note));
  state.noteMarkers.set(note.id, marker);
}

function buildNotePopup(note) {
  return `
    <div class="popup note-popup">
      <textarea class="note-textarea" rows="3">${escapeHtml(note.text)}</textarea>
      <div class="note-popup-actions">
        <button class="note-save-btn">Save</button>
        <button class="note-delete-btn">Delete</button>
      </div>
    </div>
  `;
}

function wireNotePopup(e, note) {
  const el = e.popup.getElement();
  el.querySelector(".note-save-btn").addEventListener("click", () => {
    const text = el.querySelector(".note-textarea").value;
    Storage.updateNote(state.mapData.mapSlug, note.id, text);
    note.text = text;
    e.target.closePopup();
    renderNotesList();
  });
  el.querySelector(".note-delete-btn").addEventListener("click", () => {
    Storage.deleteNote(state.mapData.mapSlug, note.id);
    state.map.removeLayer(state.noteMarkers.get(note.id));
    state.noteMarkers.delete(note.id);
    renderNotesList();
  });
}

function openNoteEditor(latlng, existing) {
  const note = existing || {
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    lat: latlng.lat,
    lng: latlng.lng,
    text: "",
    createdAt: new Date().toISOString(),
  };
  if (!existing) Storage.addNote(state.mapData.mapSlug, note);
  addNoteMarker(note);
  state.noteMarkers.get(note.id).openPopup();
  renderNotesList();
}

function renderNotesList() {
  const notes = Storage.getNotes(state.mapData.mapSlug);
  if (!notes.length) {
    els.notesList.innerHTML = "";
    return;
  }
  els.notesList.innerHTML = notes
    .map(
      (n) => `
      <div class="note-list-item" data-note-focus="${n.id}">
        <div class="note-list-text">${escapeHtml(n.text) || "<em>(empty note)</em>"}</div>
      </div>`
    )
    .join("");
  els.notesList.querySelectorAll("[data-note-focus]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-note-focus");
      const marker = state.noteMarkers.get(id);
      if (!marker) return;
      state.map.setView(marker.getLatLng(), Math.max(state.map.getZoom(), 13));
      marker.openPopup();
    });
  });
}

// ---------- Grandmaster armor checklist ----------
// Game-wide crafting checklist (not tied to a map/region), transcribed from
// a user-provided PDF guide. Loaded once at startup, independent of loadMap().

let grandmasterData = null;

async function loadGrandmasterArmor() {
  grandmasterData = await fetchJson("data/grandmaster-armor.json");
  renderGrandmaster();
}

function grandmasterComponentKey(setSlug, index) {
  return `${setSlug}:${index}`;
}

function renderGrandmaster() {
  if (!grandmasterData) return;
  const completed = Storage.getGrandmasterCompleted();

  els.grandmasterUnlockNote.textContent = grandmasterData.unlockNote || "";

  els.grandmasterSets.innerHTML = grandmasterData.sets
    .map((set) => renderGrandmasterSet(set, completed))
    .join("");

  els.grandmasterSets.querySelectorAll("[data-gm-component]").forEach((cb) => {
    cb.addEventListener("change", onGrandmasterToggle);
  });

  els.grandmasterSets.querySelectorAll("[data-material]").forEach((span) => {
    span.addEventListener("mouseenter", onMaterialHoverStart);
    span.addEventListener("mouseleave", hideMaterialTooltip);
  });

  els.grandmasterReferenceImages.innerHTML = grandmasterData.craftingChainReferences
    .map(
      (ref) => `
      <button type="button" class="gm-reference-link" data-ref-image="${ref.image}" data-ref-title="${escapeHtml(ref.title)}">
        <img src="${ref.image}" alt="${escapeHtml(ref.title)}" class="gm-reference-thumb">
        <span>${escapeHtml(ref.title)}</span>
      </button>`
    )
    .join("");

  els.grandmasterReferenceImages.querySelectorAll("[data-ref-image]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openImageModal(btn.getAttribute("data-ref-image"), btn.getAttribute("data-ref-title"));
    });
  });

  els.grandmasterReset.onclick = () => {
    if (!confirm("Reset your Grandmaster armor gathering progress?")) return;
    Storage.resetGrandmasterCompleted();
    renderGrandmaster();
  };

  const total = grandmasterData.sets.reduce((sum, s) => sum + s.components.length, 0);
  els.grandmasterProgress.textContent = `${completed.size} / ${total} gathered`;
}

function renderGrandmasterSet(set, completed) {
  const done = set.components.filter((_, i) => completed.has(grandmasterComponentKey(set.slug, i))).length;
  const items = set.components
    .map((c, i) => {
      const key = grandmasterComponentKey(set.slug, i);
      return `
      <label class="checklist-item">
        <input type="checkbox" data-gm-component="${key}" ${completed.has(key) ? "checked" : ""}>
        <span data-material="${escapeHtml(c.name)}">(${c.qty}) ${escapeHtml(c.name)}</span>
      </label>`;
    })
    .join("");
  return `
    <details class="checklist-leaf" open>
      <summary>${escapeHtml(set.name)} <span class="checklist-count">${done}/${set.components.length}</span></summary>
      ${items}
    </details>
  `;
}

function onGrandmasterToggle(e) {
  Storage.toggleGrandmasterComponent(e.target.getAttribute("data-gm-component"));
  renderGrandmaster();
}

// ---------- Builds ----------
// Character build guides (skills/mutations/gear/consumables), authored from
// user-supplied build notes. Game-wide, independent of the map.

let buildsData = null;

async function loadBuilds() {
  const data = await fetchJson("data/builds.json");
  buildsData = data.builds;
  if (!buildsData.length) return;

  els.buildSelect.innerHTML = buildsData
    .map((b) => `<option value="${b.slug}">${escapeHtml(b.name)}</option>`)
    .join("");
  els.buildSelect.addEventListener("change", () => renderBuild(els.buildSelect.value));

  els.buildSelect.value = buildsData[0].slug;
  renderBuild(buildsData[0].slug);
}

function renderBuild(slug) {
  const build = buildsData.find((b) => b.slug === slug);
  if (!build) return;
  const iconUrl = (icon) => build.iconBase + icon;

  const parts = [];
  parts.push(`<p class="build-role">${escapeHtml(build.role)}</p>`);

  if (build.skillTreeImage) {
    parts.push(`
      <button type="button" class="gm-reference-link" data-ref-image="${build.skillTreeImage}" data-ref-title="${escapeHtml(build.name)} skill tree">
        <img src="${build.skillTreeImage}" alt="${escapeHtml(build.name)} skill tree" class="gm-reference-thumb">
        <span>View in-game skill tree &amp; mutations</span>
      </button>
    `);
  }

  parts.push(
    buildItemSection("Mutation", [{ name: build.mutation.name, icon: build.mutation.icon, description: build.mutation.description }], iconUrl)
  );

  parts.push(`
    <div class="build-section">
      <div class="build-section-title">Toxicity Strategy</div>
      <p class="build-text">${escapeHtml(build.toxicityStrategy)}</p>
    </div>
  `);

  const treesHtml = build.skillTrees
    .map(
      (tree) => `
      <div class="build-tree-header tree-${tree.color}">
        ${escapeHtml(tree.name)} Tree <span class="tree-slot-count">${tree.slotCount} slots</span>
      </div>
      ${tree.skills.map((s) => buildItemRow(s.name, s.icon, s.rank, s.description, iconUrl)).join("")}
    `
    )
    .join("");
  parts.push(`
    <div class="build-section">
      <div class="build-section-title">Skills</div>
      <p class="build-text">${escapeHtml(build.slotNote)}</p>
      ${treesHtml}
    </div>
  `);

  if (build.mutagens) {
    parts.push(`
      <div class="build-section">
        <div class="build-section-title">Mutagens</div>
        <p class="build-text">${escapeHtml(build.mutagens)}</p>
      </div>
    `);
  }

  parts.push(buildItemSection("Gear", build.gear, iconUrl));
  parts.push(buildItemSection("Runewords &amp; Glyphs", build.enchantments, iconUrl));

  parts.push(`
    <div class="build-section">
      <div class="build-section-title">Potions &amp; Decoctions</div>
      <p class="build-text">${escapeHtml(build.consumables.rotationNote)}</p>
      <div class="build-tree-header tree-green">Decoctions</div>
      ${build.consumables.decoctions.map((d) => buildItemRow(d.name, d.icon, null, d.description, iconUrl)).join("")}
      <div class="build-tree-header tree-red">Potions</div>
      ${build.consumables.potions.map((p) => buildItemRow(p.name, p.icon, null, p.description, iconUrl)).join("")}
    </div>
  `);

  els.buildContent.innerHTML = parts.join("");

  els.buildContent.querySelectorAll("[data-ref-image]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openImageModal(btn.getAttribute("data-ref-image"), btn.getAttribute("data-ref-title"));
    });
  });
}

function buildItemSection(title, items, iconUrl) {
  return `
    <div class="build-section">
      <div class="build-section-title">${title}</div>
      ${items.map((it) => buildItemRow(it.name, it.icon, null, it.description, iconUrl, it.slot)).join("")}
    </div>
  `;
}

function buildItemRow(name, icon, rank, description, iconUrl, slot) {
  const rankHtml = rank ? `<span class="build-item-rank">${escapeHtml(rank)}</span>` : "";
  const slotHtml = slot ? `<div class="build-item-desc"><em>${escapeHtml(slot)}</em></div>` : "";
  return `
    <div class="build-item">
      <div class="build-item-icon-box"><img src="${iconUrl(icon)}" alt="${escapeHtml(name)}" loading="lazy"></div>
      <div class="build-item-text">
        <span class="build-item-name">${escapeHtml(name)}</span>${rankHtml}
        ${slotHtml}
        <div class="build-item-desc">${escapeHtml(description)}</div>
      </div>
    </div>
  `;
}

// ---------- Tabs & search ----------

function wireTabs() {
  els.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      els.tabBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.getAttribute("data-tab");
      els.panels.forEach((p) => p.classList.toggle("active", p.id === `panel-${tab}`));
    });
  });
}

function wireSearch() {
  els.searchBox.addEventListener("input", () => {
    state.searchTerm = els.searchBox.value;
    refreshVisibility();
  });
}

// ---------- Fullscreen ----------

function wireFullscreenToggle() {
  els.fullscreenBtn.addEventListener("click", toggleMapFullscreen);

  // Keep in sync if the user exits native fullscreen via Esc/F11 directly.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) setMapFullscreen(false);
  });
}

function toggleMapFullscreen() {
  setMapFullscreen(!document.body.classList.contains("map-fullscreen"));
}

function setMapFullscreen(on) {
  document.body.classList.toggle("map-fullscreen", on);
  els.fullscreenBtn.classList.toggle("active", on);

  if (document.fullscreenEnabled) {
    if (on && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else if (!on && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }

  // The map container's size just changed; Leaflet needs to recompute it
  // after the browser has applied the layout change.
  requestAnimationFrame(() => state.map && state.map.invalidateSize());
}

// ---------- Image lightbox ----------

function wireImageModal() {
  els.imageModalClose.addEventListener("click", closeImageModal);
  els.imageModal.addEventListener("click", (e) => {
    if (e.target === els.imageModal) closeImageModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.imageModal.classList.contains("hidden")) closeImageModal();
  });
}

function openImageModal(src, title) {
  els.imageModalImg.src = src;
  els.imageModalImg.alt = title || "";
  els.imageModal.classList.remove("hidden");
}

function closeImageModal() {
  els.imageModal.classList.add("hidden");
  els.imageModalImg.src = "";
}

// ---------- Material acquisition tooltip ----------

function onMaterialHoverStart(e) {
  const materialName = e.target.getAttribute("data-material");
  const info = grandmasterData && grandmasterData.materialInfo && grandmasterData.materialInfo[materialName];
  if (!info) return;

  els.materialTooltip.textContent = info;
  els.materialTooltip.classList.remove("hidden");

  const rect = e.target.getBoundingClientRect();
  const tooltipRect = els.materialTooltip.getBoundingClientRect();
  let left = rect.right + 10;
  if (left + tooltipRect.width > window.innerWidth - 8) left = rect.left - tooltipRect.width - 10;
  let top = rect.top;
  if (top + tooltipRect.height > window.innerHeight - 8) top = window.innerHeight - tooltipRect.height - 8;

  els.materialTooltip.style.left = `${Math.max(8, left)}px`;
  els.materialTooltip.style.top = `${Math.max(8, top)}px`;
}

function hideMaterialTooltip() {
  els.materialTooltip.classList.add("hidden");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
