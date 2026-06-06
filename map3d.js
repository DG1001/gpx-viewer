// 3D-Ansicht mit MapLibre GL JS: echtes Gelände (freie Terrain-RGB-Kacheln, kein Key)
// + Flug als schwebende 3D-Linie auf echter Flughöhe (Three.js-Custom-Layer),
//   optional Droplines zum Boden, optional Höhen-„Wand".
// MapLibre & Three.js werden erst beim ersten Öffnen per CDN nachgeladen.

const MAPLIBRE_JS = 'https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.js';
const MAPLIBRE_CSS = 'https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.css';
const THREE_URL = 'https://unpkg.com/three@0.160.0/build/three.module.js';
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

// Höhen-Gradient (blau→grün→rot)
const GRAD = ['#2c7bb6', '#00a6ca', '#a6d96a', '#fdae61', '#d7191c'].map(h => [
  parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255,
]);
function colorAt(t) {
  t = Math.max(0, Math.min(1, t)) * (GRAD.length - 1);
  const i = Math.min(GRAD.length - 2, Math.floor(t)), f = t - i;
  return [
    GRAD[i][0] + (GRAD[i + 1][0] - GRAD[i][0]) * f,
    GRAD[i][1] + (GRAD[i + 1][1] - GRAD[i][1]) * f,
    GRAD[i][2] + (GRAD[i + 1][2] - GRAD[i][2]) * f,
  ];
}
function eleColorStops(min, max) {
  const span = Math.max(1, max - min);
  return [
    min, '#2c7bb6', min + span * 0.25, '#00a6ca',
    min + span * 0.5, '#a6d96a', min + span * 0.75, '#fdae61', max, '#d7191c',
  ];
}

function buildGeoJSON(tracks) {
  const lineFeatures = [], wallFeatures = [];
  let minEle = Infinity, maxEle = -Infinity, hasEle = false;
  for (const t of tracks) {
    lineFeatures.push({ type: 'Feature', properties: { color: t.color }, geometry: { type: 'LineString', coordinates: t.points.map(p => [p.lon, p.lat]) } });
    const pts = t.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (a.ele == null || b.ele == null) continue;
      hasEle = true;
      const el = Math.max(a.ele, b.ele), avg = (a.ele + b.ele) / 2;
      minEle = Math.min(minEle, a.ele, b.ele); maxEle = Math.max(maxEle, a.ele, b.ele);
      const cosLat = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
      const dx = (b.lon - a.lon) * 111320 * cosLat, dy = (b.lat - a.lat) * 111320;
      const len = Math.hypot(dx, dy) || 1, w = 7;
      const ox = (-dy / len) * w / (111320 * cosLat), oy = (dx / len) * w / 111320;
      wallFeatures.push({ type: 'Feature', properties: { ele: avg, height: el }, geometry: { type: 'Polygon', coordinates: [[
        [a.lon + ox, a.lat + oy], [b.lon + ox, b.lat + oy], [b.lon - ox, b.lat - oy], [a.lon - ox, a.lat - oy], [a.lon + ox, a.lat + oy],
      ]] } });
    }
  }
  if (!hasEle) { minEle = 0; maxEle = 1000; }
  return { line: { type: 'FeatureCollection', features: lineFeatures }, wall: { type: 'FeatureCollection', features: wallFeatures }, minEle, maxEle, hasEle };
}

function boundsOf(tracks) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const t of tracks) for (const p of t.points) { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); }
  return [[w, s], [e, n]];
}

// --- Three.js-Custom-Layer (schwebende 3D-Linie) -------------------------------
let THREE = null;
let scene3d = null, origin3d = null;
const flags = { showLine: true, showDrop: false, exag: 1.5 };

function disposeScene() {
  if (!scene3d) return;
  scene3d.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  scene3d = null;
}
function rebuildScene(map, tracks, data) {
  disposeScene();
  const b = boundsOf(tracks);
  origin3d = maplibregl.MercatorCoordinate.fromLngLat([(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], 0);
  const scene = new THREE.Scene();
  const span = Math.max(1, data.maxEle - data.minEle);

  for (const t of tracks) {
    const pos = [], col = [];
    for (const p of t.points) {
      const e = p.ele != null ? p.ele : data.minEle;
      const mc = maplibregl.MercatorCoordinate.fromLngLat([p.lon, p.lat], e * flags.exag);
      pos.push(mc.x - origin3d.x, mc.y - origin3d.y, mc.z - origin3d.z);
      const c = colorAt((e - data.minEle) / span); col.push(c[0], c[1], c[2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true })));
  }

  if (flags.showDrop) {
    const all = []; for (const t of tracks) for (const p of t.points) all.push(p);
    const N = Math.max(1, Math.floor(all.length / 160));
    const pos = [], col = [];
    for (let i = 0; i < all.length; i += N) {
      const p = all[i]; if (p.ele == null) continue;
      const g = map.queryTerrainElevation([p.lon, p.lat], { exaggerated: true });
      if (g == null) continue;
      const top = maplibregl.MercatorCoordinate.fromLngLat([p.lon, p.lat], p.ele * flags.exag);
      const bot = maplibregl.MercatorCoordinate.fromLngLat([p.lon, p.lat], g);
      pos.push(top.x - origin3d.x, top.y - origin3d.y, top.z - origin3d.z);
      pos.push(bot.x - origin3d.x, bot.y - origin3d.y, bot.z - origin3d.z);
      const c = colorAt((p.ele - data.minEle) / span); col.push(c[0], c[1], c[2], c[0], c[1], c[2]);
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35 })));
    }
  }
  scene3d = scene;
}
function makeCustomLayer() {
  return {
    id: 'track-3d', type: 'custom', renderingMode: '3d',
    onAdd(map, gl) {
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      this.renderer.autoClear = false;
      this.camera = new THREE.Camera();
    },
    render(gl, matrix) {
      if (!scene3d || !flags.showLine) return;
      const m = new THREE.Matrix4().fromArray(matrix);
      const tr = new THREE.Matrix4().makeTranslation(origin3d.x, origin3d.y, origin3d.z);
      this.camera.projectionMatrix = m.multiply(tr);
      this.renderer.resetState();
      this.renderer.render(scene3d, this.camera);
    },
  };
}

let current = null; // { map, overlay }

export async function open3D(tracks) {
  await loadMapLibre();
  if (current) close3D();
  flags.showLine = true; flags.showDrop = false; flags.exag = 1.5;

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
      <label class="m3d-ctl"><input id="m3d-line" type="checkbox" checked /> 3D-Linie</label>
      <label class="m3d-ctl"><input id="m3d-drop" type="checkbox" /> Droplines</label>
      <label class="m3d-ctl"><input id="m3d-wall" type="checkbox" /> Höhen-Wand</label>
      <span class="m3d-legend" id="m3d-legend"></span>
      <button id="m3d-close" class="btn">Schließen ✕</button>
    </div>`;
  document.body.appendChild(overlay);

  const data = buildGeoJSON(tracks);
  const stops = eleColorStops(data.minEle, data.maxEle);
  const ctr = boundsOf(tracks);

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
      terrain: { source: 'dem', exaggeration: flags.exag },
    },
    center: [(ctr[0][0] + ctr[1][0]) / 2, (ctr[0][1] + ctr[1][1]) / 2],
    zoom: 9, pitch: 65, maxPitch: 85, attributionControl: true,
  });
  current = { map, overlay };
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');

  map.on('load', async () => {
    map.addSource('track-wall', { type: 'geojson', data: data.wall });
    map.addLayer({
      id: 'track-wall', type: 'fill-extrusion', source: 'track-wall',
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'ele'], ...stops],
        'fill-extrusion-base': 0,
        // gleiche Überhöhung wie Terrain & 3D-Linie, damit Wand-Oberkante = Flugbahn
        'fill-extrusion-height': ['*', ['get', 'height'], flags.exag],
        'fill-extrusion-opacity': 0.5,
      },
    });
    map.addSource('track-line', { type: 'geojson', data: data.line });
    map.addLayer({
      id: 'track-line', type: 'line', source: 'track-line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.5 },
    });

    map.fitBounds(boundsOf(tracks), { padding: 60, duration: 0 });
    map.once('idle', () => map.easeTo({ pitch: 65, duration: 600 }));

    // Three.js-Custom-Layer für die schwebende 3D-Linie
    try {
      if (!THREE) THREE = await import(THREE_URL);
      rebuildScene(map, tracks, data);
      if (!map.getLayer('track-3d')) map.addLayer(makeCustomLayer());
      map.triggerRepaint();
    } catch (e) {
      console.warn('3D-Linie (Three.js) nicht verfügbar:', e);
    }
  });

  const lg = overlay.querySelector('#m3d-legend');
  if (data.hasEle) lg.innerHTML = `<span class="m3d-grad"></span> ${Math.round(data.minEle)} m – ${Math.round(data.maxEle)} m`;

  overlay.querySelector('#m3d-exag').addEventListener('input', (e) => {
    flags.exag = parseFloat(e.target.value);
    map.setTerrain({ source: 'dem', exaggeration: flags.exag });
    if (map.getLayer('track-wall'))
      map.setPaintProperty('track-wall', 'fill-extrusion-height', ['*', ['get', 'height'], flags.exag]);
    if (scene3d) { rebuildScene(map, tracks, data); map.triggerRepaint(); }
  });
  overlay.querySelector('#m3d-line').addEventListener('change', (e) => { flags.showLine = e.target.checked; map.triggerRepaint(); });
  overlay.querySelector('#m3d-drop').addEventListener('change', (e) => {
    flags.showDrop = e.target.checked;
    if (scene3d) { rebuildScene(map, tracks, data); map.triggerRepaint(); }
  });
  overlay.querySelector('#m3d-wall').addEventListener('change', (e) => {
    if (map.getLayer('track-wall')) map.setLayoutProperty('track-wall', 'visibility', e.target.checked ? 'visible' : 'none');
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
  disposeScene();
  try { current.map.remove(); } catch (_) { /* ignore */ }
  current.overlay.remove();
  current = null;
}
