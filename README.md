# GPX Viewer (PWA)

Eine leichtgewichtige, **reine clientseitige** Web-App zum Ansehen von Flug-Tracks
(Segelflug & Co.) im **GPX**- und optional **IGC**-Format. Karte + Höhen-/
Geschwindigkeits-/Steig-Profil + Eckdaten. Kein Backend, keine Uploads, keine
Tracking-Skripte — alle Daten bleiben lokal auf deinem Gerät.

Installierbar als PWA unter Windows (Edge/Chrome) und per **Doppelklick auf `.gpx`**
startbar.

![Icon](icons/icon-192.png)

## Funktionen

- **Laden** per Drag & Drop, Datei-Button oder **Doppelklick** (File Handling API).
- **Karte** (Leaflet + OpenStreetMap): Polyline, automatisches Einpassen
  (`fitBounds`), Start-/Endmarker.
- **Profil** (selbst gezeichnetes Canvas, keine Chart-Lib): Höhe, Geschwindigkeit
  oder Steigen (Vario) über die Distanz.
- **Eckdaten**: Dauer, Streckenlänge (2D), Ø/max. Geschwindigkeit, Höhengewinn,
  max./min. Höhe, Start-/Endzeit.
- **Mehrere Tracks** gleichzeitig: Liste mit Farbe (änderbar), Sichtbarkeit, Zoom,
  Entfernen — jeder Track eine eigene Farbe.
- **Hover-Synchronisation**: Maus über dem Profil → Marker auf der Karte
  (und umgekehrt beim Überfahren der Track-Linie).
- **Track-Einfärbung** wahlweise pro Track, nach Höhe oder nach Steigen (Gradient).
- **Segelflug-Analyse:** automatische **Thermik-Erkennung** (Kreisflug über die
  Drehrate), Bärte mit Steigwert/Höhengewinn/Dauer als Marker auf der Karte und als
  Band im Profil; **Kreisen-Anteil**, **Gleitzahl (L/D)**, **bestes 30-s-Steigen** und
  **Windschätzung aus der Kreisdrift** (Pfeil oben rechts). Vario wird geglättet.
- **Kartenwechsel**: OpenStreetMap / OpenTopoMap / Satellit (Esri) + **Luftraum-Overlay**
  aus den **kostenlosen DAeC-OpenAir-Daten** (Polygone, Kreise, Bögen; klassenabhängige
  Farben; ganz ohne API-Key).
- **Offline-fähig**: Service Worker cached App-Shell, Leaflet-CDN und Karten-Tiles.
- **IGC** (Segelflug) optional unterstützt: B-Records (Zeit, Lat/Lon, GPS-/Druckhöhe).

## Dateistruktur

```
index.html             App-Shell
app.js                 Logik: Parser (GPX/IGC), Karte, Profil, UI  (ES-Modul)
style.css              Layout & Design
manifest.webmanifest   PWA-Manifest inkl. file_handlers
sw.js                  Service Worker (Precache + Runtime-Caches)
icons/                 icon-192.png, icon-512.png, maskable-512.png
sample.gpx             Beispiel-Track (Segelflug mit Thermik, ele + time)
```

## Lokal starten

Ein **Secure Context** ist nötig (Service Worker & File Handling) — `localhost`
gilt als sicher. Einfach einen statischen Server im Repo-Root starten:

```bash
python3 -m http.server 8000
# dann im Browser:  http://localhost:8000
```

Alternativ z. B. `npx serve` oder jeder andere statische Server. Kein Build-Step,
keine npm-Abhängigkeiten nötig.

> Hinweis: Über `http://` auf einer fremden IP (nicht `localhost`) registriert sich
> der Service Worker nicht. Für Tests immer `localhost` verwenden, fürs Hosting
> `https://` (z. B. GitHub Pages).

## Als PWA unter Windows installieren

1. App über `http://localhost:8000` (oder die `https`-Hosting-URL) öffnen.
2. In Edge/Chrome rechts in der Adressleiste auf **„App installieren"** klicken
   (Symbol mit Monitor/Pfeil) oder Menü → *Apps → Diese Seite als App installieren*.
3. Die App läuft danach im eigenen Fenster.

### `.gpx` per Doppelklick öffnen

Nach der Installation registriert Windows die App über den `file_handlers`-Eintrag
im Manifest als Handler für `.gpx` (und `.igc`). Doppelklick auf eine solche Datei
startet die installierte PWA; `window.launchQueue` liest die Datei und zeigt sie an.

> Beim ersten Mal fragt Edge/Chrome ggf., ob die App die Dateitypen verwalten darf
> — bestätigen. Falls `.gpx` mit einem anderen Programm verknüpft ist, einmalig über
> *Öffnen mit → andere App* den GPX Viewer wählen.

## Auf GitHub Pages hosten

Repo nach GitHub pushen, in den Repo-Einstellungen *Pages* aktivieren (Branch `main`,
Ordner `/root`). Da alles statisch und relativ verlinkt ist (`start_url`/`scope` = `.`),
funktioniert es ohne Anpassungen unter `https://<user>.github.io/<repo>/`.

## Hosting via XaresAICoder-Proxy

Der eingebaute Server bindet an `0.0.0.0`, damit der Proxy ihn erreicht:

```bash
python3 -m http.server 8000 --bind 0.0.0.0
```

Die externe URL liefert `echo "$VSCODE_PROXY_URI" | sed 's/{{port}}/8000/'`.
Service-Worker/Install setzen einen Secure Context voraus — über die `https`-Proxy-URL
gegeben, lokal `localhost` verwenden.

## Verifikation (Checkliste)

- [x] **Drag & Drop** lädt eine Datei → Karte, Profil und Eckdaten erscheinen.
- [x] **Datei-Button** „Dateien öffnen…" funktioniert, mehrere Dateien möglich.
- [x] **Manifest valide** & „installable" (Lighthouse → PWA / „Installability").
- [x] **Service Worker** registriert (DevTools → Application → Service Workers).
- [x] **Offline-Reload**: nach dem ersten Laden Netzwerk in DevTools auf *Offline*
      stellen → Seite neu laden → App-Shell lädt weiter; bereits besuchte Karten-
      Kacheln bleiben sichtbar.
- [x] **File-Handler** im Manifest korrekt deklariert (`file_handlers` → `.gpx`).

## Luftraum-Overlay (DAeC, OpenAir – kostenlos & ohne Key)

Die deutschen Lufträume kommen aus den **frei verfügbaren OpenAir-Daten des DAeC**
(erstellt von der Bundeskommission Segelflug). Sie liegen als
`airspace/de_openair.txt` **im Repo bei** und werden clientseitig zu Leaflet-Polygonen,
-Kreisen und -Bögen geparst — kein API-Key, keine fremde Tile-API.

- Einschalten über den **Layer-Schalter** (oben rechts auf der Karte) → „Luftraum (DAeC)".
- Beim ersten Einschalten wird die Datei geladen (danach vom Service Worker gecached,
  also **offline** verfügbar). Farben nach Klasse (R/P rot, Q orange, C/D blau,
  CTR magenta, TMZ/RMZ gestrichelt …); Tooltip zeigt Name, Klasse und Unter-/Obergrenze.
- **Eigene OpenAir-Datei** laden: einfach eine `.txt`/`.air`/`.openair` per Drag & Drop
  oder über „Dateien öffnen…" reinziehen — sie ersetzt das Overlay.

### Daten aktualisieren

Der DAeC aktualisiert die Daten je AIRAC. Zum Auffrischen der mitgelieferten Datei:

```bash
./update-airspace.sh        # lädt die aktuelle OpenAir-Datei vom DAeC-Server
# oder mit expliziter URL (Dateiname enthält den Stand):
./update-airspace.sh "https://www.daec.de/media/files/.../JJJJ_NNx_Airspace_Germany_OA1.txt"
```

> Hinweis: Der DAeC-Server sendet keine CORS-Header, daher lädt die App die Datei
> **nicht live** aus dem Browser, sondern aus der mitgelieferten (same-origin) Kopie.
> Quelle: <https://www.daec.de/fachbereiche/luftraum-flugsicherheit-betrieb/luftraumdaten/>
> Die Daten sind ohne Gewähr und nicht für navigatorische Zwecke freigegeben.

## Hinweise zur Segelflug-Analyse

- **Thermik-Erkennung** über die geglättete Drehrate (Schwelle ~6 °/s, Bart ab ~25 s
  Kreisflug). Sie braucht **Zeitstempel** in der Datei und funktioniert am besten bei
  feinem Sampling (1–4 s), wie es typische Logger/IGC liefern.
- **Wind** wird aus dem Netto-Versatz des Kreisflugs geschätzt (über mehrere Kreise
  mittelt sich die Eigengeschwindigkeit heraus) — eine Näherung, kein Messwert.
- **Gleitzahl** = horizontale Strecke ÷ Höhenverlust über die Geradeaus-Phasen.

## Privatsphäre

Es werden **keine** Track-Daten hochgeladen. Der einzige Netzwerkzugriff sind die
OpenStreetMap-Karten-Kacheln und das Leaflet-CDN (beide werden für Offline-Betrieb
gecached). Keine Analytics, kein Tracking.

## Technik / Grenzen

- GPX-Parsing über den eingebauten `DOMParser`, IGC über einfaches Zeilen-Parsing.
- Strecke ist **2D** (Haversine); Höhengewinn ist die Summe positiver Höhenschritte
  (ungeglättet — barometrisches Rauschen kann ihn leicht überschätzen).
- Geschwindigkeit/Vario werden aus Δstrecke/Δzeit bzw. Δhöhe/Δzeit je Punkt berechnet.
- Getestet mit aktuellem Edge/Chrome. Die File Handling API ist Chromium-spezifisch;
  Drag & Drop und Datei-Button funktionieren überall.
