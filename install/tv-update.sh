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

# Se sono cambiati launcher o flag del browser: riallinea l'autostart e chiedi
# al kiosk di riavviarsi. Il riavvio NON si fa da qui: questo servizio di sistema
# non gira nella sessione grafica (per systemd HOME e' /root, non /home/<utente>)
# quindi un Chromium avviato da qui non trova il display e resta lo schermo nero.
# Si lascia un marcatore: e' il kiosk, che gira nella sessione giusta, a riavviarsi.
if git diff --name-only "$OLD" "$NEW" | grep -q -E '^install/(tvkiosk\.desktop|kiosk\.sh|no-blanking\.desktop)$'; then
  echo "$(date '+%F %T') launcher kiosk aggiornato: riallineo l'autostart"
  chmod +x "$TVHOME/tvkiosk/install/kiosk.sh" 2>/dev/null || true
  mkdir -p "$TVHOME/.config/autostart"
  sed "s|__KIOSK__|$TVHOME/tvkiosk/install/kiosk.sh|g" \
    "$TVHOME/tvkiosk/install/tvkiosk.desktop" > "$TVHOME/.config/autostart/tvkiosk.desktop"
  cp "$TVHOME/tvkiosk/install/no-blanking.desktop" "$TVHOME/.config/autostart/" 2>/dev/null || true
  # policy Chromium (solo se l'utente ha sudo senza password, come sul Pi di default)
  for d in /etc/chromium/policies/managed /etc/chromium-browser/policies/managed; do
    sudo -n mkdir -p "$d" 2>/dev/null && sudo -n cp \
      "$TVHOME/tvkiosk/install/chromium-kiosk-policy.json" "$d/kiosk.json" 2>/dev/null || true
  done
  touch "$TVHOME/.kiosk-reload"
  echo "$(date '+%F %T') chiesto il riavvio del kiosk (marcatore .kiosk-reload)"
fi
