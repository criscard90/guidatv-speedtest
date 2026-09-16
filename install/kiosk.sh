#!/bin/bash
# Avvio del kiosk: aspetta che il web server locale sia pronto, apre Chromium a
# schermo intero e lo sorveglia. Garantisce che:
#   - la pagina si carichi sempre al primo colpo (attende il web server)
#   - parta quando la sessione grafica e' pronta (finestre nere all'avvio)
#   - il browser venga riaperto se si chiude o crasha
#   - la pagina venga ricaricata se il web server cade e poi torna
#   - lo schermo non si spenga (blocca il blanking su sessioni X11)
#   - si riavvii da solo (nella sessione grafica giusta) quando il timer di
#     auto-aggiornamento installa una versione nuova del launcher
# Log: ~/kiosk.log   Log di Chromium: ~/kiosk-chrome.log
set -u

TVHOME="${HOME:-/tmp}"
LOG="$TVHOME/kiosk.log"
CHROME_LOG="$TVHOME/kiosk-chrome.log"
RELOAD_FLAG="$TVHOME/.kiosk-reload"
URL="http://localhost:8080/"
HOST="127.0.0.1"
PORT="8080"

exec >>"$LOG" 2>&1
SELF="${BASH_SOURCE[0]}"
SELF_DIR="$(cd "$(dirname "$SELF")" && pwd)"
VERSION="$(git -C "$SELF_DIR/.." rev-parse --short HEAD 2>/dev/null || echo sconosciuta)"
echo "=== $(date '+%F %T') avvio kiosk.sh (PID $$, versione $VERSION) ==="

export DISPLAY="${DISPLAY:-:0}"
# XAUTHORITY serve SOLO alle sessioni X11: su Wayland (Wayfire/labwc) il display
# si raggiunge via WAYLAND_DISPLAY, e puntare XAUTHORITY a un file inesistente
# fa partire Chromium senza finestra (schermo nero).
if [ -z "${XAUTHORITY:-}" ] && [ "${XDG_SESSION_TYPE:-}" = "x11" ]; then
  for x in "$TVHOME/.Xauthority" "/run/user/$(id -u)/xauth_"*; do
    if [ -f "$x" ]; then XAUTHORITY="$x"; break; fi
  done
  [ -n "${XAUTHORITY:-}" ] && export XAUTHORITY
fi

# --- trova il binario di Chromium disponibile sul sistema ---
CHROME="${CHROME:-}"
if ! command -v "$CHROME" >/dev/null 2>&1; then
  CHROME=""
  for c in chromium-browser chromium chromium-browser-stable; do
    if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
  done
fi
echo "chromium=${CHROME:-NON_TROVATO} display=$DISPLAY sessione=${XDG_SESSION_TYPE:-?} xauthority=${XAUTHORITY:-non impostato} wayland=${WAYLAND_DISPLAY:-no}"

FLAGS=(
  --kiosk
  --noerrdialogs
  --no-first-run
  --no-default-browser-check
  --disable-infobars
  --disable-session-crashed-bubble
  --overscroll-history-navigation=0
  --password-store=basic
  --lang=it
  --disable-translate
  --disable-features=Translate,TranslateUI,TranslateRanker
  --incognito
)
# flag extra per prove:  KIOSK_EXTRA_FLAGS="--disable-gpu" ~/tvkiosk/install/kiosk.sh
if [ -n "${KIOSK_EXTRA_FLAGS:-}" ]; then
  read -r -a EXTRA <<<"$KIOSK_EXTRA_FLAGS"
  FLAGS+=("${EXTRA[@]}")
fi

# --- il web server risponde? (basta la connessione TCP: non serve curl) ---
server_up() {
  python3 -c "
import socket, sys
try:
    socket.create_connection(('$HOST', $PORT), 3).close()
except OSError:
    sys.exit(1)
" >/dev/null 2>&1
}

# --- lo schermo non deve spegnersi (solo sessioni X11) ---
keep_awake() {
  command -v xset >/dev/null 2>&1 || return 0
  xset s off -dpms >/dev/null 2>&1
  xset s noblank >/dev/null 2>&1
  return 0
}

# --- Chromium e' attivo? Si controlla il PROCESSO, non il PID: il wrapper di
#     Debian puo' uscire subito lasciando vivo il browser vero, e un controllo
#     basato sul PID lo farebbe riaprire (e uccidere) ogni 20 secondi. ---
chrome_running() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f 'chromium.*localhost:8080' >/dev/null 2>&1 && return 0
    return 1
  fi
  # fallback per Linux senza pgrep: cerca il browser tra i processi in /proc
  if [ -d /proc/1 ]; then
    local f
    for f in /proc/[0-9]*/cmdline; do
      tr '\0' ' ' <"$f" 2>/dev/null | grep -q 'chromium.*localhost:8080' && return 0
    done
    return 1
  fi
  # non c'e' modo di sapere se il browser e' vivo: NON lo uccido/riapro a vuoto
  return 0
}

close_chrome() {
  pkill -f 'chromium.*localhost:8080' >/dev/null 2>&1 || true
  sleep 2
  pkill -9 -f 'chromium.*localhost:8080' >/dev/null 2>&1 || true
  sleep 1
}

wait_server() {   # attende al massimo ~3 minuti
  local i
  for i in $(seq 1 90); do
    if server_up; then
      echo "$(date '+%F %T') server pronto (tentativo $i)"
      return 0
    fi
    sleep 2
  done
  echo "$(date '+%F %T') server NON pronto dopo 3 minuti: apro comunque il browser"
  return 1
}

# --- la sessione grafica e' pronta? All'autostart capita che Chromium parta
#     prima del display: il processo resta vivo ma senza finestra -> schermo nero.
wait_display() {
  # Wayland nativo (nessun X): il display si raggiunge via WAYLAND_DISPLAY
  [ -n "${WAYLAND_DISPLAY:-}" ] && [ -z "${DISPLAY:-}" ] && return 0
  # nessun socket X11 sul sistema: non c'e' nulla da attendere
  [ -d /tmp/.X11-unix ] || return 0
  local n="${DISPLAY#:}"
  n="${n%%.*}"
  local i
  for i in $(seq 1 30); do     # al massimo 60 secondi
    if [ -e "/tmp/.X11-unix/X$n" ]; then
      echo "$(date '+%F %T') display X$n pronto (tentativo $i)"
      return 0
    fi
    sleep 2
  done
  echo "$(date '+%F %T') ATTENZIONE: display X$n non pronto dopo 60s, avvio comunque"
  return 0
}

start_chrome() {
  close_chrome
  : >"$CHROME_LOG"
  "$CHROME" "${FLAGS[@]}" "$URL" >>"$CHROME_LOG" 2>&1 &
  sleep 5
  if chrome_running; then
    echo "$(date '+%F %T') chromium avviato"
    return 0
  fi
  # Primo tentativo fallito: su Raspberry la causa piu' comune e' l'accelerazione
  # grafica. Riprovo senza GPU (rendering software): cosi' lo schermo non resta nero.
  echo "$(date '+%F %T') ATTENZIONE: chromium non attivo dopo l'avvio, riprovo con --disable-gpu"
  tail -n 5 "$CHROME_LOG" 2>/dev/null || true
  close_chrome
  "$CHROME" "${FLAGS[@]}" --disable-gpu "$URL" >>"$CHROME_LOG" 2>&1 &
  sleep 5
  if chrome_running; then
    echo "$(date '+%F %T') chromium avviato senza accelerazione grafica (--disable-gpu)"
    return 0
  fi
  echo "$(date '+%F %T') ERRORE: chromium non parte nemmeno con --disable-gpu (vedi $CHROME_LOG)"
  tail -n 10 "$CHROME_LOG" 2>/dev/null || true
  return 1
}

wait_server || true
wait_display
keep_awake
start_chrome

# watchdog: il kiosk deve restare sempre a schermo e aggiornato
SERVER_DOWN=0
while true; do
  sleep 20
  keep_awake

  # Il timer di auto-aggiornamento ha installato un launcher nuovo: riavvio me
  # stesso (exec). Lo fa il kiosk, NON il servizio: il servizio non gira nella
  # sessione grafica (HOME e XAUTHORITY diversi) e lascerebbe lo schermo nero.
  if [ -f "$RELOAD_FLAG" ]; then
    rm -f "$RELOAD_FLAG"
    if [ -f "$SELF" ]; then
      echo "$(date '+%F %T') launcher aggiornato: riavvio il kiosk con la versione nuova"
      exec bash "$SELF"
    fi
  fi

  if ! chrome_running; then
    echo "$(date '+%F %T') chromium non attivo: riapro il browser"
    server_up || wait_server || true
    start_chrome
    SERVER_DOWN=0
    continue
  fi

  if server_up; then
    if [ "$SERVER_DOWN" = "1" ]; then
      # il web server era caduto ed e' tornato: ricarico la pagina
      # (Chromium mostrerebbe la pagina di errore, senza auto-reload)
      echo "$(date '+%F %T') il server e' tornato: ricarico la pagina"
      SERVER_DOWN=0
      start_chrome
    fi
  else
    [ "$SERVER_DOWN" = "0" ] && echo "$(date '+%F %T') il server non risponde"
    SERVER_DOWN=1
  fi
done
