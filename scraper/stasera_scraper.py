#!/usr/bin/env python3
"""
Scraper guida TV da staseraintv.com (prima serata).
Solo librerie standard di Python: nessuna dipendenza da installare.

Output:
  <out>/data/programmi.json   -> dati dei programmi in prima serata
  <out>/img/<hash>.jpg        -> anteprime scaricate localmente (con cache)

Uso:
  python3 stasera_scraper.py --out /home/pi/tvkiosk/web
"""

import argparse
import hashlib
import html
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

BASE_URL = "https://www.staseraintv.com/"
UA = (
    "Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Canali da mostrare nel carosello (match case-insensitive sul nome del sito).
# Modifica/aggiungi qui i tuoi canali preferiti. Con --all-channels vengono
# invece inclusi TUTTI i canali trovati sulle pagine.
CHANNELS_WHITELIST = [
    "Rai 1", "Rai 2", "Rai 3", "Rai 4", "Rai 5",
    "Rai Movie", "Rai Premium", "Rai Storia", "Rai Gulp", "Rai YoYo", "Rai Scuola", "Rai Sport",
    "Canale 5", "Italia 1", "Rete 4", "La7", "La7 Cinema", "Canale 20",
    "TV8", "NOVE", "Cielo", "Iris", "Cine 34", "La 5", "Italia 2",
    "Top Crime", "Giallo", "Mediaset Extra", "Twentyseven",
    "TV2000", "Boing", "Cartoonito", "K2", "Frisbee", "DeaKids", "Super!",
    "Food Network", "DMAX", "RealTime", "Focus TV", "Discovery",
    "HGTV", "Travel TV", "Donna TV", "iL 61", "Italia 7 Gold",
    "SportItalia", "Telereporter", "Alma TV",
]

# Ordine del carosello: i canali principali prima, gli altri in fondo.
CHANNEL_ORDER = [
    "Rai 1", "Rai 2", "Rai 3", "Rai 4", "Canale 5", "Italia 1",
    "Rete 4", "La7", "TV8", "NOVE", "Canale 20", "Cielo",
    "Rai 5", "Rai Movie", "Rai Premium", "Iris", "Cine 34", "La 5",
    "Italia 2", "Top Crime", "Giallo", "La7 Cinema", "Twentyseven",
    "DMAX", "RealTime", "Discovery", "Focus TV", "HGTV", "Food Network",
    "TV2000", "Boing", "Cartoonito", "K2", "Frisbee", "DeaKids", "Super!",
    "Rai Gulp", "Rai YoYo", "Rai Storia", "Rai Scuola", "Rai Sport",
    "Mediaset Extra", "Travel TV", "Donna TV", "iL 61",
    "Italia 7 Gold", "SportItalia", "Telereporter", "Alma TV",
]

# palinsesto completo della giornata nelle pagine dei singoli canali
FULL_SCHED_RE = re.compile(r"<h4[^>]*>\s*(\d{1,2}:\d{2}\s*-.*?)</h4>", re.S | re.I)

# ---------------- METEO (Open-Meteo, gratuito, senza chiave API) ----------------
# CAMBIA la città con la tua! Le coordinate le trova da solo. Se vuoi la massima
# precisione inserisci direttamente lat/lon (es. Milano: 45.4642 / 9.1900).
WEATHER_CITY = "Roma"
WEATHER_LAT = None          # es. 45.4642
WEATHER_LON = None          # es. 9.1900

WMO_CODES = {               # codici WMO -> (descrizione, icona)
    0: ("Sereno", "☀️"), 1: ("Preval. sereno", "🌤️"), 2: ("Parz. nuvoloso", "⛅"),
    3: ("Coperto", "☁️"), 45: ("Nebbia", "🌫️"), 48: ("Nebbia brinata", "🌫️"),
    51: ("Pioviggine", "🌦️"), 53: ("Pioviggine", "🌦️"), 55: ("Pioviggine fitta", "🌦️"),
    56: ("Pioviggine gelata", "🌧️"), 57: ("Pioviggine gelata", "🌧️"),
    61: ("Pioggia debole", "🌧️"), 63: ("Pioggia", "🌧️"), 65: ("Pioggia forte", "🌧️"),
    66: ("Pioggia gelata", "🌧️"), 67: ("Pioggia gelata", "🌧️"),
    71: ("Neve debole", "❄️"), 73: ("Neve", "❄️"), 75: ("Neve fitta", "❄️"),
    77: ("Nevischio", "❄️"), 80: ("Rovesci deboli", "🌦️"), 81: ("Rovesci", "🌧️"),
    82: ("Rovesci forti", "🌧️"), 85: ("Rovesci di neve", "🌨️"), 86: ("Rovesci di neve", "🌨️"),
    95: ("Temporale", "⛈️"), 96: ("Temporale grandine", "⛈️"), 99: ("Temporale grandine", "⛈️"),
}

TIMEOUT_SECS = 20

# --- espressioni regolari di estrazione (struttura HTML del sito, stabile) ---
BLOCK_SPLIT = re.compile(r'<div class="singlechprevbox">')
CHANNEL_RE = re.compile(
    r'<a href="/programmi_stasera_[^"]+"\s+class="([^"]+)">\s*(.*?)\s*</a>', re.S)
CHNUM_RE = re.compile(r"<chnum>\s*(\d+)\s*</chnum>")
TIME_RE = re.compile(r"<big><big>\s*(\d{1,2}:\d{2})\s*</big></big>")
TITLE_RE = re.compile(r'<span style=" font-weight: normal">\s*(.*?)\s*</span>', re.S)
DESC_RE = re.compile(r'class="prgpreviewtext">\s*(.*?)<a\b', re.S)
IMGS_RE = re.compile(r'src="(/scheda/[^"]+)"')
SCHEDULE_RE = re.compile(r'<p style="text-align:left;font-size:14px">(.*?)</p>', re.S)
SCHED_LINE_RE = re.compile(r"(\d{1,2}:\d{2})\s*-\s*(.*)")
GENRE_RE = re.compile(r"\(([^()]+)\)\s*$")


def clean_text(s: str) -> str:
    """Rimuove tag HTML, decodifica entità e normalizza gli spazi."""
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def normalize(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip().lower()


def fetch(url: str) -> bytes:
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECS, context=ctx) as resp:
        return resp.read()


def parse_page(raw_html: str, all_channels: bool = False):
    """Estrae i programmi 'prima serata' da una pagina della guida."""
    programs, seen = [], set()
    for chunk in BLOCK_SPLIT.split(raw_html)[1:]:
        m_channel = CHANNEL_RE.search(chunk)
        m_time = TIME_RE.search(chunk)
        m_title = TITLE_RE.search(chunk)
        if not (m_channel and m_time and m_title):
            continue

        channel = clean_text(m_channel.group(2))
        key = normalize(channel)
        if key in seen:
            continue
        seen.add(key)

        if not all_channels and not any(
                key == normalize(c) or normalize(c) in key for c in CHANNELS_WHITELIST):
            continue

        title_raw = clean_text(m_title.group(1))
        genre = ""
        g = GENRE_RE.search(title_raw)
        if g:
            genre = g.group(1).strip()
            title_raw = title_raw[: g.start()].strip(" -")

        # immagine: preferisce la thumb dentro /scheda/
        img_src = ""
        imgs = IMGS_RE.findall(chunk)
        thumbs = [i for i in imgs if "thumb" in i]
        if thumbs:
            img_src = thumbs[0]
        elif imgs:
            img_src = imgs[0]

        # descrizione
        desc = ""
        m_desc = DESC_RE.search(chunk)
        if m_desc:
            desc = clean_text(m_desc.group(1))[:400]

        # programmazione completa del canale (da listingprevbox)
        schedule = []
        m_sched = SCHEDULE_RE.search(chunk)
        if m_sched:
            for line in m_sched.group(1).split("<br>"):
                lm = SCHED_LINE_RE.search(clean_text(line))
                if lm and lm.group(2):
                    schedule.append({"time": lm.group(1), "title": lm.group(2)})

        slug = m_channel.group(1).split()[0] if m_channel.group(1) else ""
        programs.append({
            "channel": channel,
            "channel_num": CHNUM_RE.search(chunk).group(1) if CHNUM_RE.search(chunk) else "",
            "channel_slug": slug,
            "time": m_time.group(1),
            "title": title_raw,
            "genre": genre,
            "desc": desc,
            "image_remote": (BASE_URL.rstrip("/") + img_src) if img_src else "",
            "url": (BASE_URL.rstrip("/") + "/programmi_stasera_" + slug + ".html") if slug else "",
            "schedule": schedule,
        })

    programs.sort(key=lambda p: p["time"])
    return programs

def download_images(programs, img_dir: Path):
    """Scarica le anteprime in locale (con cache: salta se già presenti)."""
    img_dir.mkdir(parents=True, exist_ok=True)
    for p in programs:
        url = p["image_remote"]
        if not url:
            p["image"] = ""
            continue
        ext = ".jpg"
        m = re.search(r"\.(jpe?g|png|gif)$", url, re.I)
        if m:
            ext = "." + m.group(1).lower()
        fname = hashlib.md5(url.encode()).hexdigest() + ext
        dest = img_dir / fname
        if not dest.exists() or dest.stat().st_size == 0:
            try:
                dest.write_bytes(fetch(url))
            except (urllib.error.URLError, OSError, ssl.SSLError) as e:
                print(f"  ! immagine non scaricata ({url}): {e}", file=sys.stderr)
                if not dest.exists():
                    p["image_remote"] = ""
                    p["image"] = ""
                    continue
        p["image"] = "img/" + fname


def fetch_full_schedule(url: str):
    """Dal canale dedicato: palinsesto completo della giornata (06:00 -> notte)."""
    raw = fetch(url).decode("utf-8", errors="replace")
    m = FULL_SCHED_RE.search(raw)
    if not m:
        return None
    schedule = []
    for line in m.group(1).split("<br>"):
        lm = SCHED_LINE_RE.search(clean_text(line))
        if lm and lm.group(2):
            schedule.append({"time": lm.group(1), "title": lm.group(2)})
    return schedule or None


def channel_priority(name: str) -> int:
    """Posizione del canale in CHANNEL_ORDER (prima corrispondenza esatta,
    poi per sottostringa; i canali fuori lista vanno in fondo)."""
    key = normalize(name)
    keys = [normalize(c) for c in CHANNEL_ORDER]
    for i, c in enumerate(keys):
        if key == c:
            return i
    for i, c in enumerate(keys):
        if c in key:
            return i
    return len(keys)


def geolocate(city: str):
    """Coordinate di una città tramite il geocoding di Open-Meteo."""
    url = ("https://geocoding-api.open-meteo.com/v1/search?name="
           + urllib.parse.quote(city) + "&count=1&language=it&format=json")
    data = json.loads(fetch(url).decode("utf-8", errors="replace"))
    results = data.get("results") or []
    if not results:
        return None
    r = results[0]
    return {"lat": r["latitude"], "lon": r["longitude"], "name": r.get("name", city)}


def fetch_weather():
    """Previsioni oggi + domani da Open-Meteo (senza chiave API)."""
    lat, lon, name = WEATHER_LAT, WEATHER_LON, WEATHER_CITY
    if lat is None or lon is None:
        loc = geolocate(WEATHER_CITY)
        if not loc:
            return None
        lat, lon, name = loc["lat"], loc["lon"], loc["name"]

    url = (f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
           "&daily=weather_code,temperature_2m_max,temperature_2m_min,"
           "precipitation_probability_max,precipitation_sum,wind_speed_10m_max"
           "&timezone=Europe%2FBerlin&forecast_days=3")
    data = json.loads(fetch(url).decode("utf-8", errors="replace"))
    d = data["daily"]
    labels = ["Oggi", "Domani"]
    days = []
    for i in range(min(2, len(d["time"]))):
        desc, icon = WMO_CODES.get(int(d["weather_code"][i]), ("—", "🌡️"))
        days.append({
            "date": d["time"][i],
            "label": labels[i] if i < len(labels) else d["time"][i],
            "t_max": round(d["temperature_2m_max"][i]),
            "t_min": round(d["temperature_2m_min"][i]),
            "rain_prob": d["precipitation_probability_max"][i] or 0,
            "rain_mm": round(d["precipitation_sum"][i] or 0, 1),
            "wind_kmh": round(d["wind_speed_10m_max"][i] or 0),
            "desc": desc, "icon": icon,
        })
    return {
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "location": name,
        "days": days,
    }


def main():
    ap = argparse.ArgumentParser(description="Scraper prima serata staseraintv.com")
    ap.add_argument("--out", default="web", help="cartella web di destinazione (default: ./web)")
    ap.add_argument("--pages", type=int, default=7,
                    help="quante pagine della guida scambiare (default: 7, tutte)")
    ap.add_argument("--all-channels", action="store_true",
                    help="includi TUTTI i canali trovati, non solo la whitelist")
    ap.add_argument("--no-full-schedule", action="store_true",
                    help="salta il palinsesto completo giornaliero (più veloce, "
                         "ma la barra ORA IN ONDA è precisa solo la sera)")
    ap.add_argument("--no-meteo", action="store_true",
                    help="salta il recupero delle previsioni meteo")
    args = ap.parse_args()

    out = Path(args.out)
    (out / "data").mkdir(parents=True, exist_ok=True)

    urls = [BASE_URL] + [f"{BASE_URL}index{i}.html" for i in range(2, args.pages + 1)]
    programs, seen, ok_pages = [], set(), 0
    for url in urls:
        print(f"Scarico {url} ...")
        try:
            raw = fetch(url).decode("utf-8", errors="replace")
        except (urllib.error.URLError, OSError, ssl.SSLError) as e:
            # una pagina che fallisce non blocca le altre
            print(f"  ! pagina non disponibile: {e}", file=sys.stderr)
            continue
        ok_pages += 1
        for p in parse_page(raw, args.all_channels):
            key = normalize(p["channel"])
            if key in seen:          # stesso canale su più pagine: tiene la 1a
                continue
            seen.add(key)
            programs.append(p)

    if not programs:
        print("ERRORE: nessun programma estratto (il sito è cambiato?)", file=sys.stderr)
        sys.exit(2)

    # palinsesto completo della giornata dalle pagine dei singoli canali
    # (la homepage copre solo la fascia serale; con questo la barra
    #  "ORA IN ONDA" è corretta a qualunque ora del giorno)
    if not args.no_full_schedule:
        print("Scarico i palinsesti completi delle giornate ...")
        for p in programs:
            if not p["url"]:
                continue
            try:
                full = fetch_full_schedule(p["url"])
                if full:
                    p["schedule"] = full
            except (urllib.error.URLError, OSError, ssl.SSLError) as e:
                # in caso di errore resta il palinsesto serale della homepage
                print(f"  ! palinsesto completo non disponibile per "
                      f"{p['channel']}: {e}", file=sys.stderr)
            time.sleep(0.15)   # gentilezza verso il sito

    # ordine del carosello: canali principali prima, poi per orario
    programs.sort(key=lambda p: (channel_priority(p["channel"]), p["time"]))
    print(f"Trovati {len(programs)} programmi su {ok_pages}/{len(urls)} pagine, "
          f"scarico le anteprime ...")
    download_images(programs, out / "img")

    payload = {
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": BASE_URL,
        "pages": ok_pages,
        "programs": programs,
    }
    dest = out / "data" / "programmi.json"
    tmp = dest.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(dest)

    for p in programs:
        print(f"  {p['time']}  {p['channel']:<20} {p['title']}")

    # meteo oggi + domani (Open-Meteo, gratuito, senza chiave API)
    if not args.no_meteo:
        try:
            meteo = fetch_weather()
            if meteo:
                mdest = out / "data" / "meteo.json"
                mtmp = mdest.with_suffix(".tmp")
                mtmp.write_text(json.dumps(meteo, ensure_ascii=False, indent=1),
                                encoding="utf-8")
                mtmp.replace(mdest)
                d0 = meteo["days"][0]
                print(f"Meteo {meteo['location']}: oggi {d0['desc']} {d0['t_max']}°, "
                      f"pioggia {d0['rain_prob']}% ({d0['rain_mm']} mm), "
                      f"vento {d0['wind_kmh']} km/h")
        except (urllib.error.URLError, OSError, ssl.SSLError, json.JSONDecodeError,
                KeyError, ValueError) as e:
            print(f"  ! meteo non disponibile: {e}", file=sys.stderr)

    print(f"OK -> {dest}")


if __name__ == "__main__":
    main()

