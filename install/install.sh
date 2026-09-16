#!/bin/bash
# Installazione TV Kiosk su Raspberry Pi OS (Bookworm, desktop + autologin).
# Eseguire dalla cartella del progetto, come utente normale (NON root):
#   ./install/install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="$HOME/tvkiosk"
USER_NAME="$(whoami)"

if [ "$EUID" -eq 0 ]; then
  echo "Errore: esegui lo script come utente normale (usa sudo solo quando richiesto)."; exit 1
fi

echo "==> [1/6] Aggiorno il sistema e installo Chromium + curl"
sudo apt-get update -q
sudo apt-get install -y chromium-browser curl fonts-noto-color-emoji \
  || sudo apt-get install -y chromium curl fonts-noto-color-emoji
CHROME="$(command -v chromium-browser || command -v chromium || echo chromium)"
echo "    Chromium: $CHROME"

echo "==> [2/6] Installo Ookla Speedtest CLI"
if command -v speedtest >/dev/null 2>&1; then
  echo "    Speedtest già presente: $(command -v speedtest)"
elif curl -fsSL "https://packagecloud.io/install/repositories/ookla/speedtest-cli/script.deb.sh" | sudo bash \
     && sudo apt-get install -y speedtest; then
  echo "    Speedtest installato: $(command -v speedtest)"
else
  echo "  !! ATTENZIONE: speedtest (Ookla) non installato, lo script prosegue comunque." >&2
  echo "     Per installarlo dopo:" >&2
  echo "       curl -s https://packagecloud.io/install/repositories/ookla/speedtest-cli/script.deb.sh | sudo bash" >&2
  echo "       sudo apt-get install -y speedtest" >&2
fi

echo "==> [3/6] Installo i file in $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  # ~/tvkiosk è già una repo: aggiorna
  git -C "$INSTALL_DIR" pull --ff-only || true
elif [ -n "${REPO_URL:-}" ]; then
  # installa direttamente da GitHub (così il tv-updater potrà aggiornarla)
  git clone "${REPO_URL}" "$INSTALL_DIR"
else
  # installazione da cartella locale (senza GitHub)
  mkdir -p "$INSTALL_DIR"
  cp -r "$REPO_DIR/scraper" "$REPO_DIR/web" "$INSTALL_DIR/"
  mkdir -p "$INSTALL_DIR/install"
  cp -rf "$REPO_DIR/install/." "$INSTALL_DIR/install/"
fi
chmod +x "$INSTALL_DIR/install/kiosk.sh" "$INSTALL_DIR/install/tv-update.sh" 2>/dev/null || true
mkdir -p "$INSTALL_DIR/web/img" "$INSTALL_DIR/web/data"

echo "==> [4/6] Prima esecuzione (test)"
python3 "$INSTALL_DIR/scraper/stasera_scraper.py" --out "$INSTALL_DIR/web" \
  || echo "  !! scraper in errore: controlla la connessione"
python3 "$INSTALL_DIR/scraper/speedtest_runner.py" --out "$INSTALL_DIR/web/data" \
  || echo "  !! speedtest in errore: controlla il binario 'speedtest'"

echo "==> [5/6] Installo i servizi systemd"
for f in tvserver tv-scraper tv-speedtest; do
  sed "s/__USER__/${USER_NAME}/g" "$REPO_DIR/install/${f}.service" \
    | sudo tee "/etc/systemd/system/${f}.service" >/dev/null
done
for f in tv-scraper tv-speedtest; do
  sudo cp "$REPO_DIR/install/${f}.timer" "/etc/systemd/system/${f}.timer"
done
sudo systemctl daemon-reload
sudo systemctl enable --now tvserver.service tv-scraper.timer tv-speedtest.timer

# auto-aggiornamento da GitHub: solo se ~/tvkiosk è una repo git
if [ -d "$INSTALL_DIR/.git" ]; then
  sed "s/__USER__/${USER_NAME}/g" "$REPO_DIR/install/tv-updater.service" \
    | sudo tee "/etc/systemd/system/tv-updater.service" >/dev/null
  sudo cp "$REPO_DIR/install/tv-updater.timer" "/etc/systemd/system/tv-updater.timer"
  sudo systemctl daemon-reload
  sudo systemctl enable --now tv-updater.timer
  echo "    Auto-aggiornamento GitHub attivo (git pull ogni 5 minuti)"
fi

echo "==> [6/6] Autostart del kiosk al boot + policy Chromium"
mkdir -p "$HOME/.config/autostart"
sed "s|__KIOSK__|${INSTALL_DIR}/install/kiosk.sh|g" "$REPO_DIR/install/tvkiosk.desktop" \
  > "$HOME/.config/autostart/tvkiosk.desktop"
cp "$REPO_DIR/install/no-blanking.desktop" "$HOME/.config/autostart/"

# policy di sistema: niente bolla "tradurre la pagina?", portachiavi, ecc.
for d in /etc/chromium/policies/managed /etc/chromium-browser/policies/managed; do
  sudo mkdir -p "$d"
  sudo cp "$REPO_DIR/install/chromium-kiosk-policy.json" "$d/kiosk.json"
done
echo "    Policy Chromium installata (translate/popup disattivati)"

cat <<EOF

Installazione completata!
- Riavvia il Pi per vedere il kiosk:   sudo reboot
- Il kiosk usa il launcher: $INSTALL_DIR/install/kiosk.sh
  (aspetta il web server e rilancia Chromium se si chiude)
- Log scraper:    journalctl -u tv-scraper.service -f
- Log speedtest:  journalctl -u tv-speedtest.service -f
- Disattiva tutto: sudo systemctl disable --now tv-scraper.timer tv-speedtest.timer

NOTA schermo: se lo schermo si spegne, in raspi-config ->
  Display Options -> Screen Blanking -> Disable
NOTA rotazione: usa Screen Configuration (menu Preferences) o
  'wlr-randr --output HDMI-A-1 --transform 90' su Wayland.
NOTA kiosk: se Chromium non appare, avvialo a mano con
  $INSTALL_DIR/install/kiosk.sh
    (o solo: kiosk, via SSH con DISPLAY=:0)
EOF
