// GPX Viewer – reine clientseitige PWA. Keine Build-Tools, keine externen Parser.
// Module: app.js
import { open3D } from './map3d.js';

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
  showThermals: true,    // Thermik-Marker & Wind anzeigen
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
function fmtMinSec(sec) {
  if (!isFinite(sec)) return '–';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Kurs (Bearing) zwischen zwei Punkten, -180..180 (0 = Nord)
function bearing(a, b) {
  const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
  const Δλ = (b.lon - a.lon) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.atan2(y, x) * 180 / Math.PI;
}
function angDiff(a, b) { let d = b - a; while (d > 180) d -= 360; while (d < -180) d += 360; return d; }
function compass(deg) {
  const dirs = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
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
  // Geschwindigkeit, Vario, Kurs & Drehrate zwischen Punkten
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (i === 0) { p.speed = 0; p.vario = 0; p.bearing = null; p.turnRate = null; continue; }
    const a = points[i - 1];
    const dt = (a.time && p.time) ? (p.time - a.time) / 1000 : null;
    const dd = p.dist - a.dist;
    p.speed = dt && dt > 0 ? (dd / dt) * 3.6 : null; // km/h
    p.vario = (dt && dt > 0 && a.ele != null && p.ele != null) ? (p.ele - a.ele) / dt : null; // m/s
    p.bearing = bearing(a, p);
    p.turnRate = (a.bearing != null && dt && dt > 0) ? angDiff(a.bearing, p.bearing) / dt : null; // °/s
  }
  // Vario über ~±3.5 s glätten (barometrisches/GPS-Rauschen dämpfen)
  for (let i = 0; i < n; i++) {
    if (points[i].vario == null || !points[i].time) { points[i].varioSmooth = points[i].vario; continue; }
    let sum = 0, c = 0;
    for (let j = i; j >= 0 && points[j].time && (points[i].time - points[j].time) / 1000 <= 3.5; j--)
      if (points[j].vario != null) { sum += points[j].vario; c++; }
    for (let j = i + 1; j < n && points[j].time && (points[j].time - points[i].time) / 1000 <= 3.5; j++)
      if (points[j].vario != null) { sum += points[j].vario; c++; }
    points[i].varioSmooth = c ? sum / c : points[i].vario;
  }
  return points;
}

// ---------------------------------------------------------------------------
// Segelflug-Analyse: Thermik-Erkennung, Wind aus Kreisdrift, Gleitzahl
// ---------------------------------------------------------------------------
const TURN_THRESH = 6;   // °/s – ab hier gilt es als Kreisen
const MIN_THERMAL = 25;  // s – kürzere Kreis-Phasen zählen nicht als Bart
const GAP_BRIDGE = 8;    // s – kurze Geradeaus-Lücken im Bart überbrücken

function analyzeSoaring(points) {
  const res = {
    hasTime: false, thermals: [], circlingTime: 0, glidingTime: 0,
    thermalGain: 0, avgClimb: null, bestClimb: null, best30: null,
    glideRatio: null, glideDist: 0, glideLoss: 0, wind: null,
  };
  const n = points.length;
  if (n < 3 || !(points[0].time && points[n - 1].time)) return res;
  res.hasTime = true;

  // geglättete Drehrate
  for (let i = 0; i < n; i++) {
    let sum = 0, c = 0;
    for (let k = -2; k <= 2; k++) { const j = i + k; if (j > 0 && j < n && points[j].turnRate != null) { sum += points[j].turnRate; c++; } }
    points[i]._tr = c ? sum / c : 0;
    points[i].circling = Math.abs(points[i]._tr) > TURN_THRESH;
  }

  // Kreis-Phasen gruppieren (kurze Lücken überbrücken)
  const segs = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    if (points[i].circling) {
      if (!cur) cur = { start: i, end: i }; else cur.end = i;
    } else if (cur && points[i].time && points[cur.end].time &&
               (points[i].time - points[cur.end].time) / 1000 > GAP_BRIDGE) {
      segs.push(cur); cur = null;
    }
  }
  if (cur) segs.push(cur);

  let sumDx = 0, sumDy = 0, sumDur = 0;
  for (const seg of segs) {
    const s = points[seg.start], e = points[seg.end];
    if (!s.time || !e.time) continue;
    const dur = (e.time - s.time) / 1000;
    if (dur < MIN_THERMAL) continue;
    let la = 0, lo = 0, c = 0;
    for (let j = seg.start; j <= seg.end; j++) { la += points[j].lat; lo += points[j].lon; c++; points[j].thermal = true; }
    const center = [la / c, lo / c];
    const gain = (s.ele != null && e.ele != null) ? e.ele - s.ele : null;
    const climb = gain != null && dur > 0 ? gain / dur : null;
    // Wind aus Drift: Nettoversatz des Kreisflugs / Dauer (über viele Kreise mittelt sich die Airspeed weg)
    const cosLat = Math.cos(center[0] * Math.PI / 180);
    const dx = (e.lon - s.lon) * cosLat * 111320; // Ost (m)
    const dy = (e.lat - s.lat) * 111320;           // Nord (m)
    sumDx += dx; sumDy += dy; sumDur += dur;
    res.thermals.push({ center, dur, gain, climb, entry: s.ele, exit: e.ele, startTime: s.time, startDist: s.dist, endDist: e.dist });
    res.circlingTime += dur;
    if (gain != null && gain > 0) res.thermalGain += gain;
  }

  if (res.thermals.length) {
    const valid = res.thermals.filter(t => t.climb != null);
    if (valid.length) {
      res.avgClimb = res.circlingTime > 0 ? valid.reduce((a, t) => a + (t.gain || 0), 0) / res.circlingTime : null;
      res.bestClimb = Math.max(...valid.map(t => t.climb));
    }
  }
  if (sumDur > 0 && (Math.abs(sumDx) + Math.abs(sumDy)) > 0) {
    const wE = sumDx / sumDur, wN = sumDy / sumDur;        // Drift = downwind
    const speed = Math.hypot(wE, wN);                       // m/s
    const from = (Math.atan2(wE, wN) * 180 / Math.PI + 180 + 360) % 360; // Wind kommt aus …
    res.wind = { speed, from };
  }

  // Gleit-Anteil & Gleitzahl (nur Geradeaus-Phasen mit Höhenverlust)
  const totalDur = (points[n - 1].time - points[0].time) / 1000;
  res.glidingTime = Math.max(0, totalDur - res.circlingTime);
  for (let i = 1; i < n; i++) {
    if (points[i].thermal || points[i - 1].thermal) continue;
    const dd = points[i].dist - points[i - 1].dist;
    res.glideDist += dd;
    if (points[i].ele != null && points[i - 1].ele != null && points[i].ele < points[i - 1].ele)
      res.glideLoss += points[i - 1].ele - points[i].ele;
  }
  if (res.glideLoss > 0) res.glideRatio = res.glideDist / res.glideLoss;

  // bestes 30-s-Steigen (Zwei-Zeiger-Fenster)
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (!points[i].time || points[i].ele == null) continue;
    while (j < n && points[j].time && (points[j].time - points[i].time) / 1000 < 30) j++;
    if (j < n && points[j].time && points[j].ele != null) {
      const dt = (points[j].time - points[i].time) / 1000;
      if (dt > 0) { const cl = (points[j].ele - points[i].ele) / dt; if (res.best30 == null || cl > res.best30) res.best30 = cl; }
    }
  }
  return res;
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
  const soaring = analyzeSoaring(points);
  const color = COLORS[(state.nextId - 1) % COLORS.length];
  const track = {
    id: state.nextId++,
    name: rawName || fileName || `Track ${state.nextId}`,
    fileName,
    color, visible: true, points, stats, soaring,
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
let airspaceGroup = null;
let airspaceLoaded = false;

function initMap() {
  map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([47.5, 9.5], 7);

  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap-Mitwirkende', crossOrigin: true,
  });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, attribution: 'Karten: &copy; OpenTopoMap (CC-BY-SA), Daten: &copy; OpenStreetMap', crossOrigin: true,
  });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Luftbild: &copy; Esri, Maxar, Earthstar Geographics', crossOrigin: true,
  });
  osm.addTo(map);

  // Luftraum (DAeC, OpenAir) – kostenlos & ohne Key, als Vektor-Overlay.
  // Lazy: wird erst beim Einschalten geladen.
  airspaceGroup = L.layerGroup();

  L.control.layers(
    { 'OpenStreetMap': osm, 'OpenTopoMap': topo, 'Satellit (Esri)': sat },
    { 'Luftraum (DAeC)': airspaceGroup },
    { collapsed: true }
  ).addTo(map);

  map.on('overlayadd', (e) => { if (e.layer === airspaceGroup) loadAirspaceFromBundle(); });

  initWindControl();
}

// ---------------------------------------------------------------------------
// Luftraum: OpenAir-Parser (DP-Polygone, DC-Kreise, DB-Bögen) → Leaflet
// ---------------------------------------------------------------------------
function parseDMS(tok) {
  const m = tok.match(/([\d.]+):([\d.]+)(?::([\d.]+))?\s*([NSEWnsew])/);
  if (!m) return null;
  let v = parseFloat(m[1]) + parseFloat(m[2]) / 60 + (m[3] ? parseFloat(m[3]) : 0) / 3600;
  const h = m[4].toUpperCase();
  if (h === 'S' || h === 'W') v = -v;
  return v;
}
function parseCoordPair(s) {
  const m = s.match(/([\d.]+:[\d.]+(?::[\d.]+)?\s*[NSns])\s+([\d.]+:[\d.]+(?::[\d.]+)?\s*[EWew])/);
  if (!m) return null;
  const lat = parseDMS(m[1]), lon = parseDMS(m[2]);
  return (lat == null || lon == null) ? null : [lat, lon];
}
function destPoint(center, radiusM, brgDeg) {
  const Re = 6371000, br = brgDeg * Math.PI / 180;
  const φ1 = center[0] * Math.PI / 180, λ1 = center[1] * Math.PI / 180, δ = radiusM / Re;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(br));
  const λ2 = λ1 + Math.atan2(Math.sin(br) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [φ2 * 180 / Math.PI, λ2 * 180 / Math.PI];
}
function arcPoints(center, p1, p2, dir) {
  const c = { lat: center[0], lon: center[1] };
  const r = haversine(c, { lat: p1[0], lon: p1[1] });
  const a1 = (bearing(c, { lat: p1[0], lon: p1[1] }) + 360) % 360;
  const a2 = (bearing(c, { lat: p2[0], lon: p2[1] }) + 360) % 360;
  let sweep = a2 - a1;
  if (dir > 0 && sweep < 0) sweep += 360;
  if (dir < 0 && sweep > 0) sweep -= 360;
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / 4));
  const out = [p1];
  for (let i = 1; i <= steps; i++) out.push(destPoint(center, r, a1 + sweep * i / steps));
  return out;
}
function parseOpenAir(text) {
  const asps = [];
  let cur = null, center = null, dir = 1;
  const flush = () => { if (cur && (cur.circle || cur.latlngs.length >= 3)) asps.push(cur); };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '*') continue;
    const u = line.toUpperCase();
    if (u.startsWith('AC')) { flush(); cur = { cls: line.slice(2).trim(), name: '', top: '', bottom: '', latlngs: [], circle: null }; dir = 1; continue; }
    if (!cur) continue;
    if (u.startsWith('AN')) cur.name = line.slice(2).trim();
    else if (u.startsWith('AH')) cur.top = line.slice(2).trim();
    else if (u.startsWith('AL')) cur.bottom = line.slice(2).trim();
    else if (u.startsWith('V')) {
      const mx = line.match(/V\s+X\s*=\s*(.+)/i); if (mx) center = parseCoordPair(mx[1]);
      const md = line.match(/V\s+D\s*=\s*([+-])/i); if (md) dir = md[1] === '-' ? -1 : 1;
    }
    else if (u.startsWith('DP')) { const p = parseCoordPair(line.slice(2)); if (p) cur.latlngs.push(p); }
    else if (u.startsWith('DC')) { const r = parseFloat(line.slice(2)); if (center && r > 0) cur.circle = { center, radiusM: r * 1852 }; }
    else if (u.startsWith('DB')) {
      const parts = line.slice(2).split(',');
      const p1 = parseCoordPair(parts[0] || ''), p2 = parseCoordPair(parts[1] || '');
      if (center && p1 && p2) for (const pp of arcPoints(center, p1, p2, dir)) cur.latlngs.push(pp);
    }
  }
  flush();
  return asps;
}
function airspaceStyle(cls) {
  const c = (cls || '').toUpperCase().trim();
  const base = { weight: 1, fillOpacity: 0.05, opacity: 0.8 };
  if (c === 'R' || c === 'P') return { ...base, color: '#d32f2f', fillColor: '#d32f2f' };
  if (c === 'Q') return { ...base, color: '#f57c00', fillColor: '#f57c00', dashArray: '4 3' };
  if (c === 'CTR') return { ...base, color: '#c2185b', fillColor: '#c2185b' };
  if (c === 'C' || c === 'D') return { ...base, color: '#1976d2', fillColor: '#1976d2' };
  if (c === 'TMZ') return { ...base, color: '#7b1fa2', fillColor: '#7b1fa2', dashArray: '5 4' };
  if (c === 'RMZ') return { ...base, color: '#388e3c', fillColor: '#388e3c', dashArray: '5 4' };
  if (c === 'W') return { ...base, color: '#0097a7', fillColor: '#0097a7' };
  return { ...base, color: '#616161', fillColor: '#616161' };
}
function populateAirspace(group, text) {
  group.clearLayers();
  const asps = parseOpenAir(text);
  let count = 0;
  for (const a of asps) {
    const st = airspaceStyle(a.cls);
    const shape = a.circle ? L.circle(a.circle.center, { radius: a.circle.radiusM, ...st })
                           : L.polygon(a.latlngs, st);
    shape.bindTooltip(
      `<b>${escapeHtml(a.name || '–')}</b><br>Klasse ${escapeHtml(a.cls)} · ${escapeHtml(a.bottom)} – ${escapeHtml(a.top)}`,
      { sticky: true }
    );
    group.addLayer(shape);
    count++;
  }
  return count;
}
async function loadAirspaceFromBundle() {
  if (airspaceLoaded) return;
  airspaceLoaded = true;
  try {
    toast('Lade Luftraum (DAeC)…');
    const r = await fetch('./airspace/de_openair.txt');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const count = populateAirspace(airspaceGroup, await r.text());
    toast(`Luftraum: ${count} Gebiete geladen (DAeC OpenAir).`);
  } catch (e) {
    airspaceLoaded = false;
    toast('Luftraum nicht ladbar: ' + e.message + ' (offline? einmal online laden).', true);
  }
}
function loadOpenAirText(text, fileName) {
  const count = populateAirspace(airspaceGroup, text);
  airspaceLoaded = true;
  if (!map.hasLayer(airspaceGroup)) airspaceGroup.addTo(map);
  toast(`Luftraum „${fileName}": ${count} Gebiete geladen.`);
}
function isOpenAir(name, text) {
  const n = name.toLowerCase();
  if (n.endsWith('.air') || n.endsWith('.openair')) return true;
  if (n.endsWith('.gpx') || n.endsWith('.igc')) return false;
  return /^\s*AC\s+\S/m.test(text) && /^\s*DP\s+/m.test(text);
}

// Wind-Anzeige (Leaflet-Control, oben rechts)
let windCtrl = null;
function initWindControl() {
  const Ctrl = L.Control.extend({
    onAdd() {
      const d = L.DomUtil.create('div', 'wind-ctrl');
      d.id = 'wind-ctrl'; d.style.display = 'none';
      return d;
    },
  });
  windCtrl = new Ctrl({ position: 'topright' });
  map.addControl(windCtrl);
}
function updateWindControl() {
  const el = document.getElementById('wind-ctrl');
  if (!el) return;
  const t = state.tracks
    .filter(t => t.visible && state.showThermals && t.soaring && t.soaring.wind)
    .sort((a, b) => b.stats.dist - a.stats.dist)[0];
  if (!t) { el.style.display = 'none'; return; }
  const w = t.soaring.wind;
  const kmh = (w.speed * 3.6).toFixed(0);
  const kt = (w.speed * 1.94384).toFixed(0);
  el.style.display = 'block';
  el.innerHTML =
    `<div class="wind-arrow" style="transform:rotate(${w.from}deg)">↓</div>` +
    `<div class="wind-txt"><strong>${compass(w.from)} ${Math.round(w.from)}°</strong>` +
    `<small>${kmh} km/h · ${kt} kt</small></div>`;
  el.title = `Wind aus ${Math.round(w.from)}° (aus Kreisdrift geschätzt, ${t.name})`;
}

function colorForPoint(track, i) {
  const p = track.points[i];
  if (state.colorMode === 'ele' && p.ele != null && track.stats.hasEle) {
    const t = (p.ele - track.stats.minEle) / Math.max(1, track.stats.maxEle - track.stats.minEle);
    return gradient(t); // blau->rot
  }
  if (state.colorMode === 'climb') {
    const v = p.varioSmooth != null ? p.varioSmooth : p.vario;
    if (v != null) return gradient(Math.max(0, Math.min(1, (v + 3) / 6))); // -3..+3 m/s
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

  // Thermik-Marker
  refs.thermals = [];
  if (state.showThermals && track.soaring) {
    for (const th of track.soaring.thermals) {
      const cl = th.climb != null ? th.climb : 0;
      const r = 7 + Math.min(16, Math.max(0, (th.gain || 0) / 60)); // Radius ~ Höhengewinn
      const m = L.circleMarker(th.center, {
        radius: r, color: '#fff', weight: 1.5, fillColor: gradient((cl + 3) / 6), fillOpacity: .8,
      }).addTo(map).bindTooltip(
        `🌀 Bart · ${th.gain != null ? (th.gain >= 0 ? '+' : '') + Math.round(th.gain) + ' m' : '–'}` +
        ` · ${cl != null ? cl.toFixed(1) + ' m/s' : '–'} · ${fmtMinSec(th.dur)}`,
        { direction: 'top' }
      );
      refs.thermals.push(m);
    }
  }

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
  (r.thermals || []).forEach(m => map.removeLayer(m));
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
  if (state.profileMetric === 'vario') return p.varioSmooth != null ? p.varioSmooth : p.vario;
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

  // Kreisflug-Phasen (Thermik) als Band hinterlegen
  if (state.showThermals) {
    for (const t of visible) {
      if (!t.soaring || !t.soaring.thermals.length) continue;
      ctx.fillStyle = hexToRgba(t.color, 0.12);
      for (const th of t.soaring.thermals) {
        const x1 = xOf(th.startDist), x2 = xOf(th.endDist);
        ctx.fillRect(x1, padT, Math.max(1.5, x2 - x1), h);
      }
    }
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
    const so = t.soaring;
    let soHtml = '';
    if (so && so.hasTime && so.thermals.length) {
      const circPct = s.duration ? Math.round(so.circlingTime / s.duration * 100) : 0;
      const wind = so.wind ? `${compass(so.wind.from)} ${Math.round(so.wind.from)}° · ${(so.wind.speed * 3.6).toFixed(0)} km/h` : '–';
      soHtml = `
        <dt class="sep">🌀 Bärte</dt><dd class="sep">${so.thermals.length}</dd>
        <dt>Steigen Ø / best</dt><dd>${so.avgClimb != null ? so.avgClimb.toFixed(1) : '–'} / ${so.bestClimb != null ? so.bestClimb.toFixed(1) : '–'} m/s</dd>
        <dt>bestes 30 s</dt><dd>${so.best30 != null ? so.best30.toFixed(1) + ' m/s' : '–'}</dd>
        <dt>Höhe in Bärten</dt><dd>${Math.round(so.thermalGain)} m</dd>
        <dt>Kreisen-Anteil</dt><dd>${circPct} %</dd>
        <dt>Gleitzahl Ø</dt><dd>${so.glideRatio != null ? so.glideRatio.toFixed(1) + ' : 1' : '–'}</dd>
        <dt>Wind (Drift)</dt><dd>${wind}</dd>`;
    }
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
        ${soHtml}
      </dl>`;
    panel.appendChild(card);
  }
  updateWindControl();
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
    if (isOpenAir(file.name, text)) { loadOpenAirText(text, file.name); return; }
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
  document.getElementById('view3d-btn').addEventListener('click', () => {
    const vis = state.tracks.filter(t => t.visible);
    if (!vis.length) { toast('Kein sichtbarer Track für die 3D-Ansicht.', true); return; }
    toast('Lade 3D-Gelände …');
    open3D(vis).catch(err => toast('3D-Ansicht: ' + err.message, true));
  });

  document.getElementById('colormode').addEventListener('change', (e) => {
    state.colorMode = e.target.value; redrawAllLayers();
  });
  document.getElementById('thermals-toggle').addEventListener('change', (e) => {
    state.showThermals = e.target.checked;
    redrawAllLayers(); renderStats(); drawProfile(); updateWindControl();
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
function hexToRgba(c, a) {
  if (c[0] === '#') {
    const h = c.slice(1);
    const v = h.length === 3 ? h.split('').map(x => x + x).join('') : h;
    const n = parseInt(v, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const m = c.match(/\d+/g);
  return m ? `rgba(${m[0]},${m[1]},${m[2]},${a})` : `rgba(30,136,229,${a})`;
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
