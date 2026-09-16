#!/bin/bash
# Aggiornamento automatico del kiosk: git pull e, se e' cambiato qualcosa,
# rigenera subito guida TV + meteo. Se e' cambiato il launcher del browser,
# riallinea l'autostart e riavvia il kiosk. Chiamato da tv-updater.timer (5 min).
# HOME puo' non essere valorizzato nei servizi di sistema: fallback sicuro
TVHOME="$HOME"
[ -d "$TVHOME/tvkiosk" ] || TVHOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
cd "$TVHOME/tvkiosk" || exit 0

OLD="$(git rev-parse HEAD 2>/dev/null)"
git pull --ff-only --quiet || exit 0
NEW="$(git rev-parse HEAD 2>/dev/null)"

if [ "$OLD" = "$NEW" ]; then
  echo "$(date '+%F %T') nessun aggiornamento"
  exit 0
fi

echo "$(date '+%F %T') aggiornamento $OLD -> $NEW: rigenero i dati"
python3 "$TVHOME/tvkiosk/scraper/stasera_scraper.py" --out "$TVHOME/tvkiosk/web" \
  || echo "$(date '+%F %T') scraper in errore dopo il pull" >&2

# se sono cambiati launcher/flag del browser, riallinea l'autostart e riavvia il kiosk
if git diff --name-only "$OLD" "$NEW" | grep -q -E '^install/(tvkiosk\.desktop|kiosk\.sh)$'; then
  echo "$(date '+%F %T') launcher kiosk aggiornato: riavvio il browser"
  chmod +x "$TVHOME/tvkiosk/install/kiosk.sh" 2>/dev/null || true
  mkdir -p "$HOME/.config/autostart"
  sed "s|__KIOSK__|$TVHOME/tvkiosk/install/kiosk.sh|g" \
    "$TVHOME/tvkiosk/install/tvkiosk.desktop" > "$HOME/.config/autostart/tvkiosk.desktop"

  pkill -f 'chromium.*localhost:8080' >/dev/null 2>&1 || true
  pkill -f 'tvkiosk/install/kiosk.sh' >/dev/null 2>&1 || true
  sleep 2
  # riavvia il launcher aggiornato (il watchdog rilancia anche Chromium)
  DISPLAY=:0 XAUTHORITY="$HOME/.Xauthority" setsid \
    "$TVHOME/tvkiosk/install/kiosk.sh" >/dev/null 2>&1 &
  echo "$(date '+%F %T') kiosk riavviato"
fi
