'use strict';

/* ===================== Grunddata ===================== */

const STORE_KEY = 'stampelklocka.v1';
const DUPLICATE_MS = 2 * 60 * 1000;   // samma stämpling inom 2 min räknas som dubbelskanning
const STALE_MS = 16 * 60 * 60 * 1000; // pass öppet längre än så = glömt stämpla ut

const TYPES = {
  in:        { label: 'Kom in',       verb: 'Instämplad' },
  lunch_out: { label: 'Lunch början', verb: 'Lunch påbörjad' },
  lunch_in:  { label: 'Lunch slut',   verb: 'Tillbaka från lunch' },
  out:       { label: 'Gick hem',     verb: 'Utstämplad' },
};

// Vad en QR-kod betyder. "lunch" och "auto" tolkas utifrån nuvarande status.
const QR_KINDS = {
  in:    { title: 'Kom till jobbet', text: 'Stämpla in när du kommer' },
  lunch: { title: 'Lunch',           text: 'Skanna när du går på och kommer tillbaka från lunch' },
  out:   { title: 'Gå hem',          text: 'Stämpla ut när du går för dagen' },
  auto:  { title: 'Stämpla',         text: 'En kod för allt – appen frågar vid behov' },
};

const SOURCES = { button: 'knapp', qr: 'QR', manual: 'manuell' };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ===================== Lagring ===================== */

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      return {
        events: Array.isArray(data.events) ? data.events.filter(isValidEvent) : [],
        settings: Object.assign(defaultSettings(), data.settings || {}),
      };
    }
  } catch (e) {
    console.error('Kunde inte läsa sparad data', e);
  }
  return { events: [], settings: defaultSettings() };
}

function defaultSettings() {
  return { vibrate: true, qrBase: '' };
}

function save() {
  state.events.sort((a, b) => a.ts - b.ts);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('Kunde inte spara! Är lagringen full?');
  }
}

function isValidEvent(e) {
  return e && typeof e.id === 'string' && TYPES[e.type] && Number.isFinite(e.ts);
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

let state = load();

/* ===================== Datum & format ===================== */

const pad = (n) => String(n).padStart(2, '0');

function dateKey(d) {
  d = new Date(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfDay(d) {
  d = new Date(d);
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDur(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}

function fmtHM(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  return `${Math.floor(totalMin / 60)}:${pad(totalMin % 60)}`;
}

function fmtDayName(key) {
  return keyToDate(key).toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'short' });
}

function toLocalInput(ts) {
  const d = new Date(ts);
  return `${dateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value) {
  const [date, time] = value.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi).getTime();
}

// ISO-vecka, returnerar t.ex. { year: 2026, week: 44 }
function isoWeek(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (t.getDay() + 6) % 7; // mån = 0
  t.setDate(t.getDate() - day + 3);
  const firstThu = new Date(t.getFullYear(), 0, 4);
  const week = 1 + Math.round(((t - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return { year: t.getFullYear(), week };
}

/* ===================== Beräkning ===================== */

/**
 * Går igenom alla stämplingar i tidsordning och räknar ut arbetstid och lunch
 * per dag, samt nuvarande status. Pass som aldrig avslutades (glömt stämpla ut)
 * räknas inte och dagen markeras som ofullständig.
 */
function analyze(events, now = Date.now()) {
  const days = new Map();
  const day = (key) => {
    if (!days.has(key)) days.set(key, { key, work: 0, lunch: 0, events: [], incomplete: false });
    return days.get(key);
  };

  // Lägg till ett tidsintervall, delat vid midnatt.
  const addSpan = (field, from, to) => {
    let start = from;
    while (start < to) {
      const nextMidnight = startOfDay(start).getTime() + 86400000;
      const end = Math.min(to, nextMidnight);
      day(dateKey(start))[field] += end - start;
      start = end;
    }
  };

  let workStart = null;
  let lunchStart = null;
  let last = null;

  const dropOpen = () => {
    const ts = workStart ?? lunchStart;
    if (ts != null) day(dateKey(ts)).incomplete = true;
    workStart = lunchStart = null;
  };

  for (const e of events) {
    day(dateKey(e.ts)).events.push(e);

    // Öppet pass från en tidigare dag som aldrig avslutades.
    const open = workStart ?? lunchStart;
    if (open != null && e.ts - open > STALE_MS) dropOpen();

    switch (e.type) {
      case 'in':
      case 'lunch_in':
        if (lunchStart != null) { addSpan('lunch', lunchStart, e.ts); lunchStart = null; }
        if (workStart == null) workStart = e.ts;
        break;
      case 'lunch_out':
        if (workStart != null) { addSpan('work', workStart, e.ts); workStart = null; }
        if (lunchStart == null) lunchStart = e.ts;
        break;
      case 'out':
        if (workStart != null) addSpan('work', workStart, e.ts);
        if (lunchStart != null) addSpan('lunch', lunchStart, e.ts);
        workStart = lunchStart = null;
        break;
    }
    last = e;
  }

  let status = 'off';
  let since = null;
  let stale = null;
  const open = workStart ?? lunchStart;
  if (open != null) {
    if (now - last.ts > STALE_MS) {
      stale = last;
      dropOpen();
    } else {
      status = workStart != null ? 'working' : 'lunch';
      since = last.ts;
      if (workStart != null) addSpan('work', workStart, now);
      else addSpan('lunch', lunchStart, now);
    }
  }

  return { days, status, since, stale, last };
}

/* ===================== Stämpling ===================== */

function addEvent(type, src, ts = Date.now()) {
  const info = analyze(state.events);
  const last = info.last;
  if (src !== SOURCES.manual && last && last.type === type && ts - last.ts < DUPLICATE_MS) {
    toast(`Redan registrerat kl ${fmtTime(last.ts)}`);
    return;
  }
  state.events.push({ id: newId(), type, ts, src });
  save();
  requestPersistence();
  if (state.settings.vibrate && navigator.vibrate) navigator.vibrate(type === 'out' ? [60, 60, 60] : 80);
  toast(`${TYPES[type].verb} ${fmtTime(ts)} ✓`);
  render();
}

// Tolka en QR-kod (eller länk) utifrån nuvarande status.
async function handleKind(kind, src) {
  const { status, since } = analyze(state.events);
  const sinceTxt = since ? ` sedan ${fmtTime(since)}` : '';

  if (kind === 'in') {
    if (status === 'off') return addEvent('in', src);
    if (status === 'lunch') return addEvent('lunch_in', src);
    return toast(`Du är redan instämplad${sinceTxt}`);
  }

  if (kind === 'lunch') {
    if (status === 'working') return addEvent('lunch_out', src);
    if (status === 'lunch') return addEvent('lunch_in', src);
    const ok = await choose('Inte instämplad', 'Du är inte instämplad. Vill du stämpla in nu?', [
      { label: 'Stämpla in', value: 'in' },
    ]);
    if (ok) addEvent(ok, src);
    return;
  }

  if (kind === 'out') {
    if (status !== 'off') return addEvent('out', src);
    return toast('Du är redan utstämplad');
  }

  if (kind === 'auto') {
    if (status === 'off') return addEvent('in', src);
    if (status === 'lunch') return addEvent('lunch_in', src);
    const pick = await choose('Vad vill du göra?', `Du är instämplad${sinceTxt}.`, [
      { label: 'Gå på lunch', value: 'lunch_out', cls: 'lunch' },
      { label: 'Gå hem', value: 'out', cls: 'out' },
    ]);
    if (pick) addEvent(pick, src);
  }
}

// Plockar ut stämpeltyp ur QR-text. Accepterar länkar (…?stamp=in) och "stampel:in".
function parseQr(text) {
  text = String(text || '').trim();
  let kind = null;
  try {
    kind = new URL(text).searchParams.get('stamp');
  } catch (_) {
    const m = /^stampel:(\w+)$/i.exec(text);
    if (m) kind = m[1].toLowerCase();
  }
  return QR_KINDS[kind] ? kind : null;
}

/* ===================== Rendering ===================== */

function render() {
  renderToday();
  if ($('#view-history').classList.contains('active')) renderHistory();
}

function renderToday() {
  const info = analyze(state.events);
  const todayKey = dateKey(Date.now());
  const today = info.days.get(todayKey);

  const card = $('#status-card');
  card.className = `card status ${info.status}`;
  $('#status-label').textContent = {
    off: 'Inte instämplad',
    working: 'Instämplad',
    lunch: 'På lunch',
  }[info.status];

  const sinceEl = $('#status-since');
  sinceEl.textContent = '';
  if (info.since) {
    const d = dateKey(info.since) === todayKey ? '' : `${fmtDayName(dateKey(info.since))} `;
    sinceEl.textContent = `Sedan ${d}${fmtTime(info.since)}`;
  } else if (info.stale) {
    const btn = document.createElement('button');
    btn.className = 'link';
    btn.type = 'button';
    btn.textContent = `Glömt stämpla ut ${fmtDayName(dateKey(info.stale.ts))}? Rätta här`;
    btn.onclick = () => openEdit(null, { type: 'out', ts: info.stale.ts + 60000 });
    sinceEl.append(btn);
  }

  $('#today-worked').textContent = fmtDur(today ? today.work : 0);
  $('#today-lunch').textContent = fmtDur(today ? today.lunch : 0);

  const w = isoWeek(new Date());
  let weekMs = 0;
  for (const d of info.days.values()) {
    const dw = isoWeek(keyToDate(d.key));
    if (dw.year === w.year && dw.week === w.week) weekMs += d.work;
  }
  $('#week-worked').textContent = fmtDur(weekMs);

  // Knappar beroende på status
  const actions = $('#actions');
  actions.innerHTML = '';
  const btn = (type, label, sub, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn action ${cls || ''}`;
    b.innerHTML = `<span>${label}</span>${sub ? `<small>${sub}</small>` : ''}`;
    b.onclick = () => addEvent(type, SOURCES.button);
    actions.append(b);
  };
  if (info.status === 'off') {
    btn('in', 'Kom in', 'Stämpla in', 'full');
  } else if (info.status === 'working') {
    btn('lunch_out', 'Lunch', 'Gå på lunch', 'lunch');
    btn('out', 'Gå hem', 'Stämpla ut', 'out');
  } else {
    btn('lunch_in', 'Tillbaka', 'Lunch slut', '');
    btn('out', 'Gå hem', 'Stämpla ut', 'out');
  }

  renderEventList($('#today-list'), today ? today.events : [], 'Inga stämplingar idag');
}

function renderEventList(ul, events, emptyText) {
  ul.innerHTML = '';
  if (!events.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    ul.append(li);
    return;
  }
  for (const e of events) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="dot ${e.type}"></span>
      <span class="event-time">${fmtTime(e.ts)}</span>
      <span>${TYPES[e.type].label}${e.note ? `<br><span class="event-note"></span>` : ''}</span>
      <span class="event-src"></span>`;
    if (e.note) li.querySelector('.event-note').textContent = e.note;
    li.querySelector('.event-src').textContent = e.src || '';
    li.onclick = () => openEdit(e);
    ul.append(li);
  }
}

let historyWeeks = 6;

function renderHistory() {
  const info = analyze(state.events);
  const root = $('#history');
  root.innerHTML = '';

  const keys = Array.from(info.days.keys()).filter((k) => info.days.get(k).events.length || info.days.get(k).work);
  keys.sort().reverse();

  if (!keys.length) {
    root.innerHTML = '<div class="card muted">Inga stämplingar än.</div>';
    return;
  }

  // Gruppera per vecka
  const weeks = [];
  for (const k of keys) {
    const w = isoWeek(keyToDate(k));
    const id = `${w.year}-${w.week}`;
    let wk = weeks[weeks.length - 1];
    if (!wk || wk.id !== id) weeks.push(wk = { id, w, days: [] });
    wk.days.push(info.days.get(k));
  }

  for (const wk of weeks.slice(0, historyWeeks)) {
    const sec = document.createElement('div');
    sec.className = 'week';
    const total = wk.days.reduce((s, d) => s + d.work, 0);
    sec.innerHTML = `<div class="week-head"><span>Vecka ${wk.w.week}${wk.w.year !== new Date().getFullYear() ? ` ${wk.w.year}` : ''}</span><span>${fmtDur(total)}</span></div>`;
    for (const d of wk.days) {
      const det = document.createElement('details');
      det.className = 'card day';
      det.innerHTML = `
        <summary>
          <span class="day-name">${fmtDayName(d.key)}${d.incomplete ? ' ⚠️' : ''}</span>
          <span class="day-sum">${fmtDur(d.work)}<small>${d.lunch ? `lunch ${fmtDur(d.lunch)}` : ''}${d.incomplete ? ' utstämpling saknas' : ''}</small></span>
        </summary>
        <ul class="event-list"></ul>`;
      renderEventList(det.querySelector('ul'), d.events, 'Inga stämplingar');
      sec.append(det);
    }
    root.append(sec);
  }

  if (weeks.length > historyWeeks) {
    const more = document.createElement('button');
    more.className = 'btn secondary load-more';
    more.type = 'button';
    more.textContent = 'Visa fler veckor';
    more.onclick = () => { historyWeeks += 6; renderHistory(); };
    root.append(more);
  }
}

/* ===================== QR-koder ===================== */

function defaultQrBase() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

function qrBase() {
  return state.settings.qrBase || defaultQrBase();
}

function qrUrl(kind) {
  const u = new URL(qrBase());
  u.searchParams.set('stamp', kind);
  return u.toString();
}

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
}

function renderQr() {
  $('#qr-base').value = qrBase();
  const grid = $('#qr-grid');
  grid.innerHTML = '';
  for (const [kind, k] of Object.entries(QR_KINDS)) {
    const card = document.createElement('div');
    card.className = 'qr-card';
    let svg;
    try {
      svg = qrSvg(qrUrl(kind));
    } catch (e) {
      svg = '<p>Ogiltig adress</p>';
    }
    card.innerHTML = `<h3>${k.title}</h3>${svg}<p>${k.text}</p>`;
    grid.append(card);
  }
}

/* ===================== Skanner ===================== */

let scanStream = null;
let scanTimer = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}

async function makeDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const det = new BarcodeDetector({ formats: ['qr_code'] });
        return async (video) => {
          const codes = await det.detect(video);
          return codes.map((c) => c.rawValue);
        };
      }
    } catch (_) { /* faller tillbaka på jsQR */ }
  }
  if (!window.jsQR) await loadScript('vendor/jsQR.js');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return code ? [code.data] : [];
  };
}

async function openScanner() {
  const dlg = $('#scanner');
  const video = $('#scan-video');
  const msg = $('#scan-msg');
  msg.textContent = 'Startar kameran…';
  dlg.showModal();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    msg.textContent = 'Kameran är inte tillgänglig här. Appen måste öppnas via https.';
    return;
  }

  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (e) {
    msg.textContent = 'Fick inte använda kameran. Tillåt kamera för appen i telefonens inställningar.';
    return;
  }
  if (!dlg.open) return closeScanner();

  video.srcObject = scanStream;
  try { await video.play(); } catch (_) { /* iOS kan kräva playsinline, redan satt */ }

  let detect;
  try {
    detect = await makeDetector();
  } catch (e) {
    msg.textContent = 'Kunde inte starta QR-läsaren.';
    return;
  }
  msg.textContent = 'Rikta kameran mot QR-koden';

  const tick = async () => {
    if (!scanStream) return;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        for (const text of await detect(video)) {
          const kind = parseQr(text);
          if (kind) {
            closeScanner();
            handleKind(kind, SOURCES.qr);
            return;
          }
          msg.textContent = 'Det där är inte en stämpelkod';
        }
      } catch (_) { /* enstaka bildfel ignoreras */ }
    }
    scanTimer = setTimeout(tick, 150);
  };
  tick();
}

function closeScanner() {
  clearTimeout(scanTimer);
  if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
  scanStream = null;
  $('#scan-video').srcObject = null;
  const dlg = $('#scanner');
  if (dlg.open) dlg.close();
}

/* ===================== Dialoger ===================== */

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3000);
}

function choose(title, text, options) {
  return new Promise((resolve) => {
    const dlg = $('#choice-dialog');
    $('#choice-title').textContent = title;
    $('#choice-text').textContent = text;
    const box = $('#choice-buttons');
    box.innerHTML = '';
    let result = null;
    for (const o of [...options, { label: 'Avbryt', value: null, cls: 'secondary' }]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn action ${o.cls || ''}`;
      b.style.minHeight = '56px';
      b.textContent = o.label;
      b.onclick = () => { result = o.value; dlg.close(); };
      box.append(b);
    }
    dlg.addEventListener('close', () => resolve(result), { once: true });
    dlg.showModal();
  });
}

let editingId = null;

function openEdit(event, preset) {
  editingId = event ? event.id : null;
  const base = event || preset || { type: guessNextType(), ts: Date.now() };
  $('#edit-title').textContent = event ? 'Ändra stämpling' : 'Lägg till stämpling';
  $('#edit-type').value = base.type;
  $('#edit-time').value = toLocalInput(base.ts);
  $('#edit-note').value = (event && event.note) || '';
  $('#edit-delete').hidden = !event;
  $('#edit-dialog').showModal();
}

function guessNextType() {
  const { status } = analyze(state.events);
  return { off: 'in', working: 'out', lunch: 'lunch_in' }[status];
}

/* ===================== Export / backup ===================== */

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportCsv() {
  const from = $('#exp-from').value;
  const to = $('#exp-to').value;
  if (!from || !to || from > to) return toast('Välj ett giltigt datumintervall');

  const { days } = analyze(state.events);
  const rows = [['Datum', 'Veckodag', 'Vecka', 'Kom in', 'Lunch början', 'Lunch slut', 'Gick hem',
    'Lunch (min)', 'Arbetad tid (h:mm)', 'Arbetad tid (timmar)', 'Anmärkning']];
  let total = 0;

  for (let d = keyToDate(from); dateKey(d) <= to; d.setDate(d.getDate() + 1)) {
    const k = dateKey(d);
    const day = days.get(k);
    if (!day || (!day.events.length && !day.work)) continue;
    const first = (t) => { const e = day.events.find((x) => x.type === t); return e ? fmtTime(e.ts) : ''; };
    const lastOf = (t) => { const e = day.events.filter((x) => x.type === t).pop(); return e ? fmtTime(e.ts) : ''; };
    total += day.work;
    const notes = day.events.filter((e) => e.note).map((e) => e.note);
    if (day.incomplete) notes.unshift('Utstämpling saknas');
    rows.push([
      k,
      d.toLocaleDateString('sv-SE', { weekday: 'long' }),
      isoWeek(d).week,
      first('in'),
      first('lunch_out'),
      first('lunch_in'),
      lastOf('out'),
      Math.round(day.lunch / 60000),
      fmtHM(day.work),
      (day.work / 3600000).toFixed(2).replace('.', ','),
      notes.join(' / '),
    ]);
  }
  rows.push([]);
  rows.push(['Totalt', '', '', '', '', '', '', '', fmtHM(total), (total / 3600000).toFixed(2).replace('.', ','), '']);

  const csv = rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
  download(`tidrapport_${from}_${to}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function backup() {
  const data = { app: 'stampelklocka', version: 1, exported: new Date().toISOString(), ...state };
  download(`stampelklocka_${dateKey(Date.now())}.json`, JSON.stringify(data, null, 2), 'application/json');
}

async function restore(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.events)) throw new Error('fel format');
    const byId = new Map(state.events.map((e) => [e.id, e]));
    let added = 0;
    for (const e of data.events.filter(isValidEvent)) {
      if (!byId.has(e.id)) added++;
      byId.set(e.id, e);
    }
    state.events = Array.from(byId.values());
    save();
    render();
    toast(`Återställt – ${added} nya stämplingar`);
  } catch (e) {
    toast('Filen kunde inte läsas som en säkerhetskopia');
  }
}

async function requestPersistence() {
  if (requestPersistence.done || !navigator.storage || !navigator.storage.persist) return;
  requestPersistence.done = true;
  try { await navigator.storage.persist(); } catch (_) { /* inte kritiskt */ }
  showStorageInfo();
}

async function showStorageInfo() {
  const el = $('#storage-info');
  let txt = `${state.events.length} stämplingar sparade på den här enheten.`;
  try {
    if (navigator.storage && navigator.storage.persisted && await navigator.storage.persisted()) {
      txt += ' Lagringen är skyddad mot automatisk rensning.';
    }
  } catch (_) { /* ignorera */ }
  el.textContent = txt;
}

/* ===================== Händelser ===================== */

function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'history') renderHistory();
  if (name === 'qr') renderQr();
  if (name === 'settings') showStorageInfo();
  window.scrollTo(0, 0);
}

function bind() {
  $$('.tab').forEach((t) => (t.onclick = () => showView(t.dataset.view)));
  $$('[data-add-event]').forEach((b) => (b.onclick = () => openEdit(null)));
  $('#scan-btn').onclick = openScanner;
  $('#scan-close').onclick = closeScanner;
  $('#scanner').addEventListener('cancel', closeScanner);

  $('#edit-form').addEventListener('submit', (ev) => {
    if (ev.submitter && ev.submitter.value === 'cancel') return;
    ev.preventDefault();
    const ts = fromLocalInput($('#edit-time').value);
    if (!Number.isFinite(ts)) return toast('Ogiltig tid');
    const type = $('#edit-type').value;
    const note = $('#edit-note').value.trim();
    const editing = state.events.find((e) => e.id === editingId);
    if (editing) {
      Object.assign(editing, { type, ts, note: note || undefined });
    } else {
      state.events.push({ id: newId(), type, ts, src: SOURCES.manual, note: note || undefined });
    }
    save();
    $('#edit-dialog').close();
    render();
    toast('Sparat');
  });

  $('#edit-delete').onclick = () => {
    const editing = state.events.find((e) => e.id === editingId);
    if (!editing || !confirm(`Ta bort stämplingen ${TYPES[editing.type].label} ${fmtTime(editing.ts)}?`)) return;
    state.events = state.events.filter((e) => e.id !== editingId);
    save();
    $('#edit-dialog').close();
    render();
    toast('Borttagen');
  };

  $('#qr-base').addEventListener('change', (ev) => {
    const v = ev.target.value.trim();
    try {
      if (v) new URL(v);
      state.settings.qrBase = v && v !== defaultQrBase() ? v : '';
      save();
    } catch (_) {
      toast('Ogiltig adress');
    }
    renderQr();
  });
  $('#print-btn').onclick = () => window.print();

  const today = new Date();
  $('#exp-to').value = dateKey(today);
  $('#exp-from').value = dateKey(new Date(today.getFullYear(), today.getMonth(), 1));
  $('#export-csv').onclick = exportCsv;
  $('#backup-btn').onclick = backup;
  $('#restore-input').onchange = (ev) => {
    if (ev.target.files[0]) restore(ev.target.files[0]);
    ev.target.value = '';
  };

  $('#set-vibrate').checked = state.settings.vibrate;
  $('#set-vibrate').onchange = (ev) => { state.settings.vibrate = ev.target.checked; save(); };

  $('#clear-btn').onclick = () => {
    if (!state.events.length) return toast('Det finns inget att radera');
    if (!confirm('Radera ALLA stämplingar? Det går inte att ångra.')) return;
    if (!confirm('Är du helt säker? Spara gärna en säkerhetskopia först.')) return;
    state.events = [];
    save();
    render();
    showStorageInfo();
    toast('Allt raderat');
  };

  // Andra flikar/fönster kan ha stämplat (t.ex. när en QR-länk öppnats i webbläsaren).
  window.addEventListener('storage', (ev) => {
    if (ev.key === STORE_KEY) { state = load(); render(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { state = load(); render(); }
  });
}

function tickClock() {
  const d = new Date();
  $('#clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Öppnades appen via en QR-länk (…?stamp=in)? Stämpla och ta bort parametern
// så att en omladdning inte stämplar igen.
function handleLaunchUrl() {
  const params = new URLSearchParams(location.search);
  const kind = params.get('stamp');
  if (!kind) return;
  params.delete('stamp');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  if (QR_KINDS[kind]) handleKind(kind, SOURCES.qr);
}

/* ===================== Start ===================== */

bind();
render();
tickClock();
setInterval(tickClock, 1000);
setInterval(renderToday, 30000);
handleLaunchUrl();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker', e));
}
