# 📺 Home TV Kiosk — Guida TV + Speedtest su Raspberry Pi

Soluzione per **Raspberry Pi 3B+ + piccolo schermo** che mostra in loop:
- **Carosello dei programmi in prima serata** (immagine, titolo, orario, canale, descrizione) scambiato dal sito [staseraintv.com](https://www.staseraintv.com/) ogni ora
- **Speedtest veritiero** della rete di casa (CLI ufficiale **Ookla**) ogni ora, con ultimo risultato + grafico storico 48h

Tutto gira **sul Pi**: nessun cloud, nessuna dipendenza Python (`pip install` non serve: lo scraper usa solo la libreria standard).

---

## Come funziona (architettura)

```
┌──────────────────────────── Raspberry Pi 3B+ ────────────────────────────┐
│                                                                          │
│  systemd timer ogni ora ──> scraper/stasera_scraper.py                   │
│                              └─> web/data/programmi.json + web/img/*.jpg │
│  systemd timer ogni ora ──> scraper/speedtest_runner.py  (Ookla CLI)     │
│                              └─> web/data/speedtest*.json                │
│                                                                          │
│  tvserver.service ──> python3 -m http.server 8080 (serve la cartella web)│
│  Chromium kiosk ──> http://localhost:8080  (carosello + speedtest)       │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Passo 1 — Prepara la SD con Raspberry Pi OS

1. Scarica **Raspberry Pi Imager** (https://www.raspberrypi.com/software/)
2. Scegli: **Raspberry Pi OS (other) → Raspberry Pi OS with desktop** (32 o 64 bit, va bene entrambi)
3. Con l'icona ⚙ (Personalizza) imposta:
   - **hostname**: `tvkiosk`
   - **SSH**: abilitato con password
   - **Autologin**: *Log in as user 'pi'* (fondamentale per il kiosk!)
   - Wi-Fi di casa (se non usi cavo)
4. Scrivi la SD, inserisci nel Pi, collega schermo e avvia.

## Passo 2 — Copia questo progetto sul Pi

**Modo consigliato — tramite GitHub** (vedi sezione più sotto per creare la repo):

```bash
REPO_URL=https://github.com/TUOUTENTE/guidatv-speedtest.git ./install/install.sh
```

**Oppure** dal tuo PC (PowerShell), senza GitHub:

```powershell
scp -r "C:\Users\ccardillo\Desktop\Repo\guidatv+speedtest" pi@tvkiosk:~/
```

(opure usa una chiavetta USB, o `git clone` se preferisci)

## Passo 3 — Installa tutto (un solo comando)

```bash
ssh pi@tvkiosk
cd ~/guidatv+speedtest
chmod +x install/install.sh
./install/install.sh
```

Lo script fa tutto:
1. installa **Chromium**
2. installa la **Speedtest CLI ufficiale Ookla** (più accurata di `speedtest-cli`)
3. copia i file in `~/tvkiosk`
4. esegue subito scraper + speedtest di prova (vedrai subito i risultati)
5. registra i **servizi systemd**: server web + timer orari
6. configura l'**avvio automatico di Chromium in modalità kiosk** al boot

Al termine riavvia:

```bash
sudo reboot
```

Lo schermo mostrerà la dashboard: carosello in alto, speedtest in basso. Fatto! 🎉

---

## Cosa vedrai sullo schermo

- **Orologio + data** in alto
- **Carosello**: una slide ogni 12 secondi per canale, con due informazioni distinte:
  - **▶ ORA IN ONDA** (barra verde lampeggiante): cosa sta andando in onda *adesso* su quel canale, con la fascia oraria (es. `20:30 – 21:20`) — gestisce anche i programmi passati mezzanotte; se è in onda proprio il programma della serata compare la dicitura "IN ONDA ADESSO"
  - **PRIMA SERATA STASERA**: il programma di punta di stasera con anteprima, canale, numero canale, orario di inizio, genere e descrizione
- **Speedtest**: Mbps download / upload, ping, orario dell'ultima misura e grafico dello storico delle ultime 48 ore
- I dati si ricaricano automaticamente ogni 5 minuti

## Personalizzazioni rapide

**Canali da mostrare** — lo scraper scambia **tutte le 7 pagine** della prima serata (~50 canali). Puoi scegliere cosa mostrare in due modi:

1. modificando la lista `CHANNELS_WHITELIST` in `scraper/stasera_scraper.py` (già preimpostata con ~45 canali principali);
2. eseguendo lo scraper con `--all-channels` per includere letteralmente tutti i canali trovati.

Altre opzioni dello scraper:

```bash
python3 stasera_scraper.py --pages 3          # solo le prime 3 pagine
python3 stasera_scraper.py --all-channels     # tutti i canali, niente whitelist
```

**Durata slide** — in `web/app.js`: `const SLIDE_SECS = 12;`
Con ~50 canali un giro completo dura ~10 minuti: se vuoi un giro più veloce, riduci i canali nella whitelist oppure la durata della slide.

**Meteo (oggi + domani)** — il pannello a destra delle slide usa **Open-Meteo** (gratuito, senza chiave API). Per impostare la tua città modifica in `scraper/stasera_scraper.py`:

```python
WEATHER_CITY = "Roma"     # <-- la tua città (coordinate automatiche)
WEATHER_LAT = None        # opzionale: precisione massima, es. 45.4642
WEATHER_LON = None        # opzionale: es. 9.1900
```

Le icone meteo usano **simboli standard** (☀ ☁ ☂ ❄ ⚡) presenti in qualsiasi font di sistema: non serve installare font aggiuntivi.

**Frequenza misure** — nei file `install/tv-*.timer` (attualmente: scraper alle `:10`, speedtest alle `:40` di ogni ora, per non farli sovrapporre).

**Rotazione dello schermo** — se lo schermo è verticale: `raspi-config → Display Options →` oppure dal desktop `Screen Configuration`.

## Comandi utili

```bash
# forzare subito scraper / speedtest
systemctl start tv-scraper.service
systemctl start tv-speedtest.service

# log in tempo reale
journalctl -u tv-scraper.service -f
journalctl -u tv-speedtest.service -f

# verificare che i timer siano attivi
systemctl list-timers | grep tv-

# disattivare tutto
sudo systemctl disable --now tv-scraper.timer tv-speedtest.timer
```

## 🔄 GitHub + aggiornamento in tempo reale

Tenere il progetto su GitHub conviene: backup, storico delle modifiche e — soprattutto — **aggiornamenti automatici del kiosk**.

### 1. Crea la repo e fai il primo push (dal PC)

```powershell
cd "C:\Users\ccardillo\Desktop\Repo\guidatv+speedtest"
git init
git add -A
git commit -m "TV kiosk: guida TV + speedtest"
git remote add origin https://github.com/TUOUTENTE/guidatv-speedtest.git
git push -u origin main
```

Su GitHub crea prima la repo (**privata va benissimo**, il progetto non contiene segreti).
`.gitignore` esclude già i file generati (`web/data/`, `web/img/`) e `.gitattributes` forza i fine riga LF, così gli script funzionano sul Pi anche se editati da Windows.

### 2. Installa sul Pi direttamente da GitHub

```bash
ssh pi@tvkiosk
git clone https://github.com/TUOUTENTE/guidatv-speedtest.git ~/tvkiosk
cd ~/tvkiosk
./install/install.sh
```

(lo script rileva che `~/tvkiosk` è una repo git e attiva anche l'**auto-aggiornamento**)

### 3. Come funziona l'aggiornamento "in tempo reale"

| Cosa | Frequenza | Meccanismo |
|---|---|---|
| Modifiche al codice/dashboard (push su GitHub) | **entro 5 minuti** | `tv-updater.timer` → `git pull` su `~/tvkiosk` |
| Applicazione a schermo | **entro 5 min** (o subito) | il kiosk ricarica la pagina da solo ogni 5 min; per l'istantaneo: `sudo systemctl restart tvserver` |
| Modifiche al launcher / flag del browser | **entro 5 min** | `tv-update.sh` riallinea l'autostart e riavvia il kiosk da solo |
| Guida TV (dati) | ogni ora | `tv-scraper.timer` |
| Speedtest | ogni ora | `tv-speedtest.timer` |
| Ricarica dati nel browser | ogni 5 min | `app.js` ri-legge i JSON |

**Flusso tipico**: modifichi `web/style.css` o la whitelist dello scraper sul PC → `git add -A && git commit -m "..." && git push` → il Pi fa pull entro 5 minuti → entro 5-10 minuti la modifica è a schermo. Per vederla subito:

```bash
ssh pi@tvkiosk 'sudo systemctl restart tvserver'
```

Nota: per una repo **privata** il Pi deve potersi autenticare — usa un *deploy key* (chiave SSH di sola lettura generata sul Pi, da aggiungere nelle impostazioni della repo su GitHub) oppure una repo pubblica.

### Aggiornare il Pi quando non usi GitHub

Copia di nuovo la cartella (scp o chiavetta) e rilancia `./install/install.sh`: è idempotente e aggiorna i file mantenendo i servizi già installati.

## Note & affidabilità

- **Lo scraper non cancella mai i dati vecchi**: se il sito non risponde o cambia layout, l'ultima guida resta visibile e l'errore finisce nei log.
- **Le anteprime sono scaricate in locale** (cache in `web/img/`): il carosello funziona anche se il sito è lento, e le immagini non vengono riscaricate se non cambiano.
- **Ookla CLI** è il client ufficiale di speedtest.net (gli stessi server e algoritmi dell'app) → misure veritiere; `speedtest-cli` (Python) è usato solo come fallback se Ookla non c'è.
- I JSON vengono scritti con `write + rename atomico`: nessun rischio di leggere file a metà.
- Per lo speedtest più preciso usa il Pi **via cavo Ethernet**; in Wi-Fi la misura riflette comunque la qualità del Wi-Fi.
- Lo schermo non va in standby grazie a `no-blanking.desktop`; se il tuo sistema lo spegne comunque: `raspi-config → Display Options → Screen Blanking → Disable`.

## 🛠️ Risoluzione problemi

### Errori "ext4 fs error" all'avvio (filesystem corrotto)

Indica microSD corrotta. Procedura di riparazione **dal Pi**:

```bash
# 1. forza un controllo e riparazione del filesystem al prossimo avvio
sudo sed -i 's/$/ fsck.mode=force fsck.repair=yes/' /boot/firmware/cmdline.txt
sudo reboot    # guarda lo schermo: fsck mostrerà le riparazioni

# 2. dopo il riavvio,togli il flag per non fsckare ogni volta
sudo sed -i 's/ fsck.mode=force fsck.repair=yes//' /boot/firmware/cmdline.txt

# 3. verifica che non tornino errori
sudo dmesg | grep -iE "ext4|I/O error|corrupt" | tail -20
```

**Se gli errori tornano** la scheda sta morendo: riflasha Raspberry Pi OS con Imager e riclona il progetto.

**Cause frequenti da eliminare**:
- **Alimentatore insufficiente**: il Pi 3B+ serve 2.5A reali. Verifica con `vcgencmd get_throttled` → `0x0` = ok; qualsiasi altro valore = tensione scarsa (usa l'alimentatore ufficiale, non un caricatore da telefono vecchio)
- **microSD di bassa qualità/clonata** (usa SanDisk/Samsung da 16-32 GB classe A1)
- **Spegnimento staccando la corrente**: usa sempre `sudo shutdown -h now` prima

### Il popup "tradurre la pagina?" (Google Translate)

Il progetto lo disattiva in due modi:

1. **policy di sistema** `/etc/chromium/policies/managed/kiosk.json` con `"TranslateEnabled": false`
   — è la via affidabile, i soli flag non bastano su tutte le versioni di Chromium
2. flag nel launcher `install/kiosk.sh`: `--lang=it --disable-translate --disable-features=Translate,TranslateUI,TranslateRanker`

Se il popup appare ancora, la policy non è installata: rilanciare `./install/install.sh`
(la copia) e poi `sudo reboot`.

### Il popup "sbloccare il portachiavi" a ogni riavvio

Con l'autologin il portachiavi GNOME non si sblocca da solo. Chromium del kiosk
già usa `--password-store=basic` (non tocca il portachiavi). Se il popup
comparesse ancora (es. per le password Wi-Fi salvate), azzera il portachiavi:

```bash
rm -rf ~/.local/share/keyrings
sudo reboot
```

(al prossimo avvio ne viene ricreato uno senza password — dovrai riscrivere
l'eventuale password Wi-Fi, una volta sola)

### Schermo nero dopo il riavvio (serve premere F5)

Se lo schermo resta nero, la prima cosa da fare è lanciare la diagnostica: raccoglie
in un unico output tutto quello che serve (sessione grafica, autostart, processo del
launcher, log di Chromium, stato del web server e dei dati).

```bash
bash ~/tvkiosk/install/diagnose.sh
```

Poi, per capire quale dei due anelli è rotto:

```bash
# il web server risponde?
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/     # atteso 200
systemctl status tvserver --no-pager | head -3

# il browser è vivo?
pgrep -a -f 'chromium.*localhost:8080' | head -3
tail -n 10 ~/kiosk.log                      # cosa ha fatto il launcher
tail -n 10 ~/kiosk-chrome.log               # errori di Chromium
```

I due casi tipici:

| Situazione | Causa | Rimedio |
|---|---|---|
| `curl` dà `200`, browser assente | Chromium non parte nella sessione grafica | `pgrep -a -f 'Xorg\|wayfire\|labwc'` per vedere la sessione, oppure avvia a mano `DISPLAY=:0 ~/tvkiosk/install/kiosk.sh &` |
| `curl` dà `000`/rifiuta | web server fermo, o dati mancanti | `sudo systemctl restart tvserver`, poi `systemctl start tv-scraper.service` |

Accadeva anche quando Chromium si avviava **prima** che il web server locale fosse
pronto: caricava la pagina di errore e non si riprendeva da solo.
Ora il kiosk parte da `install/kiosk.sh`, che:

- **aspetta** che `http://localhost:8080/` risponda prima di aprire il browser (max 3 minuti)
- controlla lo stato ogni 20 secondi: se Chromium si è chiuso o se il server era
  caduto, lo riapre da solo (nessun intervento manuale, nessun F5)

Per riavviare il kiosk a mano:

```bash
sudo systemctl restart tvserver           # se il server non risponde
~/tvkiosk/install/kiosk.sh &              # dal desktop del Pi
DISPLAY=:0 ~/tvkiosk/install/kiosk.sh &   # via SSH
```

### Chromium non parte

```bash
# avvialo da terminale per leggere l'errore
chromium-browser --incognito http://localhost:8080

# se è corrotto (spesso a causa del filesystem):
sudo apt install --reinstall -y chromium-browser
```

Il kiosk usa `--incognito`, quindi un profilo utente corrotto non blocca l'avvio.

### Il kiosk non parte al boot ma a mano sì

Verifica che ci sia l'autostart: `ls ~/.config/autostart/tvkiosk.desktop`. Se manca, rilancia `./install/install.sh` (fa solo il punto 6, è idempotente).

## Struttura del progetto


```
guidatv+speedtest/
├── scraper/
│   ├── stasera_scraper.py      # scraping guida TV (solo stdlib)
│   └── speedtest_runner.py     # speedtest orario -> JSON
├── web/
│   ├── index.html              # dashboard kiosk
│   ├── style.css
│   ├── app.js                  # carosello + grafico storico
│   ├── data/                   # programmi.json, speedtest*.json (generati)
│   └── img/                    # anteprime (generati, con cache)
├── install/
│   ├── install.sh              # setup automatico sul Pi
│   ├── kiosk.sh                # launcher kiosk (aspetta il server + watchdog)
│   ├── diagnose.sh             # diagnostica completa (schermo nero, browser, dati)
│   ├── chromium-kiosk-policy.json  # policy Chromium (no popup translate)
│   ├── tvserver.service        # web server locale :8080
│   ├── tv-scraper.service/.timer
│   ├── tv-speedtest.service/.timer
│   ├── tv-update.sh            # git pull + rigenera dati + riavvia kiosk
│   ├── tv-updater.service/.timer
│   ├── tvkiosk.desktop         # autostart del launcher kiosk
│   └── no-blanking.desktop
└── README.md
```
