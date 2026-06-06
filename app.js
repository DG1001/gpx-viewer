// GPX Viewer – reine clientseitige PWA. Keine Build-Tools, keine externen Parser.
// Module: app.js

const COLORS = [
  '#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa',
  '#00acc1', '#fdd835', '#6d4c41', '#d81b60', '#3949ab',
];

const state = {
  tracks: [],            // { id, name, color, visible, points[], stats }
  nextId: 1,
  colorMode: 'track',    // 'track' | 'ele' | 'climb'
  profileMetric: 'ele',  // 'ele' | 'speed' | 'vario'
  hover: null,           // { trackId, index } | null
};

let map, hoverMarkers = {};   // trackId -> L.marker
const layerRefs = {};         // trackId -> { line, segs[], start, end }

// ---------------------------------------------------------------------------
// Geometrie / Helfer
// ---------------------------------------------------------------------------
const R = 6371000; // Erdradius (m)
function haversine(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function fmtDuration(sec) {
  if (!isFinite(sec) || sec <= 0) return '–';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
              : `${m}:${String(s).padStart(2, '0')} min`;
}
function fmtDist(m) {
  if (!isFinite(m)) return '–';
  return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
}
function fmtTime(d) {
  if (!d) return '–';
  return d.toLocaleString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---------------------------------------------------------------------------
// Parser: GPX
// ---------------------------------------------------------------------------
function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('GPX ist kein gültiges XML.');

  const tracks = [];
  // Pro <trk> (und <trkseg>) ein Track; auch <rte> als Fallback.
  const trks = doc.getElementsByTagName('trk');
  for (const trk of trks) {
    const name = (trk.getElementsByTagName('name')[0]?.textContent || '').trim();
    const pts = [];
    for (const pt of trk.getElementsByTagName('trkpt')) pushPt(pts, pt);
    if (pts.length) tracks.push({ name, points: pts });
  }
  if (!tracks.length) {
    // Routen / lose Waypoints
    const pts = [];
    for (const pt of doc.getElementsByTagName('rtept')) pushPt(pts, pt);
    if (pts.length) tracks.push({ name: '', points: pts });
  }
  if (!tracks.length) throw new Error('Keine Track-Punkte (<trkpt>) in der GPX gefunden.');
  return tracks;

  function pushPt(arr, el) {
    const lat = parseFloat(el.getAttribute('lat'));
    const lon = parseFloat(el.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return;
    const eleEl = el.getElementsByTagName('ele')[0];
    const timeEl = el.getElementsByTagName('time')[0];
    const ele = eleEl ? parseFloat(eleEl.textContent) : null;
    const time = timeEl ? new Date(timeEl.textContent.trim()) : null;
    arr.push({ lat, lon, ele: isFinite(ele) ? ele : null, time: (time && !isNaN(time)) ? time : null });
  }
}

// ---------------------------------------------------------------------------
// Parser: IGC (optional – Segelflug). B-Records.
// B HHMMSS DDMMmmm N DDDMMmmm E V PPPPP GGGGG
// ---------------------------------------------------------------------------
function parseIGC(text) {
  const lines = text.split(/\r?\n/);
  const pts = [];
  let dateUTC = null, name = '';
  for (const line of lines) {
    if (line.startsWith('HFDTE')) {
      const m = line.match(/(\d{2})(\d{2})(\d{2})/);
      if (m) dateUTC = { d: +m[1], mo: +m[2], y: 2000 + +m[3] };
    } else if (line.startsWith('HFGIDGLIDERID') || line.startsWith('HFGTYGLIDERTYPE')) {
      const v = line.split(':')[1];
      if (v && v.trim()) name = (name ? name + ' ' : '') + v.trim();
    } else if (line[0] === 'B' && line.length >= 35) {
      const hh = +line.substr(1, 2), mm = +line.substr(3, 2), ss = +line.substr(5, 2);
      const lat = igcCoord(line.substr(7, 7), line[14], 2);
      const lon = igcCoord(line.substr(15, 8), line[23], 3);
      const pressAlt = +line.substr(25, 5);
      const gpsAlt = +line.substr(30, 5);
      if (lat == null || lon == null) continue;
      let time = null;
      if (dateUTC) {
        time = new Date(Date.UTC(dateUTC.y, dateUTC.mo - 1, dateUTC.d, hh, mm, ss));
        // Mitternachts-Überlauf
        if (pts.length && time < pts[pts.length - 1].time) time = new Date(time.getTime() + 86400000);
      }
      const ele = isFinite(gpsAlt) && gpsAlt !== 0 ? gpsAlt : (isFinite(pressAlt) ? pressAlt : null);
      pts.push({ lat, lon, ele, time });
    }
  }
  if (!pts.length) throw new Error('Keine B-Records in der IGC-Datei gefunden.');
  return [{ name, points: pts }];

  function igcCoord(digits, hemi, degLen) {
    if (!/^\d+$/.test(digits)) return null;
    const deg = +digits.substr(0, degLen);
    const min = +digits.substr(degLen) / 1000; // MMmmm -> Minuten mit 3 Nachkommastellen
    let v = deg + min / 60;
    if (hemi === 'S' || hemi === 'W') v = -v;
    return v;
  }
}

// ---------------------------------------------------------------------------
// Ableitungen / Statistik
// ---------------------------------------------------------------------------
function enrich(points) {
  let cum = 0;
  points[0].dist = 0;
  for (let i = 1; i < points.length; i++) {
    cum += haversine(points[i - 1], points[i]);
    points[i].dist = cum;
  }
  // Geschwindigkeit & Vario (Steigen, m/s) zwischen Punkten
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i === 0) { p.speed = 0; p.vario = 0; continue; }
    const a = points[i - 1];
    const dt = (a.time && p.time) ? (p.time - a.time) / 1000 : null;
    const dd = p.dist - a.dist;
    p.speed = dt && dt > 0 ? (dd / dt) * 3.6 : null; // km/h
    p.vario = (dt && dt > 0 && a.ele != null && p.ele != null) ? (p.ele - a.ele) / dt : null; // m/s
  }
  // leichte Glättung der Geschwindigkeit (gleitender 5-Punkt-Median wäre besser; hier Mittel)
  return points;
}

function computeStats(points) {
  const s = {
    count: points.length,
    dist: points[points.length - 1].dist,
    start: points[0].time, end: points[points.length - 1].time,
    duration: null, maxSpeed: 0, avgSpeed: null,
    eleGain: 0, maxEle: -Infinity, minEle: Infinity, hasEle: false, hasTime: false,
  };
  if (s.start && s.end) { s.duration = (s.end - s.start) / 1000; s.hasTime = true; }
  let prevEle = null;
  for (const p of points) {
    if (p.ele != null) {
      s.hasEle = true;
      s.maxEle = Math.max(s.maxEle, p.ele);
      s.minEle = Math.min(s.minEle, p.ele);
      if (prevEle != null && p.ele > prevEle) s.eleGain += p.ele - prevEle;
      prevEle = p.ele;
    }
    if (p.speed != null) s.maxSpeed = Math.max(s.maxSpeed, p.speed);
  }
  if (s.duration && s.duration > 0) s.avgSpeed = (s.dist / s.duration) * 3.6;
  if (!s.hasEle) { s.maxEle = null; s.minEle = null; s.eleGain = null; }
  return s;
}

// ---------------------------------------------------------------------------
// Track hinzufügen
// ---------------------------------------------------------------------------
function addTrack(rawName, points, fileName) {
  enrich(points);
  const stats = computeStats(points);
  const color = COLORS[(state.nextId - 1) % COLORS.length];
  const track = {
    id: state.nextId++,
    name: rawName || fileName || `Track ${state.nextId}`,
    fileName,
    color, visible: true, points, stats,
  };
  state.tracks.push(track);
  drawTrackOnMap(track);
  renderTrackList();
  renderStats();
  drawProfile();
  fitAll();
  hideEmptyState();
}

// ---------------------------------------------------------------------------
// Karte (Leaflet)
// ---------------------------------------------------------------------------
function initMap() {
  map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([47.5, 9.5], 7);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap-Mitwirkende',
    crossOrigin: true,
  }).addTo(map);
}

function colorForPoint(track, i) {
  const p = track.points[i];
  if (state.colorMode === 'ele' && p.ele != null && track.stats.hasEle) {
    const t = (p.ele - track.stats.minEle) / Math.max(1, track.stats.maxEle - track.stats.minEle);
    return gradient(t); // blau->rot
  }
  if (state.colorMode === 'climb' && p.vario != null) {
    const t = Math.max(0, Math.min(1, (p.vario + 3) / 6)); // -3..+3 m/s
    return gradient(t);
  }
  return track.color;
}
function gradient(t) {
  t = Math.max(0, Math.min(1, t));
  const r = Math.round(255 * t), b = Math.round(255 * (1 - t)), g = Math.round(120 * (1 - Math.abs(t - 0.5) * 2));
  return `rgb(${r},${g},${b})`;
}

function drawTrackOnMap(track) {
  const latlngs = track.points.map(p => [p.lat, p.lon]);
  const refs = { segs: [], line: null, start: null, end: null };

  if (state.colorMode === 'track') {
    refs.line = L.polyline(latlngs, { color: track.color, weight: 3, opacity: .9 }).addTo(map);
    bindPolylineHover(refs.line, track);
  } else {
    // Pro Segment eigene Farbe (Gradient nach Höhe/Steigen)
    for (let i = 1; i < track.points.length; i++) {
      const seg = L.polyline([latlngs[i - 1], latlngs[i]],
        { color: colorForPoint(track, i), weight: 3, opacity: .9 }).addTo(map);
      bindPolylineHover(seg, track, i);
      refs.segs.push(seg);
    }
  }
  refs.start = L.circleMarker(latlngs[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#2e7d32', fillOpacity: 1 })
    .addTo(map).bindTooltip(`Start: ${track.name}`);
  refs.end = L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: '#fff', weight: 2, fillColor: '#c62828', fillOpacity: 1 })
    .addTo(map).bindTooltip(`Ende: ${track.name}`);

  layerRefs[track.id] = refs;
}

function bindPolylineHover(layer, track, fixedIndex) {
  layer.on('mousemove', (e) => {
    const idx = fixedIndex != null ? fixedIndex : nearestIndexToLatLng(track, e.latlng);
    setHover(track.id, idx, false);
  });
  layer.on('mouseout', () => clearHover());
}

function nearestIndexToLatLng(track, latlng) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < track.points.length; i++) {
    const p = track.points[i];
    const d = (p.lat - latlng.lat) ** 2 + (p.lon - latlng.lng) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function removeTrackLayers(id) {
  const r = layerRefs[id];
  if (!r) return;
  r.line && map.removeLayer(r.line);
  r.segs.forEach(s => map.removeLayer(s));
  r.start && map.removeLayer(r.start);
  r.end && map.removeLayer(r.end);
  delete layerRefs[id];
  if (hoverMarkers[id]) { map.removeLayer(hoverMarkers[id]); delete hoverMarkers[id]; }
}

function redrawAllLayers() {
  for (const t of state.tracks) {
    removeTrackLayers(t.id);
    if (t.visible) drawTrackOnMap(t);
  }
}

function fitAll() {
  const visible = state.tracks.filter(t => t.visible);
  if (!visible.length) return;
  let bounds = null;
  for (const t of visible) {
    const b = L.latLngBounds(t.points.map(p => [p.lat, p.lon]));
    bounds = bounds ? bounds.extend(b) : b;
  }
  if (bounds) map.fitBounds(bounds, { padding: [30, 30] });
}

// ---------------------------------------------------------------------------
// Höhen-/Speed-Profil (selbst gezeichnetes Canvas)
// ---------------------------------------------------------------------------
const canvas = document.getElementById('profile');
const ctx = canvas.getContext('2d');
let plot = null; // { x0,y0,w,h, dMax, vMin, vMax, metric }

function metricValue(p) {
  if (state.profileMetric === 'speed') return p.speed;
  if (state.profileMetric === 'vario') return p.vario;
  return p.ele;
}
function metricLabel() {
  return state.profileMetric === 'speed' ? 'km/h'
       : state.profileMetric === 'vario' ? 'm/s' : 'm';
}

function drawProfile() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = Math.max(1, rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const visible = state.tracks.filter(t => t.visible);
  const padL = 46, padR = 12, padT = 10, padB = 22;
  const w = rect.width - padL - padR, h = rect.height - padT - padB;
  if (w <= 0 || h <= 0) return;

  if (!visible.length) {
    ctx.fillStyle = '#9aa5b1'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('Kein sichtbarer Track', rect.width / 2, rect.height / 2);
    plot = null; return;
  }

  let dMax = 0, vMin = Infinity, vMax = -Infinity, any = false;
  for (const t of visible) {
    dMax = Math.max(dMax, t.stats.dist);
    for (const p of t.points) {
      const v = metricValue(p);
      if (v == null || !isFinite(v)) continue;
      any = true; vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
    }
  }
  if (!any) {
    ctx.fillStyle = '#9aa5b1'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('Keine Daten für „' + metricLabel() + '" vorhanden', rect.width / 2, rect.height / 2);
    plot = null; return;
  }
  if (vMin === vMax) { vMin -= 1; vMax += 1; }
  const padV = (vMax - vMin) * 0.08; vMin -= padV; vMax += padV;
  if (state.profileMetric === 'vario') { const m = Math.max(Math.abs(vMin), Math.abs(vMax)); vMin = -m; vMax = m; }

  plot = { x0: padL, y0: padT, w, h, dMax, vMin, vMax };
  const xOf = d => padL + (dMax ? d / dMax * w : 0);
  const yOf = v => padT + (1 - (v - vMin) / (vMax - vMin)) * h;

  // Gitter + Achsen
  ctx.strokeStyle = '#eceff3'; ctx.fillStyle = '#9aa5b1'; ctx.font = '11px system-ui';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = vMin + (vMax - vMin) * i / yTicks;
    const y = yOf(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke();
    ctx.fillText(v.toFixed(state.profileMetric === 'vario' ? 1 : 0), padL - 5, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const d = dMax * i / xTicks; const x = xOf(d);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + h); ctx.strokeStyle = '#f4f6f9'; ctx.stroke();
    ctx.fillText(fmtDist(d), x, padT + h + 4);
  }

  // Null-Linie bei Vario
  if (state.profileMetric === 'vario') {
    ctx.strokeStyle = '#cfd6de'; ctx.beginPath(); ctx.moveTo(padL, yOf(0)); ctx.lineTo(padL + w, yOf(0)); ctx.stroke();
  }

  // Linien je Track
  for (const t of visible) {
    ctx.beginPath();
    let started = false;
    for (const p of t.points) {
      const v = metricValue(p);
      if (v == null || !isFinite(v)) { started = false; continue; }
      const x = xOf(p.dist), y = yOf(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = t.color; ctx.lineWidth = 1.6; ctx.stroke();
  }

  // Y-Achsen-Beschriftung
  ctx.save();
  ctx.translate(12, padT + h / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#6b7785';
  ctx.fillText(metricLabel(), 0, 0);
  ctx.restore();

  drawHoverCursor();
}

function drawHoverCursor() {
  if (!plot || !state.hover) return;
  const track = state.tracks.find(t => t.id === state.hover.trackId);
  if (!track || !track.visible) return;
  const p = track.points[state.hover.index];
  if (!p) return;
  const x = plot.x0 + (plot.dMax ? p.dist / plot.dMax * plot.w : 0);
  ctx.strokeStyle = 'rgba(30,136,229,.6)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, plot.y0); ctx.lineTo(x, plot.y0 + plot.h); ctx.stroke();
  const v = metricValue(p);
  if (v != null && isFinite(v)) {
    const y = plot.y0 + (1 - (v - plot.vMin) / (plot.vMax - plot.vMin)) * plot.h;
    ctx.fillStyle = track.color; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  }
}

// Hover auf dem Profil
canvas.addEventListener('mousemove', (e) => {
  if (!plot) return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const dist = plot.dMax * Math.max(0, Math.min(1, (px - plot.x0) / plot.w));
  // nächstgelegenen Track + Index zur Distanz finden (bevorzugt längster sichtbarer Track)
  const visible = state.tracks.filter(t => t.visible);
  if (!visible.length) return;
  let target = visible.reduce((a, b) => (b.stats.dist >= a.stats.dist ? b : a));
  const idx = nearestIndexToDist(target, dist);
  setHover(target.id, idx, true);
});
canvas.addEventListener('mouseleave', () => clearHover());

function nearestIndexToDist(track, dist) {
  // binäre Suche
  const pts = track.points;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].dist < dist) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(pts[lo - 1].dist - dist) < Math.abs(pts[lo].dist - dist)) lo--;
  return lo;
}

// ---------------------------------------------------------------------------
// Hover-Synchronisation
// ---------------------------------------------------------------------------
function setHover(trackId, index, fromProfile) {
  state.hover = { trackId, index };
  // Marker auf Karte für ALLE sichtbaren Tracks an gleicher Distanz, Hauptmarker auf trackId
  const main = state.tracks.find(t => t.id === trackId);
  if (!main) return;
  const dist = main.points[index].dist;
  for (const t of state.tracks) {
    if (!t.visible) { if (hoverMarkers[t.id]) { map.removeLayer(hoverMarkers[t.id]); delete hoverMarkers[t.id]; } continue; }
    const i = t.id === trackId ? index : nearestIndexToDist(t, dist);
    const p = t.points[i];
    const ll = [p.lat, p.lon];
    if (!hoverMarkers[t.id]) {
      hoverMarkers[t.id] = L.marker(ll, {
        icon: L.divIcon({ className: '', html: `<div class="hover-dot" style="border-color:${t.color}"></div>`, iconSize: [14, 14] }),
        interactive: false, keyboard: false,
      }).addTo(map);
    } else {
      hoverMarkers[t.id].setLatLng(ll);
    }
  }
  updateReadout(main, index);
  if (fromProfile) { drawProfile(); } else { drawProfile(); }
}

function clearHover() {
  state.hover = null;
  for (const id in hoverMarkers) { map.removeLayer(hoverMarkers[id]); delete hoverMarkers[id]; }
  document.getElementById('hover-readout').textContent = '';
  drawProfile();
}

function updateReadout(track, index) {
  const p = track.points[index];
  const parts = [fmtDist(p.dist)];
  if (p.ele != null) parts.push(Math.round(p.ele) + ' m');
  if (p.speed != null) parts.push(p.speed.toFixed(0) + ' km/h');
  if (p.vario != null) parts.push((p.vario >= 0 ? '+' : '') + p.vario.toFixed(1) + ' m/s');
  if (p.time) parts.push(fmtTime(p.time));
  document.getElementById('hover-readout').textContent = parts.join(' · ');
}

// ---------------------------------------------------------------------------
// UI: Track-Liste & Statistik
// ---------------------------------------------------------------------------
function renderTrackList() {
  const ul = document.getElementById('track-list');
  ul.innerHTML = '';
  document.getElementById('empty-hint').style.display = state.tracks.length ? 'none' : 'block';
  for (const t of state.tracks) {
    const li = document.createElement('li');
    li.className = 'track-item' + (t.visible ? '' : ' hidden-track');

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = t.visible; cb.title = 'Sichtbarkeit';
    cb.addEventListener('change', () => toggleVisible(t.id, cb.checked));

    const sw = document.createElement('input');
    sw.type = 'color'; sw.value = rgbToHex(t.color); sw.className = 'swatch'; sw.title = 'Farbe ändern';
    sw.addEventListener('input', () => { t.color = sw.value; redrawAllLayers(); renderTrackList(); renderStats(); drawProfile(); });

    const name = document.createElement('div');
    name.className = 'tname';
    name.innerHTML = `${escapeHtml(t.name)}<small>${fmtDist(t.stats.dist)} · ${fmtDuration(t.stats.duration)}</small>`;

    const zoom = document.createElement('button');
    zoom.textContent = '⤢'; zoom.title = 'Zu diesem Track zoomen';
    zoom.addEventListener('click', () => { const b = L.latLngBounds(t.points.map(p => [p.lat, p.lon])); map.fitBounds(b, { padding: [30, 30] }); });

    const del = document.createElement('button');
    del.textContent = '✕'; del.title = 'Entfernen';
    del.addEventListener('click', () => removeTrack(t.id));

    li.append(cb, sw, name, zoom, del);
    ul.appendChild(li);
  }
}

function renderStats() {
  const panel = document.getElementById('stats-panel');
  panel.innerHTML = '';
  for (const t of state.tracks) {
    if (!t.visible) continue;
    const s = t.stats;
    const card = document.createElement('div');
    card.className = 'stats-card';
    card.innerHTML = `
      <h3><span class="dot" style="background:${t.color}"></span>${escapeHtml(t.name)}</h3>
      <dl class="stats-grid">
        <dt>Dauer</dt><dd>${fmtDuration(s.duration)}</dd>
        <dt>Strecke (2D)</dt><dd>${fmtDist(s.dist)}</dd>
        <dt>Ø Geschw.</dt><dd>${s.avgSpeed != null ? s.avgSpeed.toFixed(1) + ' km/h' : '–'}</dd>
        <dt>max. Geschw.</dt><dd>${s.maxSpeed ? s.maxSpeed.toFixed(1) + ' km/h' : '–'}</dd>
        <dt>Höhengewinn</dt><dd>${s.eleGain != null ? Math.round(s.eleGain) + ' m' : '–'}</dd>
        <dt>max. Höhe</dt><dd>${s.maxEle != null ? Math.round(s.maxEle) + ' m' : '–'}</dd>
        <dt>min. Höhe</dt><dd>${s.minEle != null ? Math.round(s.minEle) + ' m' : '–'}</dd>
        <dt>Start</dt><dd>${fmtTime(s.start)}</dd>
        <dt>Ende</dt><dd>${fmtTime(s.end)}</dd>
      </dl>`;
    panel.appendChild(card);
  }
}

function toggleVisible(id, vis) {
  const t = state.tracks.find(x => x.id === id);
  if (!t) return;
  t.visible = vis;
  if (vis) drawTrackOnMap(t); else removeTrackLayers(id);
  renderTrackList(); renderStats(); drawProfile();
}

function removeTrack(id) {
  removeTrackLayers(id);
  state.tracks = state.tracks.filter(t => t.id !== id);
  renderTrackList(); renderStats(); drawProfile();
  if (!state.tracks.length) showEmptyState();
}

// ---------------------------------------------------------------------------
// Datei-Handling
// ---------------------------------------------------------------------------
async function loadFile(file) {
  try {
    const text = await file.text();
    const lower = file.name.toLowerCase();
    let parsed;
    if (lower.endsWith('.igc')) parsed = parseIGC(text);
    else if (lower.endsWith('.gpx') || text.includes('<gpx')) parsed = parseGPX(text);
    else if (/^A[A-Z0-9]/.test(text) || /\nB\d{6}/.test(text)) parsed = parseIGC(text);
    else parsed = parseGPX(text);

    let n = 0;
    parsed.forEach((trk, i) => {
      const nm = trk.name || (parsed.length > 1 ? `${file.name} #${i + 1}` : file.name);
      addTrack(nm, trk.points, file.name);
      n++;
    });
    toast(`„${file.name}" geladen (${n} Track${n > 1 ? 's' : ''}).`);
  } catch (err) {
    console.warn('Ladefehler', err);
    toast(`Fehler bei „${file.name}": ${err.message}`, true);
  }
}

async function loadFiles(fileList) {
  for (const f of fileList) await loadFile(f);
}

// File Handling API (Doppelklick in Windows)
if ('launchQueue' in window && 'LaunchParams' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files || !params.files.length) return;
    for (const handle of params.files) {
      try {
        const file = await handle.getFile();
        await loadFile(file);
      } catch (err) {
        toast('Konnte übergebene Datei nicht öffnen: ' + err.message, true);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Drag & Drop / Buttons
// ---------------------------------------------------------------------------
function initUI() {
  const fileInput = document.getElementById('file-input');
  document.getElementById('open-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { loadFiles(fileInput.files); fileInput.value = ''; });
  document.getElementById('fit-btn').addEventListener('click', fitAll);

  document.getElementById('colormode').addEventListener('change', (e) => {
    state.colorMode = e.target.value; redrawAllLayers();
  });
  document.querySelectorAll('input[name=profmetric]').forEach(r => {
    r.addEventListener('change', () => { state.profileMetric = document.querySelector('input[name=profmetric]:checked').value; drawProfile(); });
  });

  const dz = document.getElementById('dropzone');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dz.classList.add('dragging'); });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; if (!state.tracks.length) {} dz.classList.remove('dragging'); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; dz.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) loadFiles(files);
  });

  window.addEventListener('resize', () => drawProfile());

  if (!state.tracks.length) showEmptyState();
}

function showEmptyState() { document.getElementById('dropzone').classList.add('empty-state'); }
function hideEmptyState() { document.getElementById('dropzone').classList.remove('empty-state'); }

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 5000 : 2800);
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function rgbToHex(c) {
  if (c[0] === '#') return c;
  const m = c.match(/\d+/g); if (!m) return '#1e88e5';
  return '#' + m.slice(0, 3).map(n => (+n).toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Service Worker
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW-Registrierung fehlgeschlagen', err));
  });
}

// ---------------------------------------------------------------------------
// Start (nach Leaflet-Laden)
// ---------------------------------------------------------------------------
function boot() {
  if (typeof L === 'undefined') { setTimeout(boot, 50); return; }
  initMap();
  initUI();
  drawProfile();
}
boot();
