'use strict';

const $ = id => document.getElementById(id);
const node = (tag, text, className) => {
  const item = document.createElement(tag);
  if (text != null) item.textContent = text;
  if (className) item.className = className;
  return item;
};
const actions = (label, handler, style) => {
  const button = node('button', label, style);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await handler(); }
    catch (error) { notify(error.message); }
    finally { button.disabled = false; }
  });
  return button;
};
const number = value => value == null ? '—' : new Intl.NumberFormat().format(value);
const clock = new Intl.DateTimeFormat('en-LK', {
  timeZone: 'Asia/Colombo', dateStyle: 'medium', timeStyle: 'short',
});
const date = value => value ? clock.format(new Date(value)) : '—';
const mobile = matchMedia('(max-width: 680px)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const bounds = [[-1024, 0], [0, 1024]];
const focusBounds = [[-785, 190], [-205, 615]];
const visibility = {locked: 'Locked at current progress', available: 'Available', unknown: 'Availability unknown', closed: 'Chapter window closed'};
const completionText = {manual: 'Completed manually', automatic: 'Completed with verified evidence'};
const revealed = new Set();
const checkboxes = new Map();
const mapMarkers = new Map();
let metadata, categories, selected, map, cluster, waypointLayer, state, preferences, settingsSaved, expedition;
let mapPayload = {markers: [], waypoints: [], linked: {}};
let noticeTimer, searchTimer, mapRequest = 0, detailRequest = 0, detailId, identifying, waypoint, waypointMode;
let guideTimer, guideRequest = 0, activeGuide;
let currentView = 'filters';
let refreshInProgress = false;
let started = false;

function notify(message, keep = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = false;
  if (!keep) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6400);
}

async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.message || value.error || 'The request failed.');
  return value;
}

function query(id) {
  const params = new URLSearchParams();
  if ($('full-map').checked) params.set('view', 'full');
  if (id) params.set('id', id);
  if (revealed.size) params.set('reveal', [...revealed].join(','));
  return '?' + params.toString();
}

function pin(marker) {
  const element = node('div', null,
    ['map-pin', marker.availability, marker.completion].filter(Boolean).join(' '));
  element.style.setProperty('--color', categories.get(marker.kind)?.color || '#ff9cbf');
  element.append(glyph(marker.kind));
  if (marker.completion) element.append(node('span', '✓', 'check'));
  if (marker.favorite) element.append(node('span', '★', 'star'));
  return L.divIcon({className: '', html: element, iconSize: [29, 29], iconAnchor: [14, 14]});
}

function initMap() {
  map = L.map('map', {
    crs: L.CRS.Simple, minZoom: -2, maxZoom: 7, zoomSnap: .5, zoomDelta: .5,
    maxBounds: [[-1200, -176], [176, 1200]], zoomAnimation: !reducedMotion.matches,
    fadeAnimation: !reducedMotion.matches, attributionControl: false,
  });
  L.control.attribution({prefix: false}).addTo(map);
  L.tileLayer('/tiles/{z}/{z},{y},{x}.jpg', {
    tileSize: 256, minZoom: -2, maxZoom: 7, minNativeZoom: 0, maxNativeZoom: metadata.nativeZoom,
    noWrap: true, bounds,
    attribution: '<a href="https://map.gtadb.org/" target="_blank" rel="noopener">GTA VI Map Tiles — GTADB.ORG and contributors</a> · ' +
      '<a href="https://github.com/fbritoferreira/gta6" target="_blank" rel="noopener">Open GTA 6 Map markers (adapted)</a> · ' +
      '<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>',
  }).addTo(map);
  cluster = L.markerClusterGroup({
    maxClusterRadius: zoom => zoom >= 3 ? 10 : 47, showCoverageOnHover: false, animate: !reducedMotion.matches,
    iconCreateFunction(group) {
      const count = group.getChildCount();
      const size = count > 500 ? 51 : count > 40 ? 40 : 30;
      return L.divIcon({html: node('span', number(count)), className: 'map-cluster', iconSize: [size, size]});
    },
  }).addTo(map);
  waypointLayer = L.layerGroup().addTo(map);
  const labels = metadata.districts.map(district =>
    L.marker([-district.y, district.x], {
      interactive: false, keyboard: false, opacity: .93, zIndexOffset: -800,
      icon: L.divIcon({className: 'district-label', html: node('span', district.name), iconSize: [144, 18]}),
    }).addTo(map));
  recenter();
  function arrangeLabels() {
    const occupied = [];
    for (const label of labels) {
      const element = label.getElement();
      if (!element) continue;
      const position = map.latLngToContainerPoint(label.getLatLng());
      const width = element.firstChild.offsetWidth / 2 + 5;
      const overlap = occupied.some(other => Math.abs(other.y - position.y) < 18 &&
        Math.abs(other.x - position.x) < other.width + width);
      const hidden = overlap || (expedition && !expedition.isRevealed(label.getLatLng()));
      element.style.visibility = hidden ? 'hidden' : '';
      if (!hidden) occupied.push({...position, width});
    }
  }
  map.on('resize zoomend fogchange', arrangeLabels);
  arrangeLabels();
  new ResizeObserver(() => map.invalidateSize({pan: false})).observe($('map'));
  map.on('click', event => {
    if (!waypointMode) return;
    waypoint = {x: Number(event.latlng.lng.toFixed(3)), y: Number((-event.latlng.lat).toFixed(3))};
    if (waypoint.x < 0 || waypoint.x > 1024 || waypoint.y < 0 || waypoint.y > 1024) {
      notify('Choose a point within the map.');
      return;
    }
    setWaypointMode(false);
    $('waypoint-name').value = '';
    $('waypoint-dialog').showModal();
  });
}

function recenter() {
  map.fitBounds(focusBounds, {animate: false, padding: [28, 22], maxZoom: 1});
}

function setWaypointMode(active) {
  waypointMode = active;
  $('add-waypoint').setAttribute('aria-pressed', String(active));
  $('map').classList.toggle('waypoint-mode', active);
  if (active) {
    if (mobile.matches) showView(null);
    notify('Click or tap the map to place your waypoint.');
  }
}

function showView(view) {
  currentView = view;
  $('workspace').classList.toggle('collapsed', !view);
  for (const item of ['filters', 'progress', 'guides']) {
    $(item).hidden = item !== view;
    $(item + '-tab').setAttribute('aria-pressed', String(item === view));
  }
}

function renderCategoryControls() {
  const groups = new Map();
  for (const category of categories.values()) {
    if (!groups.has(category.group)) {
      const details = node('details', null, 'category-group');
      details.open = category.group === 'Collectibles' || category.group === 'Activities';
      details.append(node('summary', category.group));
      $('groups').append(details);
      groups.set(category.group, details);
    }
    const row = node('label', null, 'category');
    row.style.setProperty('--color', category.color);
    const box = node('input');
    box.type = 'checkbox';
    box.checked = selected.has(category.key);
    row.append(box, glyph(category.key), node('span', category.name), node('span', category.count, 'category-count'));
    groups.get(category.group).append(row);
    checkboxes.set(category.key, box);
    box.addEventListener('change', () => {
      if (box.checked) selected.add(category.key);
      else selected.delete(category.key);
      savePreferences();
      renderMarkers();
    });
  }
  for (const category of [...categories.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const option = node('option', category.name);
    option.value = category.key;
    $('reveal-category').append(option);
  }
}

function savePreferences() {
  preferences = {
    selected: [...selected].sort(), hideCompleted: $('hide-completed').checked,
    fullMap: $('full-map').checked, favoritesOnly: $('only-favorites').checked, fog: expedition.fog,
  };
  const save = preferences;
  settingsSaved = settingsSaved.catch(() => {}).then(() => api('/api/preferences', save));
  settingsSaved.catch(() => notify('Unable to save your preferences.'));
}

function setSelected(keys) {
  selected = new Set(keys);
  for (const [key, box] of checkboxes) box.checked = selected.has(key);
  savePreferences();
  renderMarkers();
}

async function setReveal(key, enabled) {
  if (enabled) {
    revealed.add(key);
    if (!selected.has(key)) {
      selected.add(key);
      checkboxes.get(key).checked = true;
      savePreferences();
    }
  } else {
    revealed.delete(key);
    closeDetail();
    mapPayload.markers = mapPayload.markers.filter(item => item.availability !== 'unknown' || revealed.has(item.kind));
    renderMarkers();
  }
  $('reveal-category').value = '';
  $('revealed').replaceChildren(...[...revealed].map(kind =>
    actions(categories.get(kind).name + ' ×', () => setReveal(kind, false))));
  await refreshMap();
}

async function refreshMap() {
  const version = ++mapRequest;
  const data = await api('/api/map' + query());
  if (version !== mapRequest) return;
  mapPayload = data;
  renderMarkers();
  renderWaypoints();
  expedition.update(data);
  renderNearby();
  if (currentView === 'guides') searchGuides(activeGuide);
  if (detailId && !data.markers.some(marker => marker.id === detailId) &&
      !data.waypoints.some(marker => marker.id === detailId)) closeDetail();
}

function matchingMarkers(term) {
  return mapPayload.markers.filter(marker =>
    selected.has(marker.kind) &&
    (!$('hide-completed').checked || !marker.completion) &&
    (!$('only-favorites').checked || marker.favorite) &&
    (!term || [marker.name, marker.type, marker.area, categories.get(marker.kind).name]
      .some(value => value.toLocaleLowerCase().includes(term))));
}

function renderMarkers() {
  const term = $('search').value.trim().toLocaleLowerCase();
  const matches = matchingMarkers(term);
  const current = new Set(matches.map(item => item.id));
  const removed = [];
  for (const [id, row] of mapMarkers) {
    if (!current.has(id)) {
      removed.push(row.layer);
      mapMarkers.delete(id);
    }
  }
  if (removed.length) cluster.removeLayers(removed);
  const added = [];
  for (const marker of matches) {
    const row = mapMarkers.get(marker.id);
    if (row) {
      if (row.data.completion !== marker.completion || row.data.favorite !== marker.favorite ||
          row.data.availability !== marker.availability) row.layer.setIcon(pin(marker));
      row.data = marker;
      continue;
    }
    const layer = L.marker([-marker.y, marker.x], {icon: pin(marker), title: marker.name, alt: marker.name});
    layer.on('click', () => openDetail(marker.id).catch(error => notify(error.message)));
    mapMarkers.set(marker.id, {layer, data: marker});
    added.push(layer);
  }
  if (added.length) cluster.addLayers(added);
  $('count').textContent = number(matches.length) + ' markers';
  renderSearch(term, matches);
}

function renderSearch(term, matches) {
  const results = $('results');
  results.hidden = !term;
  if (!term) return;
  const districts = metadata.districts.filter(item => item.name.toLocaleLowerCase().includes(term));
  const resultsList = districts.map(item => actions(item.name + ' · District', () => {
    closeDetail();
    $('search').value = '';
    renderMarkers();
    if (mobile.matches) showView(null);
    const coast = item.name === 'Key Lento'
      ? mapPayload.markers.filter(marker => marker.area === 'Permit Keys near Key Lento')
      : [];
    if (coast.length) {
      map.fitBounds([[-item.y, item.x], ...coast.map(marker => [-marker.y, marker.x])],
        {maxZoom: 2.5, padding: [65, 48], animate: !reducedMotion.matches});
    } else {
      map.setView([-item.y, item.x], 2.5, {animate: !reducedMotion.matches});
    }
  }));
  for (const item of matches.slice(0, 14)) {
    resultsList.push(actions(item.name + ' · ' + item.type, () => focusMarker(item.id)));
  }
  results.replaceChildren(...(resultsList.length ? resultsList : [node('p', 'No visible locations match.', 'muted')]));
}

async function focusMarker(id) {
  const point = mapPayload.markers.find(marker => marker.id === id);
  if (!point) return;
  if (mobile.matches) showView(null);
  const rendered = mapMarkers.get(id);
  if (rendered) {
    cluster.zoomToShowLayer(rendered.layer, () =>
      openDetail(id).catch(error => notify(error.message)));
  } else {
    map.setView([-point.y, point.x], 4, {animate: !reducedMotion.matches});
    await openDetail(id);
  }
}

function renderNearby() {
  const origin = mapPayload.position;
  const types = {card: 'Collectible card', magazine: 'Reading collectible', weapon: 'Weapon',
    event: 'Side mission', treasure: 'Treasure'};
  const nearby = origin ? mapPayload.markers
    .filter(item => Object.hasOwn(types, item.kind) && item.availability === 'available' && !item.completion)
    .map(item => ({...item, distance: Math.hypot(item.x - origin.x, item.y - origin.y)}))
    .filter(item => item.distance <= 45)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 8) : [];
  $('nearby').hidden = !nearby.length;
  $('nearby-list').replaceChildren(...nearby.map(item => {
    const button = actions('', () => focusMarker(item.id), 'nearby-row');
    button.append(node('strong', item.name), node('small', types[item.kind]));
    return button;
  }));
}

async function searchGuides(identifier) {
  activeGuide = identifier;
  const requestId = ++guideRequest;
  const filter = $('guide-search').value.trim();
  const query = new URLSearchParams(identifier ? {id: identifier} : {q: filter});
  const results = $('guide-results');
  try {
    const guides = await api('/api/guides?' + query);
    if (requestId !== guideRequest) return;
    results.replaceChildren(...guides.map(guide => {
      const card = node('article', null, 'guide-result');
      card.append(node('small', guide.kind + ' · Chapter ' + guide.chapter), node('h2', guide.title));
      if (guide.locked) {
        card.append(node('p', 'Unlocks later than your saved checkpoint.', 'muted'));
        return card;
      }
      if (guide.closed) card.append(node('p', 'This mission’s chapter window has closed.', 'muted'));
      const steps = node('ol');
      for (const step of guide.steps) steps.append(node('li', step));
      card.append(steps);
      const controls = node('div', null, 'detail-actions');
      if (guide.marker) controls.append(actions('Show on map', () => focusMarker(guide.marker)));
      const source = node('a', 'Full walkthrough');
      source.href = guide.source;
      source.target = '_blank';
      source.rel = 'noopener';
      controls.append(source);
      card.append(controls);
      return card;
    }));
    if (!guides.length) {
      results.append(node('p', filter ? 'No reviewed guide matches that search.' : 'No guides are available for this checkpoint.', 'muted'));
      if (filter && !identifier) {
        const search = node('a', 'Search walkthroughs on the web');
        search.href = 'https://www.google.com/search?' + new URLSearchParams({q: 'GTA VI ' + filter + ' walkthrough'});
        search.target = '_blank';
        search.rel = 'noopener';
        results.append(search);
      }
    }
  } catch (error) {
    if (requestId === guideRequest) results.replaceChildren(node('p', error.message, 'muted'));
  }
}

function renderWaypoints() {
  waypointLayer.clearLayers();
  for (const marker of mapPayload.waypoints) {
    const icon = pin({...marker, kind: 'waypoint'});
    L.marker([-marker.y, marker.x], {icon, title: marker.name, alt: marker.name})
      .on('click', () => openDetail(marker.id).catch(error => notify(error.message))).addTo(waypointLayer);
  }
}

function closeDetail() {
  detailId = null;
  detailRequest++;
  $('detail').hidden = true;
}

async function openDetail(id) {
  const marker = mapPayload.markers.find(item => item.id === id);
  const point = mapPayload.waypoints.find(item => item.id === id);
  if (!marker && !point) return;
  const version = ++detailRequest;
  detailId = id;
  const info = marker ? await api('/api/location' + query(id)) : {};
  if (version !== detailRequest) return;
  const content = $('detail-content');
  const category = marker ? categories.get(marker.kind).name : 'Custom waypoint';
  content.replaceChildren(node('span', category, 'category-label'), node('h2', (marker || point).name));
  if (marker) {
    const location = [marker.type, marker.area].filter(Boolean).join(' · ');
    content.append(node('p', location, 'muted'));
    content.append(node('p', visibility[marker.availability] +
      (marker.completion ? ' · ' + completionText[marker.completion] : '')));
  }
  if (info.description) content.append(node('p', info.description));
  if (info.realLife) content.append(node('p', info.realLife, 'muted'));
  if (info.media) {
    const figure = node('figure');
    const image = node('img');
    image.src = '/api/media' + query(id);
    image.alt = marker.name;
    figure.append(image, node('figcaption', info.media.credit + ' · ' + info.media.license, 'muted'));
    content.append(figure);
  }
  const controls = node('div', null, 'detail-actions');
  if (marker) {
    controls.append(
      actions(marker.completion ? 'Undo completion' : 'Mark completed', () =>
        changeLocation('/api/mark', {id, enabled: !marker.completion}, id)),
      actions(marker.favorite ? 'Remove favorite' : 'Favorite', () =>
        changeLocation('/api/favorite', {id, enabled: !marker.favorite}, id)),
    );
    const linked = mapPayload.linked[id];
    if (info.guide) controls.append(actions('Open mission guide', async () => {
      $('guide-search').value = '';
      showView('guides');
      await searchGuides(info.guide);
    }));
    if (linked) controls.append(actions('Unlink progress event', () =>
      changeLocation('/api/reconcile', {event: linked, action: 'unlink', id}, id)));
    if (identifying?.kind === marker.kind && !linked) controls.append(
      actions('Confirm detected progress', () =>
        reconcile(identifying.id, 'confirm', id), 'primary'));
  } else {
    controls.append(actions('Delete waypoint', async () => {
      await api('/api/waypoint', {id, delete: true});
      closeDetail();
      await refreshMap();
    }));
  }
  content.append(controls);
  $('detail').hidden = false;
}

async function changeLocation(path, data, id) {
  await api(path, {...data, view: $('full-map').checked ? 'full' : 'story', reveal: [...revealed]});
  await Promise.all([refreshStatus(), refreshMap()]);
  await openDetail(id);
}

function renderObjectives() {
  const rows = state.objectives.filter(item => item.id !== 13).map(item => {
    const row = node('div', null, 'objective');
    row.append(node('span', item.label),
      node('span', item.target == null ? number(item.value) : number(item.value) + ' / ' + number(item.target)));
    if (item.target > 0 && item.value != null) {
      const progress = node('progress');
      progress.max = item.target;
      progress.value = item.value;
      progress.setAttribute('aria-label', item.label);
      row.append(progress);
    }
    if (item.officialName) row.append(node('small', item.officialName));
    return row;
  });
  $('objectives').replaceChildren(...rows);
}

async function reconcile(event, action, id) {
  await changeLocation('/api/reconcile', {event, action, id}, id);
  if (action === 'confirm') notify('Location confirmed and saved.');
}

function renderPending() {
  $('pending-section').hidden = state.pendingEvents.length === 0;
  const rows = state.pendingEvents.map(event => {
    const row = node('div', null, 'event');
    row.append(node('strong', event.label + ' · ' + event.pending + ' to confirm'));
    row.append(node('span', number(event.previous) + ' → ' + number(event.current), 'muted'));
    const controls = node('div', null, 'detail-actions');
    controls.append(actions('Choose on map', async () => {
      identifying = event;
      await setReveal(event.kind, true);
      showView('filters');
      $('search').value = categories.get(event.kind).name;
      renderMarkers();
      notify('Select a matching marker and confirm the detected progress.');
    }), actions('Dismiss one', () => reconcile(event.id, 'dismiss')));
    row.append(controls);
    return row;
  });
  $('pending').replaceChildren(...rows);
}

function renderHistory() {
  const items = state.events.map(event => {
    const row = node('div', null, 'event');
    row.append(node('strong', event.label + ' · ' + number(event.previous) + ' → ' + number(event.current)));
    row.append(node('small', date(event.created)));
    if (event.dismissed) row.append(actions('Restore dismissed progress', () => reconcile(event.id, 'undo-dismiss')));
    return row;
  });
  for (const item of state.history) {
    const labels = {ok: 'PSN synchronization', playtime_cached: 'PSN trophies updated · cached playtime',
      auth_expired: 'Authentication expired', rate_limited: 'PSN rate limit', temporary_error: 'PSN sync unavailable'};
    const row = node('div', null, 'event');
    row.append(node('strong', labels[item.status] || 'PSN synchronization'), node('small', date(item.created)));
    items.push(row);
  }
  $('history').replaceChildren(...(items.length ? items : [node('p', 'No sync history yet.', 'muted')]));
  const trophies = state.earnedTrophies.map(trophy => {
    const row = node('div', null, 'event');
    row.append(node('strong', trophy.name || 'Earned trophy'));
    if (trophy.description) row.append(node('small', trophy.description));
    return row;
  });
  $('trophies').replaceChildren(...(trophies.length ? trophies : [node('p', 'Trophy details appear after a live sync.', 'muted')]));
}

function renderStatus() {
  const pending = state.pendingEvents.reduce((sum, event) => sum + event.pending, 0);
  const completion = state.objectives.find(item => item.id === 13)?.value;
  const reported = state.reportedCompletion?.percent;
  const useReport = reported != null && (completion == null || reported > completion);
  const displayed = useReport ? reported : completion;
  const label = useReport ? 'Game completion (reported)' : 'Game completion';
  $('top-completion').nextElementSibling.textContent = label;
  const play = state.playSeconds;
  const time = play == null ? '—' : Math.floor(play / 3600) + 'h ' + Math.floor(play % 3600 / 60) + 'm';
  const chapter = state.chapter ? 'Chapter ' + state.chapter : '—';
  const total = [state.confirmed.manual || 0, state.confirmed.automatic || 0].reduce((a, b) => a + b);
  $('top-completion').textContent = displayed == null ? '—' : displayed + '%';
  $('top-trophies').textContent = state.earned + '/' + state.total;
  const metrics = [['PSN completion objective', completion == null ? '—' : completion + '%'], ['Total playtime', time],
    ['Trophies earned', $('top-trophies').textContent], ['Story milestone completed', chapter],
    ['Confirmed map locations', number(total)], ['Pending confirmations', number(pending)]];
  if (useReport) metrics.unshift([label, reported + '%']);
  $('summary').replaceChildren(...metrics.map(([label, value]) => {
    const metric = node('div', null, 'metric');
    metric.append(node('b', value), node('small', label));
    return metric;
  }));
  $('badge').hidden = !pending;
  $('badge').textContent = pending;
  const sync = state.sync;
  const health = sync.busy ? 'Syncing with PSN…' : ({
    ok: 'PSN connected', playtime_cached: 'Trophies up to date · cached playtime',
    auth_expired: 'PSN authentication expired · cached progress',
    rate_limited: 'PSN rate limit · cached progress',
    temporary_error: 'PSN temporarily unavailable · cached progress',
  })[sync.status] || (sync.configured ? 'Ready to verify PSN' : 'PSN sign-in required · imported snapshot');
  $('sync-status').replaceChildren(node('strong', health),
    node('div', 'Last live sync ' + date(sync.lastSuccess) + ' · Colombo'),
    node('div', 'Progress updated ' + date(state.updated) + ' · Colombo'));
  if (sync.nextAllowed > Date.now() / 1000 && sync.status !== 'ok') {
    $('sync-status').append(node('div', 'Next request after ' + date(sync.nextAllowed * 1000) + ' · Colombo'));
  }
  $('sync').textContent = sync.busy ? 'Syncing…' : 'Sync now';
  $('sync').disabled = sync.busy;
  $('auto-sync').checked = Boolean(sync.automatic);
  $('auto-sync').disabled = !sync.verified;
  renderObjectives();
  renderPending();
  renderHistory();
}

async function refreshStatus() {
  const next = await api('/api/status');
  const previous = state;
  state = next;
  if (identifying && !state.pendingEvents.some(item => item.id === identifying.id)) identifying = null;
  renderStatus();
  if (previous && state.events[0]?.id > (previous.events[0]?.id || 0)) {
    notify('New PSN progress detected. Open Progress to review.');
  } else if (previous?.sync.status !== state.sync.status && state.sync.status === 'auth_expired') {
    notify('PSN authentication expired. Your last confirmed progress is still available.');
  }
  if (previous && (previous.chapter !== state.chapter || previous.updated !== state.updated)) await refreshMap();
}

async function waitForSync() {
  if (refreshInProgress) return;
  refreshInProgress = true;
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2800));
      await refreshStatus();
      if (!state.sync.busy) break;
    }
  } finally {
    refreshInProgress = false;
  }
}

function wireControls() {
  $('filters-tab').onclick = () => showView('filters');
  $('progress-tab').onclick = () => showView('progress');
  $('guides-tab').onclick = () => {
    showView('guides');
    searchGuides();
  };
  $('guide-search').oninput = () => {
    clearTimeout(guideTimer);
    guideTimer = setTimeout(() => searchGuides(), 160);
  };
  $('open-filters').onclick = () => showView(currentView === 'filters' ? null : 'filters');
  $('open-progress').onclick = () => showView(currentView === 'progress' ? null : 'progress');
  $('collapse').onclick = () => showView(null);
  $('close-detail').onclick = closeDetail;
  $('recenter').onclick = recenter;
  $('add-waypoint').onclick = () => setWaypointMode(!waypointMode);
  $('cancel-waypoint').onclick = () => $('waypoint-dialog').close();
  $('waypoint-form').onsubmit = async event => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try {
      await api('/api/waypoint', {...waypoint, name: $('waypoint-name').value});
      $('waypoint-dialog').close();
      await refreshMap();
    } catch (error) { notify(error.message); }
    finally { submit.disabled = false; }
  };
  $('fullscreen').onclick = async () => {
    const panel = $('map-panel');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (panel.requestFullscreen) await panel.requestFullscreen();
      else panel.classList.toggle('presentation');
    } catch {
      panel.classList.toggle('presentation');
    }
    updateFullscreen();
  };
  function updateFullscreen() {
    const active = Boolean(document.fullscreenElement) || $('map-panel').classList.contains('presentation');
    $('fullscreen').setAttribute('aria-pressed', String(active));
    map.invalidateSize();
  }
  document.addEventListener('fullscreenchange', updateFullscreen);
  $('search').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderMarkers, 110);
  };
  $('reveal-category').onchange = event =>
    event.target.value && setReveal(event.target.value, true).catch(error => notify(error.message));
  $('full-map').onchange = async () => {
    closeDetail();
    updateMapMode();
    savePreferences();
    try { await refreshMap(); } catch (error) { notify(error.message); }
  };
  $('select-all').onclick = () => setSelected(categories.keys());
  $('hide-all').onclick = () => setSelected([]);
  $('reset').onclick = async () => {
    revealed.clear();
    $('revealed').replaceChildren();
    $('search').value = '';
    $('hide-completed').checked = false;
    $('only-favorites').checked = false;
    identifying = null;
    closeDetail();
    mapPayload = {markers: [], waypoints: mapPayload.waypoints, linked: {}};
    setSelected(categories.keys());
    await refreshMap().catch(error => notify(error.message));
  };
  for (const id of ['hide-completed', 'only-favorites']) $(id).onchange = () => {
    savePreferences();
    renderMarkers();
  };
  $('sync').onclick = async () => {
    $('sync').disabled = true;
    try {
      const result = await api('/api/sync', {});
      notify(result.message);
      await refreshStatus();
      await waitForSync();
    } catch (error) { notify(error.message); }
    finally { $('sync').disabled = Boolean(state?.sync.busy); }
  };
  $('auto-sync').onchange = async () => {
    const option = $('auto-sync');
    try { await api('/api/auto', {enabled: option.checked}); }
    catch (error) { notify(error.message); }
    finally { await refreshStatus().catch(error => notify(error.message)); }
  };
  mobile.addEventListener('change', event => showView(event.matches ? null : 'filters'));
}

function updateMapMode() {
  const full = $('full-map').checked;
  $('spoiler-controls').hidden = full;
  $('mode-label').textContent = full ? 'Full map' : 'Story map';
  $('toggle-fog').hidden = full;
  expedition.redraw();
}

async function start() {
  metadata = await api('/api/catalog');
  categories = new Map(metadata.categories.map((item, index) => [item.key, {
    ...item, color: 'hsl(' + Math.round((180 + index * 137.508) % 360) + ' 83% 69%)',
  }]));
  preferences = metadata.preferences;
  settingsSaved = Promise.resolve();
  selected = new Set(preferences.selected ?? categories.keys());
  $('hide-completed').checked = preferences.hideCompleted;
  $('only-favorites').checked = preferences.favoritesOnly;
  showView(mobile.matches ? null : 'filters');
  initMap();
  expedition = new ExpeditionView(map, preferences.fog);
  $('full-map').checked = preferences.fullMap;
  updateMapMode();
  renderCategoryControls();
  wireControls();
  await Promise.all([refreshMap(), refreshStatus()]);
  started = true;
  setInterval(() => {
    if (document.hidden || refreshInProgress) return;
    refreshStatus().catch(() => notify('Connection lost. The open map and progress stay available.'));
  }, 30_000);
  setInterval(() => {
    if (!document.hidden) refreshMap().catch(() => {});
  }, 60_000);
}

start().catch(error => notify(error.message, !started));

