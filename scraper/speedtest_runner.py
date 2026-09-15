#!/usr/bin/env python3
"""
Speedtest della rete di casa usando il CLI ufficiale Ookla (più veritiero
di speedtest-cli) con fallback a speedtest-cli se presente.

Installa Ookla Speedtest CLI sul Raspberry Pi (metodo ufficiale via packagecloud):
  curl -s https://packagecloud.io/install/repositories/ookla/speedtest-cli/script.deb.sh | sudo bash
  sudo apt-get install -y speedtest

Output:
  <out>/speedtest.json          -> ultimo risultato
  <out>/speedtest_history.json  -> storico (ultimi 7 giorni, 1 misura/ora)

Uso:
  python3 speedtest_runner.py --out /home/pi/tvkiosk/web/data
"""

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HISTORY_MAX = 168  # 7 giorni di misure orarie
TIMEOUT_SECS = 180


def _iso_now():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def run_ookla(binary):
    """CLI ufficiale Ookla: -f json restituisce bandwidth in byte/s."""
    proc = subprocess.run(
        [binary, "--accept-license", "--accept-gdpr", "-f", "json"],
        capture_output=True, text=True, timeout=TIMEOUT_SECS,
    )
    data = json.loads(proc.stdout.strip().splitlines()[-1])
    return {
        "timestamp": _iso_now(),
        "download_mbps": round(data["download"]["bandwidth"] * 8 / 1e6, 2),
        "upload_mbps": round(data["upload"]["bandwidth"] * 8 / 1e6, 2),
        "ping_ms": round(data["ping"]["latency"], 1),
        "server": (data.get("server") or {}).get("name", ""),
        "isp": data.get("isp", ""),
        "engine": "ookla",
        "ok": True,
    }


def run_speedtest_cli(binary):
    """Fallback: speedtest-cli (Python), bandwidth in bit/s."""
    proc = subprocess.run(
        [binary, "--json"], capture_output=True, text=True, timeout=TIMEOUT_SECS
    )
    data = json.loads(proc.stdout.strip())
    return {
        "timestamp": _iso_now(),
        "download_mbps": round(data.get("download", 0) / 1e6, 2),
        "upload_mbps": round(data.get("upload", 0) / 1e6, 2),
        "ping_ms": round(data.get("ping", 0), 1),
        "server": (data.get("server") or {}).get("name", ""),
        "isp": data.get("client", {}).get("isp", ""),
        "engine": "speedtest-cli",
        "ok": True,
    }


def main():
    ap = argparse.ArgumentParser(description="Speedtest orario con output JSON")
    ap.add_argument("--out", default="data", help="cartella dei JSON (default: ./data)")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    latest_path = out / "speedtest.json"
    history_path = out / "speedtest_history.json"

    result = None
    errors = []
    candidates = [
        ("speedtest", run_ookla),
        ("/usr/local/bin/speedtest", run_ookla),
        ("speedtest-cli", run_speedtest_cli),
    ]
    for binary, runner in candidates:
        path = shutil.which(binary) or (binary if binary.startswith("/") else None)
        if not path:
            continue
        try:
            result = runner(path)
            break
        except (subprocess.TimeoutExpired, subprocess.SubprocessError,
                json.JSONDecodeError, KeyError, IndexError, OSError) as e:
            errors.append(f"{binary}: {e}")

    if result is None:
        msg = "; ".join(errors) or "nessun binario speedtest trovato"
        print(f"ERRORE speedtest: {msg}", file=sys.stderr)
        # registra comunque il fallimento (ma NON cancella l'ultimo buon risultato)
        result = {"timestamp": _iso_now(), "ok": False, "error": msg}
        history = []
        if history_path.exists():
            try:
                history = json.loads(history_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                history = []
        history.append({"timestamp": result["timestamp"], "download_mbps": None,
                        "upload_mbps": None, "ping_ms": None, "ok": False})
        history_path.write_text(json.dumps(history[-HISTORY_MAX:], indent=1), encoding="utf-8")
        sys.exit(1)

    # salva ultimo risultato
    latest_path.write_text(json.dumps(result, indent=1), encoding="utf-8")

    # aggiorna lo storico
    history = []
    if history_path.exists():
        try:
            history = json.loads(history_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            history = []
    history.append({k: result.get(k) for k in
                    ("timestamp", "download_mbps", "upload_mbps", "ping_ms", "ok")})
    history_path.write_text(json.dumps(history[-HISTORY_MAX:], indent=1), encoding="utf-8")

    print(f"OK -> {result['download_mbps']} Mbps giù / {result['upload_mbps']} Mbps su / "
          f"{result['ping_ms']} ms ping ({result['engine']})")


if __name__ == "__main__":
    main()
