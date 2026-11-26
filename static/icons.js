'use strict';

// Line drawings authored for this map, in a 24 × 24 viewBox.
const mapGlyphs = {
  card: 'M7 4h10l2 3v13H5V7z M12 8l3 4-3 4-3-4z',
  waink: 'M4 8h4l2-3h4l2 3h4v11H4z M15 13a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  magazine: 'M12 19c-3-2-6-2-9-2V5c4 0 7 0 9 3 2-3 5-3 9-3v12c-3 0-6 0-9 2V8',
  meditation: 'M12 16C7 12 10 7 12 5c2 2 5 7 0 11ZM12 18c-5 0-8-3-9-7 3 0 7 1 9 7Zm0 0c5 0 8-3 9-7-3 0-7 1-9 7Z',
  playlist: 'M10 17V6l9-2v10 M10 17c0 2-4 4-6 2-1-2 3-5 6-4 M19 14c0 2-4 4-6 2-1-2 3-5 6-4',
  hoop: 'M4 8h16 M6 8l3 10h6l3-10 M7 11l8 7 M17 11l-8 7 M7 5h10',
  stunt: 'm4 18 6-5 3 1 7-9 M15 5h5v5 M4 9l3-3 M5 13l3-3',
  race: 'M5 21V4c5-4 9 4 15 0v11c-6 4-10-4-15 0 M9 4v8 M14 6v8 M18 5v9 M5 9c5-4 9 4 15 0',
  drone: 'M8 12h8v4H8z M8 13 4 8m12 5 4-5 M2 8h5m10 0h5 M12 12V8',
  range: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-5 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z M12 2v4m0 12v4M2 12h4m12 0h4',
  arcade: 'M7 8h10c3 0 5 9 2 10-2 0-3-3-5-3h-4c-2 0-3 3-5 3-3-1-1-10 2-10Zm1 2v4m-2-2h4m6-1h.1m2 2h.1',
  gang: 'M5 9 12 4l7 5v6l-7 5-7-5Z M9 12l3 3 3-3',
  bank: 'm3 8 9-5 9 5v2H3z M6 10v8m4-8v8m4-8v8m4-8v8 M3 19h18',
  store: 'M5 10v10h14V10 M3 10l2-6h14l2 6c0 2-3 3-4 1-2 2-4 2-5 0-1 2-3 2-5 0-1 2-4 1-4-1Z M9 20v-5h6v5',
  package: 'm4 7 8-4 8 4v10l-8 4-8-4z M4 7l8 4 8-4m-8 4v10m4-16-8 4',
  meteorite: 'm3 5 9 8m1-9 4 6m-13 3 5 3 M15 11c4-1 7 4 5 7-2 4-9 3-9-1 0-3 1-5 4-6Z',
  treasure: 'M4 10h16v9H4z M4 10c0-3 2-5 5-5h6c3 0 5 2 5 5 M10 10v4h4v-4',
  bottle: 'm13 5 4 3-3 3c1 3 1 5-1 8-2 2-7-2-6-4 1-3 3-4 5-5z M10 12l4 4',
  vehicle: 'm4 11 2-5h12l2 5v6H4z M5 11h14 M7 14h2m6 0h2m-11 3v2m12-2v2',
  bridge: 'M3 16h18 M6 16V7m12 9V7M3 11c4 0 6-6 9-6s5 6 9 6 M9 8v8m6-8v8',
  fishing: 'M5 19 14 5c4 0 5 4 5 7v4c0 3-5 3-5 0v-1l2 1',
  hunting: 'm7 5 5 6 5-6m-5 6v8 M4 6v4l4 3m12-7v4l-4 3',
  event: 'm12 3 1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9Z',
  safe: 'M4 5h16v14H4z M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm0 3 2-2M5 9h2m-2 6h2',
  weapon: 'M4 7h16v5h-6l-3 6H7l2-6H4z',
  safehouse: 'm3 11 9-7 9 7m-3-2v11H6V9 M10 20v-6h4v6',
  shop: 'M6 8h12l2 12H4z M9 9V6a3 3 0 0 1 6 0v3',
  food: 'M6 4v7m3-7v7m3-7v7c0 3-6 3-6 0m3 3v6 M18 4c-2 2-3 5-3 8h3v8',
  hotel: 'M4 6v13m16-9v9M4 16h16v-4c0-2-3-3-6-3h-3v7M8 11h.1',
  transport: 'M6 4h12l2 3v10H4V7z M4 12h16M7 15h1m8 0h1M7 17v3m10-3v3',
  civic: 'M12 4 4 7v5c0 5 5 8 8 9 3-1 8-4 8-9V7z M12 8v8m-4-4h8',
  leisure: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-8v16m-8-8h16 M7 6c4 4 4 8 0 12M17 6c-4 4-4 8 0 12',
  nature: 'M4 19c10 0 15-6 15-14C9 5 5 8 5 15m1 4L15 9',
  building: 'M5 20V5h8v15m0-12h6v12M3 20h18 M8 8h2m-2 4h2m-2 4h2m6-4h1m-1 4h1',
  waypoint: 'M6 21V4h13l-3 4 3 4H6',
  other: 'm12 4 8 8-8 8-8-8z M12 11v2',
};
const relatedGlyphs = {
  bookswap: 'magazine', knife: 'stunt', basejump: 'stunt', smash: 'store', fence: 'store',
  payday: 'bank', towatm: 'bank', mural: 'event', streetart: 'event',
};
function glyph(kind) {
  const path = mapGlyphs[kind] || mapGlyphs[relatedGlyphs[kind]] || mapGlyphs.other;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const drawing = document.createElementNS(svg.namespaceURI, 'path');
  drawing.setAttribute('d', path);
  svg.append(drawing);
  return svg;
}
