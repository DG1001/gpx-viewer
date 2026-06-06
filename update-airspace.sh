#!/usr/bin/env bash
# Aktualisiert die mitgelieferten DAeC-Luftraumdaten (OpenAir, kostenlos, ohne Key).
# Quelle: https://www.daec.de/fachbereiche/luftraum-flugsicherheit-betrieb/luftraumdaten/
# Der Dateiname enthält den AIRAC-Stand und ändert sich – bei Bedarf URL anpassen.
set -euo pipefail
URL="${1:-https://www.daec.de/media/files/Dateien/Fachbereiche/Luftraum_und_Flugsicherheit/2026_04a_Airspace_Germany_OA1.txt}"
OUT="$(dirname "$0")/airspace/de_openair.txt"
echo "Lade $URL"
curl -fsSL "$URL" -o "$OUT"
echo "Gespeichert: $OUT ($(wc -l < "$OUT") Zeilen)"
