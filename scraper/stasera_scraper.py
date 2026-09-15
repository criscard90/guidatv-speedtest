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
import urllib.error
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


def main():
    ap = argparse.ArgumentParser(description="Scraper prima serata staseraintv.com")
    ap.add_argument("--out", default="web", help="cartella web di destinazione (default: ./web)")
    ap.add_argument("--pages", type=int, default=7,
                    help="quante pagine della guida scambiare (default: 7, tutte)")
    ap.add_argument("--all-channels", action="store_true",
                    help="includi TUTTI i canali trovati, non solo la whitelist")
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

    programs.sort(key=lambda p: p["time"])
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
    print(f"OK -> {dest}")


if __name__ == "__main__":
    main()

