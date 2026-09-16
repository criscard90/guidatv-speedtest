#!/bin/bash
# Diagnostica del kiosk TV: raccoglie in un unico output tutto quello che serve
# per capire perche' lo schermo resta nero o il browser non parte.
#   bash ~/tvkiosk/install/diagnose.sh
set -u
TVHOME="${HOME:-/tmp}"
URL="http://localhost:8080/"
CHROME="$(command -v chromium-browser || command -v chromium || true)"

show() {   # mostra un blocco di righe, oppure "(nessuno)" se vuoto
  if [ -n "${1:-}" ]; then printf '%s\n' "$1"; else echo "(nessuno)"; fi
}

echo "===== DIAGNOSTICA KIOSK $(date '+%F %T') ====="
echo
echo "--- sistema ---"
uname -a
grep -E 'PRETTY_NAME|VERSION_CODENAME' /etc/os-release 2>/dev/null || true
vcgencmd get_throttled 2>/dev/null || echo "(vcgencmd non disponibile)"
echo
echo "--- sessione grafica ---"
echo "XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-?}  DISPLAY=${DISPLAY:-?}  WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-?}"
echo "processi di sessione:"
show "$(pgrep -a -f 'labwc|wayfire|Xorg|Xwayland|lightdm' 2>/dev/null | head -8)"
echo
echo "--- autostart ---"
cat "$TVHOME/.config/autostart/tvkiosk.desktop" 2>/dev/null || echo "(autostart tvkiosk.desktop ASSENTE)"
echo
echo "--- launcher ---"
ls -l "$TVHOME/tvkiosk/install/kiosk.sh" 2>/dev/null || echo "(kiosk.sh ASSENTE)"
echo "processo kiosk.sh:"
show "$(pgrep -a -f 'kiosk\.sh' 2>/dev/null | grep -v diagnose | head -3)"
echo "kiosk.log (ultime 20 righe):"
tail -n 20 "$TVHOME/kiosk.log" 2>/dev/null || echo "(nessun kiosk.log)"
echo
echo "--- chromium ---"
echo "binario: ${CHROME:-NON TROVATO}"
echo "processi:"
show "$(pgrep -a -f 'chromium' 2>/dev/null | head -5)"
echo "kiosk-chrome.log (ultime 10 righe):"
tail -n 10 "$TVHOME/kiosk-chrome.log" 2>/dev/null || echo "(nessun kiosk-chrome.log)"
echo
echo "--- web server (tvserver) ---"
echo "servizio: $(systemctl is-active tvserver.service 2>/dev/null)"
if command -v curl >/dev/null 2>&1; then
  curl -s -o /dev/null -w "  GET /                    -> %{http_code}\n" "$URL" || echo "  GET / -> non risponde"
  curl -s -o /dev/null -w "  GET /data/programmi.json -> %{http_code}\n" "${URL}data/programmi.json" || true
  curl -s -o /dev/null -w "  GET /data/meteo.json     -> %{http_code}\n" "${URL}data/meteo.json" || true
else
  echo "  (curl non installato)"
fi
journalctl -u tvserver -n 5 --no-pager 2>/dev/null | tail -n 5 || true
echo
echo "--- timer e versione ---"
for t in tv-scraper.timer tv-speedtest.timer tv-updater.timer; do
  echo "  $t: $(systemctl is-active "$t" 2>/dev/null)/$(systemctl is-enabled "$t" 2>/dev/null)"
done
echo "  commit installato: $(git -C "$TVHOME/tvkiosk" log --oneline -1 2>/dev/null || echo '?')"
echo "  file dati: $(ls "$TVHOME/tvkiosk/web/data" 2>/dev/null | tr '\n' ' ')"
echo
echo "--- schermo / blanking ---"
if command -v xset >/dev/null 2>&1; then
  DISPLAY="${DISPLAY:-:0}" xset q 2>/dev/null | grep -iE 'timeout|standby|suspend|DPMS' | head -6 \
    || echo "(xset non riesce a parlare con il display: forse sessione Wayland)"
else
  echo "(xset assente)"
fi
echo "===== FINE DIAGNOSTICA ====="
