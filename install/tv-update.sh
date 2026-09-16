#!/bin/bash
# Aggiornamento automatico del kiosk: git pull e, se e' cambiato qualcosa,
# rigenera subito guida TV + meteo. Chiamato da tv-updater.timer ogni 5 minuti.
cd "$HOME/tvkiosk" || exit 0

OLD="$(git rev-parse HEAD 2>/dev/null)"
git pull --ff-only --quiet || exit 0
NEW="$(git rev-parse HEAD 2>/dev/null)"

if [ "$OLD" != "$NEW" ]; then
  echo "$(date '+%F %T') aggiornamento $OLD -> $NEW: rigenero i dati"
  python3 "$HOME/tvkiosk/scraper/stasera_scraper.py" --out "$HOME/tvkiosk/web" \
    || echo "$(date '+%F %T') scraper in errore dopo il pull" >&2
else
  echo "$(date '+%F %T') nessun aggiornamento"
fi
