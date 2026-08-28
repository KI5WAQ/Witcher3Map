// Local persistence for completion state, notes, and layer visibility.
// Everything lives in localStorage — this is a fully local, no-backend app.
const Storage = (() => {
  const KEY_PREFIX = "w3map";

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error("Storage write failed", key, e);
    }
  }

  // --- Marker completion (shared per game object, e.g. "the-witcher-3-wild-hunt") ---
  function completedKey(objectSlug) {
    return `${KEY_PREFIX}:completed:${objectSlug}`;
  }

  function getCompleted(objectSlug) {
    return new Set(read(completedKey(objectSlug), []));
  }

  function setCompleted(objectSlug, idsSet) {
    write(completedKey(objectSlug), Array.from(idsSet));
  }

  function toggleCompleted(objectSlug, markerId) {
    const set = getCompleted(objectSlug);
    const nowCompleted = !set.has(markerId);
    if (nowCompleted) set.add(markerId);
    else set.delete(markerId);
    setCompleted(objectSlug, set);
    return nowCompleted;
  }

  function resetCompleted(objectSlug) {
    setCompleted(objectSlug, new Set());
  }

  // --- Custom user notes (per map) ---
  function notesKey(mapSlug) {
    return `${KEY_PREFIX}:notes:${mapSlug}`;
  }

  function getNotes(mapSlug) {
    return read(notesKey(mapSlug), []);
  }

  function addNote(mapSlug, note) {
    const notes = getNotes(mapSlug);
    notes.push(note);
    write(notesKey(mapSlug), notes);
  }

  function updateNote(mapSlug, noteId, text) {
    const notes = getNotes(mapSlug);
    const n = notes.find((n) => n.id === noteId);
    if (n) n.text = text;
    write(notesKey(mapSlug), notes);
  }

  function deleteNote(mapSlug, noteId) {
    const notes = getNotes(mapSlug).filter((n) => n.id !== noteId);
    write(notesKey(mapSlug), notes);
  }

  // --- Legend layer visibility (per map) ---
  function hiddenTypesKey(mapSlug) {
    return `${KEY_PREFIX}:hiddenTypes:${mapSlug}`;
  }

  function getHiddenTypes(mapSlug) {
    return new Set(read(hiddenTypesKey(mapSlug), []));
  }

  function setHiddenTypes(mapSlug, set) {
    write(hiddenTypesKey(mapSlug), Array.from(set));
  }

  // --- Legend group collapsed/expanded state (per map) ---
  function collapsedGroupsKey(mapSlug) {
    return `${KEY_PREFIX}:collapsedLegendGroups:${mapSlug}`;
  }

  function getCollapsedLegendGroups(mapSlug) {
    return new Set(read(collapsedGroupsKey(mapSlug), []));
  }

  function setCollapsedLegendGroups(mapSlug, set) {
    write(collapsedGroupsKey(mapSlug), Array.from(set));
  }

  // --- Grandmaster armor component checklist (game-wide, not per-map) ---
  const GRANDMASTER_KEY = `${KEY_PREFIX}:grandmasterCompleted`;

  function getGrandmasterCompleted() {
    return new Set(read(GRANDMASTER_KEY, []));
  }

  function toggleGrandmasterComponent(componentKey) {
    const set = getGrandmasterCompleted();
    const nowCompleted = !set.has(componentKey);
    if (nowCompleted) set.add(componentKey);
    else set.delete(componentKey);
    write(GRANDMASTER_KEY, Array.from(set));
    return nowCompleted;
  }

  function resetGrandmasterCompleted() {
    write(GRANDMASTER_KEY, []);
  }

  return {
    getCompleted,
    toggleCompleted,
    resetCompleted,
    getNotes,
    addNote,
    updateNote,
    deleteNote,
    getHiddenTypes,
    setHiddenTypes,
    getCollapsedLegendGroups,
    setCollapsedLegendGroups,
    getGrandmasterCompleted,
    toggleGrandmasterComponent,
    resetGrandmasterCompleted,
  };
})();
