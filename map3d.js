// 3D-Ansicht mit MapLibre GL JS: echtes Gelände (freie Terrain-RGB-Kacheln, kein Key)
// + Flug als Höhen-„Vorhang" (Wand vom Boden bis zur Flughöhe, nach Höhe eingefärbt).
// MapLibre wird erst beim ersten Öffnen per CDN nachgeladen (App bleibt schlank).

const MAPLIBRE_JS = 'https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.js';
const MAPLIBRE_CSS = 'https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.css';
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const ESRI_SAT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

let mlLoading = null;
function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  if (mlLoading) return mlLoading;
  mlLoading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = MAPLIBRE_CSS;
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = MAPLIBRE_JS;
    s.onload = () => resolve();
    s.onerror = () => { mlLoading = null; reject(new Error('MapLibre konnte nicht geladen werden (offline?).')); };
    document.head.appendChild(s);
  });
  return mlLoading;
}

// Höhen-Gradient (blau→grün→rot), gleich wie 2D-Profil-Logik
function eleColorStops(min, max) {
  const span = Math.max(1, max - min);
  return [
    min, '#2c7bb6', min + span * 0.25, '#00a6ca',
    min + span * 0.5, '#a6d96a', min + span * 0.75, '#fdae61', max, '#d7191c',
  ];
}

function buildGeoJSON(tracks) {
  const lineFeatures = [];
  const wallFeatures = [];
  let minEle = Infinity, maxEle = -Infinity, hasEle = false;

  for (const t of tracks) {
    const coords = t.points.map(p => [p.lon, p.lat]);
    lineFeatures.push({ type: 'Feature', properties: { color: t.color }, geometry: { type: 'LineString', coordinates: coords } });

    const pts = t.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (a.ele == null || b.ele == null) continue;
      hasEle = true;
      const el = Math.max(a.ele, b.ele), avg = (a.ele + b.ele) / 2;
      minEle = Math.min(minEle, a.ele, b.ele); maxEle = Math.max(maxEle, a.ele, b.ele);
      // schmales Quad entlang des Segments (Wand)
      const cosLat = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
      const dx = (b.lon - a.lon) * 111320 * cosLat, dy = (b.lat - a.lat) * 111320;
      const len = Math.hypot(dx, dy) || 1;
      const w = 7; // Halbbreite (m)
      const ox = (-dy / len) * w / (111320 * cosLat), oy = (dx / len) * w / 111320;
      wallFeatures.push({
        type: 'Feature',
        properties: { ele: avg, height: el },
        geometry: { type: 'Polygon', coordinates: [[
          [a.lon + ox, a.lat + oy], [b.lon + ox, b.lat + oy],
          [b.lon - ox, b.lat - oy], [a.lon - ox, a.lat - oy], [a.lon + ox, a.lat + oy],
        ]] },
      });
    }
  }
  if (!hasEle) { minEle = 0; maxEle = 1000; }
  return {
    line: { type: 'FeatureCollection', features: lineFeatures },
    wall: { type: 'FeatureCollection', features: wallFeatures },
    minEle, maxEle, hasEle,
  };
}

function boundsOf(tracks) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const t of tracks) for (const p of t.points) {
    w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat);
  }
  return [[w, s], [e, n]];
}

let current = null; // { map, overlay }

export async function open3D(tracks) {
  await loadMapLibre();
  if (current) close3D();

  const overlay = document.createElement('div');
  overlay.id = 'map3d-overlay';
  overlay.className = 'map3d-overlay';
  overlay.innerHTML = `
    <div id="map3d"></div>
    <div class="map3d-bar">
      <strong>3D-Geländeansicht</strong>
      <label class="m3d-ctl">Basiskarte
        <select id="m3d-base"><option value="sat">Satellit</option><option value="osm">OpenStreetMap</option></select>
      </label>
      <label class="m3d-ctl">Überhöhung <input id="m3d-exag" type="range" min="1" max="3" step="0.1" value="1.5" /></label>
      <label class="m3d-ctl"><input id="m3d-wall" type="checkbox" checked /> Höhen-Wand</label>
      <span class="m3d-legend" id="m3d-legend"></span>
      <button id="m3d-close" class="btn">Schließen ✕</button>
    </div>`;
  document.body.appendChild(overlay);

  const data = buildGeoJSON(tracks);
  const stops = eleColorStops(data.minEle, data.maxEle);

  const map = new maplibregl.Map({
    container: 'map3d',
    style: {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {
        sat: { type: 'raster', tiles: [ESRI_SAT], tileSize: 256, maxzoom: 19, attribution: '&copy; Esri, Maxar' },
        osm: { type: 'raster', tiles: [OSM], tileSize: 256, maxzoom: 19, attribution: '&copy; OpenStreetMap' },
        dem: { type: 'raster-dem', tiles: [TERRARIUM], encoding: 'terrarium', tileSize: 256, maxzoom: 14, attribution: '&copy; Mapzen/Tilezen, AWS Terrain Tiles' },
      },
      layers: [
        { id: 'sat', type: 'raster', source: 'sat' },
        { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
        { id: 'hills', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.35 } },
      ],
      terrain: { source: 'dem', exaggeration: 1.5 },
    },
    center: [(boundsOf(tracks)[0][0] + boundsOf(tracks)[1][0]) / 2,
             (boundsOf(tracks)[0][1] + boundsOf(tracks)[1][1]) / 2],
    zoom: 9, pitch: 65, maxPitch: 85, attributionControl: true,
  });
  current = { map, overlay };

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');

  map.on('load', () => {
    map.addSource('track-wall', { type: 'geojson', data: data.wall });
    map.addLayer({
      id: 'track-wall', type: 'fill-extrusion', source: 'track-wall',
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'ele'], ...stops],
        'fill-extrusion-base': 0,
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-opacity': 0.55,
      },
    });
    map.addSource('track-line', { type: 'geojson', data: data.line });
    map.addLayer({
      id: 'track-line', type: 'line', source: 'track-line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 },
    });

    const b = boundsOf(tracks);
    map.fitBounds(b, { padding: 60, duration: 0 });
    map.once('idle', () => map.easeTo({ pitch: 65, duration: 600 }));
  });

  // Legende
  const lg = overlay.querySelector('#m3d-legend');
  if (data.hasEle) lg.innerHTML =
    `<span class="m3d-grad"></span> ${Math.round(data.minEle)} m – ${Math.round(data.maxEle)} m`;

  // Steuerelemente
  overlay.querySelector('#m3d-exag').addEventListener('input', (e) => {
    map.setTerrain({ source: 'dem', exaggeration: parseFloat(e.target.value) });
  });
  overlay.querySelector('#m3d-wall').addEventListener('change', (e) => {
    if (map.getLayer('track-wall'))
      map.setLayoutProperty('track-wall', 'visibility', e.target.checked ? 'visible' : 'none');
  });
  overlay.querySelector('#m3d-base').addEventListener('change', (e) => {
    const sat = e.target.value === 'sat';
    map.setLayoutProperty('sat', 'visibility', sat ? 'visible' : 'none');
    map.setLayoutProperty('osm', 'visibility', sat ? 'none' : 'visible');
  });
  overlay.querySelector('#m3d-close').addEventListener('click', close3D);
  document.addEventListener('keydown', onEsc);
}

function onEsc(e) { if (e.key === 'Escape') close3D(); }

export function close3D() {
  document.removeEventListener('keydown', onEsc);
  if (!current) return;
  try { current.map.remove(); } catch (_) { /* ignore */ }
  current.overlay.remove();
  current = null;
}
