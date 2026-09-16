#!/bin/bash
# Avvio del kiosk: aspetta che il web server locale sia pronto, lancia
# Chromium a schermo intero e lo sorveglia (lo rilancia se si chiude o se
# il server non risponde piu'). Lanciato all'avvio della sessione desktop.
set -u

URL="http://localhost:8080/"

# trova il binario di Chromium disponibile sul sistema
CHROME="${CHROME:-}"
if ! command -v "$CHROME" >/dev/null 2>&1; then
  CHROME="chromium-browser"
  for c in chromium-browser chromium chromium-browser-stable; do
    if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
  done
fi

FLAGS=(
  --kiosk
  --noerrdialogs
  --disable-infobars
  --disable-session-crashed-bubble
  --overscroll-history-navigation=0
  --password-store=basic
  --lang=it
  --disable-translate
  --disable-features=Translate,TranslateUI,TranslateRanker
  --incognito
)

# aspetta che il server locale risponda (max ~3 minuti)
wait_server() {
  local i
  for i in $(seq 1 90); do
    curl -sf -o /dev/null "$URL" && return 0
    sleep 2
  done
  return 1
}

start_chrome() {
  pkill -f "chromium.*localhost:8080" >/dev/null 2>&1 || true
  sleep 1
  "$CHROME" "${FLAGS[@]}" "$URL" >/dev/null 2>&1 &
  CHROME_PID=$!
}

wait_server || true
start_chrome

# watchdog: il kiosk deve restare sempre a schermo e aggiornato
SERVER_DOWN=0
while true; do
  sleep 20

  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    # browser chiuso o crashato -> riapri (attendendo il server se serve)
    wait_server || true
    start_chrome
    SERVER_DOWN=0
    continue
  fi

  if curl -sf -o /dev/null "$URL"; then
    if [ "$SERVER_DOWN" = "1" ]; then
      # il web server era caduto ed e' tornato: ricarico la pagina
      # (Chromium potrebbe mostrare la pagina di errore, senza auto-reload)
      kill "$CHROME_PID" 2>/dev/null || true
      SERVER_DOWN=0
    fi
  else
    # server giu' (es. durante un aggiornamento): aspetto che torni
    SERVER_DOWN=1
  fi
done
