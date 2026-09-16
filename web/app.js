/* Dashboard kiosk: carosello prima serata + speedtest.
   Ricarica i dati ogni 5 minuti, ruota le slide ogni 12 secondi. */
"use strict";

const SLIDE_SECS = 12;
const REFRESH_MINUTES = 5;

const $ = (id) => document.getElementById(id);
const esc = (s) => (s || "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let programs = [];
let speed = null;
let history = [];
let meteo = null;
let idx = 0;

const NO_CACHE = { cache: "no-store" };

async function loadAll() {
  try {
    const [p, s, h, m] = await Promise.all([
      fetch("data/programmi.json", NO_CACHE).then((r) => (r.ok ? r.json() : null)),
      fetch("data/speedtest.json", NO_CACHE).then((r) => (r.ok ? r.json() : null)),
      fetch("data/speedtest_history.json", NO_CACHE).then((r) => (r.ok ? r.json() : [])),
      fetch("data/meteo.json", NO_CACHE).then((r) => (r.ok ? r.json() : null)),
    ]);
    if (p && p.programs && p.programs.length) {
      programs = p.programs;
      $("updated").textContent = "guida aggiornata: " + p.generated_at.replace("T", " ");
      if (idx >= programs.length) idx = 0;
    }
    if (s) { speed = s; renderSpeed(); }
    history = Array.isArray(h) ? h : [];
    drawSpark();
    meteo = m;
    renderWeather();
  } catch (e) {
    console.warn("load error:", e);
  }
}

/* ---------- carosello ---------- */
function renderSlide() {
  if (!programs.length) return;
  const p = programs[idx % programs.length];
  const slide = $("slide");
  slide.classList.remove("visible");

  setTimeout(() => {
    $("prog-img").src = p.image || "";
    $("prog-img").alt = p.title;
    $("prog-channel").textContent = p.channel;
    $("prog-chnum").textContent = p.channel_num ? "ch " + p.channel_num : "";
    $("prog-time").textContent = p.time;
    $("prog-genre").textContent = p.genre;
    $("prog-title").textContent = p.title;
    $("prog-desc").textContent = p.desc;
    const oa = findOnAir(p);
    const onair = $("onair");
    if (oa) {
      onair.classList.remove("hidden");
      $("onair-label").textContent = oa.upcoming ? "PROSSIMO IN ONDA" : "ORA IN ONDA";
      $("onair-title").textContent =
        oa.isPrime && !oa.upcoming ? p.title + "  —  IN ONDA ADESSO" : oa.title;
      $("onair-time").textContent = oa.range;
    } else {
      onair.classList.add("hidden");
    }
    renderDots();
    slide.classList.add("visible");
  }, 350);
}

function toMin(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

const fmtMin = (m) =>
  String(Math.floor((m / 60) % 24)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");

const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

/* Trova il programma in onda ORA sul canale della slide (gestisce anche
   i programmi passati mezzanotte). Restituisce {title, range, isPrime,
   upcoming} oppure il prossimo programma se nulla è in onda, o null. */
function findOnAir(p) {
  const sch = p.schedule || [];
  if (!sch.length) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const key = norm(p.title).slice(0, 18);
  const slots = sch.map((s, i) => {
    let start = toMin(s.time);
    if (start < 360) start += 1440;              // slot 00:00–05:59 = giorno dopo
    let end = i + 1 < sch.length ? toMin(sch[i + 1].time) : start + 240;
    if (end < 360) end += 1440;
    if (end <= start) end += 1440;
    return { title: s.title, start, end, raw: s.time };
  });
  for (const shift of [0, 1440]) {               // 1440 = dopo mezzanotte
    const t = nowMin + shift;
    for (const s of slots) {
      if (t >= s.start && t < s.end) {
        const st = norm(s.title).slice(0, 18);
        return {
          title: s.title,
          range: s.raw + " – " + fmtMin(s.end),
          isPrime: st.includes(key) || key.includes(st),
          upcoming: false,
        };
      }
    }
  }
  // nulla in onda adesso: mostra il prossimo in programma (se c'è)
  for (const s of slots) {
    if (s.start > nowMin && s.start < 1440) {
      return { title: s.title, range: "da " + s.raw, isPrime: false, upcoming: true };
    }
  }
  return null;
}

function renderDots() {
  const d = $("dots");
  d.innerHTML = "";
  programs.forEach((_, i) => {
    const s = document.createElement("span");
    if (i === idx % programs.length) s.className = "on";
    d.appendChild(s);
  });
}

function nextSlide() {
  if (!programs.length) return;
  idx = (idx + 1) % programs.length;
  renderSlide();
}

/* ---------- speedtest ---------- */
function renderSpeed() {
  if (speed.ok) {
    $("speed-down").textContent = speed.download_mbps.toFixed(1);
    $("speed-up").textContent = speed.upload_mbps.toFixed(1);
    $("speed-ping").textContent = Math.round(speed.ping_ms);
    $("speed-time").textContent =
      speed.timestamp.replace("T", " ").slice(0, 16) +
      (speed.server ? " · " + speed.server : "");
  } else {
    $("speed-time").textContent = "speedtest non disponibile";
  }
}

function drawSpark() {
  const cv = $("spark");
  const ctx = cv.getContext("2d");
  const w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  const vals = history.filter((x) => x.ok && x.download_mbps != null).slice(-48);
  if (vals.length < 2) return;
  const max = Math.max(...vals.map((v) => v.download_mbps), 10);
  ctx.beginPath();
  vals.forEach((v, i) => {
    const x = (i / (vals.length - 1)) * (w - 4) + 2;
    const y = h - 6 - (v.download_mbps / max) * (h - 14);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = "#4fd1a5";
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.lineTo(w - 2, h);
  ctx.lineTo(2, h);
  ctx.closePath();
  ctx.fillStyle = "rgba(79,209,165,.15)";
  ctx.fill();
}

/* ---------- meteo (Open-Meteo) ---------- */
function renderWeather() {
  const w = $("weather");
  if (!meteo || !meteo.days || !meteo.days.length) {
    w.classList.add("hidden");
    return;
  }
  w.classList.remove("hidden");
  w.querySelector(".weather-title").textContent = "METEO · " + (meteo.location || "");
  const cards = w.querySelectorAll(".w-card");
  meteo.days.slice(0, cards.length).forEach((d, i) => {
    const c = cards[i];
    c.querySelector(".w-label").textContent = d.label;
    c.querySelector(".w-icon").textContent = d.icon;
    c.querySelector(".w-desc").textContent = d.desc;
    c.querySelector(".w-tmax").textContent = d.t_max + "°";
    c.querySelector(".w-tmin").textContent = d.t_min + "°";
    c.querySelector(".w-rainp").textContent = "pioggia " + d.rain_prob + "%";
    c.querySelector(".w-rainmm").textContent = (d.rain_mm || 0) + " mm";
    c.querySelector(".w-wind").textContent = d.wind_kmh + " km/h";
  });
}

/* ---------- orologio ---------- */
function tickClock() {
  const n = new Date();
  $("clock").textContent = n.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  $("date").textContent = n.toLocaleDateString("it-IT",
    { weekday: "long", day: "numeric", month: "long" });
}

/* ricarica la pagina ogni 30 minuti per applicare gli aggiornamenti
   inviati da GitHub (git pull del tv-updater) senza riavviare il Pi */
setInterval(() => location.reload(), 30 * 60 * 1000);

/* ---------- avvio ---------- */
tickClock();
setInterval(tickClock, 1000);
loadAll();
setInterval(loadAll, REFRESH_MINUTES * 60 * 1000);
setInterval(nextSlide, SLIDE_SECS * 1000);
window.addEventListener("load", renderSlide);
