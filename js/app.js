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
  switch:    { label: 'Bytte till',   verb: 'Bytte till' },
};

// Typer som startar arbete och därför hör till en aktivitet.
const ACT_TYPES = ['in', 'lunch_in', 'switch'];
const WEEKDAYS = ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag', 'Söndag'];

// Vad en QR-kod betyder. "lunch" och "auto" tolkas utifrån nuvarande status.
const QR_KINDS = {
  in:    { title: 'Kom till jobbet', text: 'Stämpla in när du kommer' },
  lunch: { title: 'Lunch',           text: 'Skanna när du går på och kommer tillbaka från lunch' },
  out:   { title: 'Gå hem',          text: 'Stämpla ut när du går för dagen' },
  auto:  { title: 'Stämpla',         text: 'En kod för allt – appen frågar vid behov' },
  // act kräver ?a=<aktivitet>: stämplar in på, eller byter till, aktiviteten.
  act:   { title: '', text: 'Stämpla in eller byt till den här aktiviteten' },
};

const SOURCES = { button: 'knapp', qr: 'QR', nfc: 'NFC', manual: 'manuell' };

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
  return {
    vibrate: true,
    qrBase: '',
    nfcRead: false,
    activities: ['Klinik', 'Forskning'],
    nextActivity: '', // vald aktivitet för nästa instämpling
    schedule: defaultSchedule(),
    email: '',
  };
}

// Mån–sön. Förväntad tid = slut − start − lunch.
function defaultSchedule() {
  const day = (on, end) => ({ on, start: '08:00', end, lunch: 45 });
  return [day(true, '17:00'), day(true, '17:00'), day(true, '17:00'), day(true, '17:00'),
    day(true, '15:45'), day(false, '17:00'), day(false, '17:00')];
}

function activities() {
  const list = state.settings.activities.filter(Boolean);
  return list.length ? list : ['Arbete'];
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
  const sign = ms < 0 ? '-' : '';
  const totalMin = Math.round(Math.abs(ms) / 60000);
  return `${sign}${Math.floor(totalMin / 60)}:${pad(totalMin % 60)}`;
}

// Flex med tecken: "+1 h 5 min", "−20 min", "±0 min"
function fmtFlex(ms) {
  const min = Math.round(ms / 60000);
  if (min === 0) return '±0 min';
  return (min > 0 ? '+' : '−') + fmtDur(Math.abs(min) * 60000);
}

function fmtHours(ms) {
  return (ms / 3600000).toFixed(2).replace('.', ',');
}

function hmToMin(hm) {
  const [h, m] = String(hm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Schemalagd arbetstid för ett datum (i ms).
function expectedMs(key) {
  const s = state.settings.schedule[(keyToDate(key).getDay() + 6) % 7];
  if (!s || !s.on) return 0;
  return Math.max(0, hmToMin(s.end) - hmToMin(s.start) - (Number(s.lunch) || 0)) * 60000;
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
    if (!days.has(key)) days.set(key, { key, work: 0, lunch: 0, acts: {}, events: [], incomplete: false });
    return days.get(key);
  };

  let workStart = null;
  let lunchStart = null;
  let last = null;
  let act = null; // pågående (eller senaste) aktivitet

  // Lägg till ett tidsintervall, delat vid midnatt. Arbetstid bokförs även per aktivitet.
  const addSpan = (field, from, to) => {
    let start = from;
    while (start < to) {
      const nextMidnight = startOfDay(start).getTime() + 86400000;
      const end = Math.min(to, nextMidnight);
      const d = day(dateKey(start));
      d[field] += end - start;
      if (field === 'work') d.acts[act] = (d.acts[act] || 0) + end - start;
      start = end;
    }
  };
  const defaultAct = activities()[0];

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
        if (workStart == null) {
          workStart = e.ts;
          act = e.activity || (e.type === 'lunch_in' && act) || defaultAct;
        }
        break;
      case 'switch':
        if (lunchStart != null) { addSpan('lunch', lunchStart, e.ts); lunchStart = null; }
        if (workStart != null) addSpan('work', workStart, e.ts);
        workStart = e.ts;
        act = e.activity || act || defaultAct;
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

  return { days, status, since, stale, last, activity: act };
}

/* ===================== Stämpling ===================== */

// Aktivitet för nästa instämpling: den användaren valt, annars den senaste.
function pickActivity(info) {
  const list = activities();
  if (list.includes(state.settings.nextActivity)) return state.settings.nextActivity;
  if (list.includes(info.activity)) return info.activity;
  return list[0];
}

function addEvent(type, src, activity) {
  const ts = Date.now();
  const info = analyze(state.events);
  const last = info.last;
  if (ACT_TYPES.includes(type) && !activity) activity = pickActivity(info);
  if (!ACT_TYPES.includes(type)) activity = undefined;
  if (src !== SOURCES.manual && last && last.type === type && last.activity === activity
      && ts - last.ts < DUPLICATE_MS) {
    toast(`Redan registrerat kl ${fmtTime(last.ts)}`);
    return;
  }
  const ev = { id: newId(), type, ts, src };
  if (activity) ev.activity = activity;
  state.events.push(ev);
  if (activity) state.settings.nextActivity = '';
  save();
  requestPersistence();
  if (state.settings.vibrate && navigator.vibrate) navigator.vibrate(type === 'out' ? [60, 60, 60] : 80);
  const showAct = activity && activities().length > 1;
  toast(`${TYPES[type].verb}${type === 'switch' ? '' : ` ${fmtTime(ts)}`}${showAct ? ` ${type === 'switch' ? '' : '– '}${activity}` : ''} ✓`);
  render();
}

// Tolka en QR-kod (eller länk) utifrån nuvarande status.
async function handleKind(kind, src, activity) {
  const info = analyze(state.events);
  const { status, since } = info;
  const sinceTxt = since ? ` sedan ${fmtTime(since)}` : '';

  if (kind === 'act') {
    if (status === 'off') return addEvent('in', src, activity);
    if (status === 'lunch') return addEvent('lunch_in', src, activity);
    if (info.activity === activity) return toast(`Du är redan på ${activity}`);
    return addEvent('switch', src, activity);
  }

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

// Plockar ut stämpeltyp ur QR-text. Accepterar länkar (…?stamp=in, …?stamp=act&a=Forskning)
// och "stampel:in". Returnerar { kind, activity } eller null.
function parseQr(text) {
  text = String(text || '').trim();
  let kind = null;
  let activity = null;
  try {
    const params = new URL(text).searchParams;
    kind = params.get('stamp');
    activity = params.get('a');
  } catch (_) {
    const m = /^stampel:(\w+)$/i.exec(text);
    if (m) kind = m[1].toLowerCase();
  }
  if (!QR_KINDS[kind] || (kind === 'act' && !activity)) return null;
  return { kind, activity: activity || undefined };
}

/* ===================== Rendering ===================== */

function render() {
  renderToday();
  if ($('#view-history').classList.contains('active')) renderHistory();
  if ($('#view-settings').classList.contains('active')) updatePreview();
}

function renderToday() {
  const info = analyze(state.events);
  const todayKey = dateKey(Date.now());
  const today = info.days.get(todayKey);

  const card = $('#status-card');
  card.className = `card status ${info.status}`;
  const multi = activities().length > 1;
  $('#status-label').textContent = {
    off: 'Inte instämplad',
    working: multi ? info.activity : 'Instämplad',
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

  const worked = today ? today.work : 0;
  const left = expectedMs(todayKey) - worked;
  $('#today-worked').textContent = fmtDur(worked);
  $('#today-lunch').textContent = fmtDur(today ? today.lunch : 0);
  $('#today-left-label').textContent = left > 0 ? 'Kvar idag' : 'Över tid idag';
  $('#today-left').textContent = left > 0 ? fmtDur(left) : fmtFlex(-left);

  // Flex för veckans avslutade dagar (idag räknas när du stämplat ut).
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
  const week = summarize(info, dateKey(monday), todayKey);
  $('#week-flex').textContent = fmtFlex(week.flex);

  const acts = today ? Object.entries(today.acts).filter(([, ms]) => ms >= 60000) : [];
  $('#today-acts').textContent = multi && acts.length
    ? acts.map(([a, ms]) => `${a} ${fmtDur(ms)}`).join(' · ')
    : '';

  renderActPicker(info);

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

// Val av aktivitet. Instämplad: byter aktivitet direkt. Annars: väljer vad nästa
// instämpling (eller återkomst från lunch) ska gälla.
function renderActPicker(info) {
  const box = $('#act-picker');
  box.innerHTML = '';
  const list = activities();
  box.hidden = list.length < 2;
  if (box.hidden) return;
  const current = info.status === 'working' ? info.activity : pickActivity(info);
  for (const a of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a;
    b.className = a === current ? 'active' : '';
    b.setAttribute('aria-pressed', a === current);
    b.onclick = () => {
      if (a === current) return;
      if (info.status === 'working') return addEvent('switch', SOURCES.button, a);
      state.settings.nextActivity = a;
      save();
      renderToday();
      toast(info.status === 'lunch' ? `Efter lunch: ${a}` : `Nästa instämpling: ${a}`);
    };
    box.append(b);
  }
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
      <span><span class="event-label"></span>${e.note ? `<br><span class="event-note"></span>` : ''}</span>
      <span class="event-src"></span>`;
    const showAct = e.activity && (e.type === 'switch' || activities().length > 1);
    li.querySelector('.event-label').textContent = TYPES[e.type].label
      + (showAct ? `${e.type === 'switch' ? ' ' : ' · '}${e.activity}` : '');
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
    const keys = wk.days.map((d) => d.key);
    const sum = summarize(info, keys[keys.length - 1], keys[0]);
    sec.innerHTML = `<div class="week-head"><span>Vecka ${wk.w.week}${wk.w.year !== new Date().getFullYear() ? ` ${wk.w.year}` : ''}</span><span>${fmtDur(sum.work)} <small class="flex">${fmtFlex(sum.flex)}</small></span></div>`;
    for (const d of wk.days) {
      const row = sum.days.find((x) => x.key === d.key);
      const det = document.createElement('details');
      det.className = 'card day';
      const sub = [
        row && row.flex != null ? `flex ${fmtFlex(row.flex)}` : (row && row.inProgress ? 'pågår' : ''),
        d.lunch ? `lunch ${fmtDur(d.lunch)}` : '',
        d.incomplete ? 'utstämpling saknas' : '',
      ].filter(Boolean).join(' · ');
      const acts = Object.entries(d.acts).filter(([, ms]) => ms >= 60000);
      det.innerHTML = `
        <summary>
          <span class="day-name">${fmtDayName(d.key)}${d.incomplete ? ' ⚠️' : ''}</span>
          <span class="day-sum">${fmtDur(d.work)}<small>${sub}</small></span>
        </summary>
        <p class="day-acts"></p>
        <ul class="event-list"></ul>`;
      det.querySelector('.day-acts').textContent = activities().length > 1 || acts.length > 1
        ? acts.map(([a, ms]) => `${a} ${fmtDur(ms)}`).join(' · ') : '';
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

// NFC-lappar får ?via=nfc så att historiken visar varifrån stämplingen kom.
function qrUrl(kind, via, activity) {
  const u = new URL(qrBase());
  u.searchParams.set('stamp', kind);
  if (activity) u.searchParams.set('a', activity);
  if (via) u.searchParams.set('via', via);
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
  const codes = Object.keys(QR_KINDS).filter((k) => k !== 'act').map((kind) => ({ kind, title: QR_KINDS[kind].title, text: QR_KINDS[kind].text }));
  if (activities().length > 1) {
    for (const a of activities()) codes.push({ kind: 'act', activity: a, title: a, text: QR_KINDS.act.text });
  }
  for (const c of codes) {
    const card = document.createElement('div');
    card.className = 'qr-card';
    let svg;
    try {
      svg = qrSvg(qrUrl(c.kind, null, c.activity));
    } catch (e) {
      svg = '<p>Ogiltig adress</p>';
    }
    card.innerHTML = `<h3></h3>${svg}<p></p>
      <div class="nfc-row no-print"><button class="btn secondary" type="button"></button></div>`;
    card.querySelector('h3').textContent = c.title;
    card.querySelector('p:last-of-type').textContent = c.text;
    const nfcBtn = card.querySelector('.nfc-row button');
    if ('NDEFReader' in window) {
      nfcBtn.textContent = 'Skriv till NFC-lapp';
      nfcBtn.onclick = () => writeNfc(c);
    } else {
      nfcBtn.textContent = 'Kopiera NFC-länk';
      nfcBtn.onclick = () => copyText(qrUrl(c.kind, 'nfc', c.activity));
    }
    grid.append(card);
  }
}

async function copyText(text, msg = 'Länken är kopierad – skriv den till lappen med en NFC-app') {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch (_) {
    prompt('Kopiera länken:', text);
  }
}

/* ===================== NFC (Web NFC, Chrome på Android) ===================== */

let nfcReader = null;
let nfcIgnoreUntil = 0; // ignorera läsningar medan vi själva skriver en lapp

async function writeNfc(code) {
  const dlg = $('#nfc-dialog');
  const ctrl = new AbortController();
  $('#nfc-title').textContent = `Skriv "${code.title}"`;
  $('#nfc-msg').textContent = 'Håll telefonens baksida mot NFC-lappen…';
  $('#nfc-cancel').onclick = () => { ctrl.abort(); dlg.close(); };
  dlg.showModal();
  nfcIgnoreUntil = Infinity;
  try {
    const writer = new NDEFReader();
    await writer.write({ records: [{ recordType: 'url', data: qrUrl(code.kind, 'nfc', code.activity) }] }, { signal: ctrl.signal });
    if (state.settings.vibrate && navigator.vibrate) navigator.vibrate(80);
    dlg.close();
    toast('NFC-lappen är klar ✓');
  } catch (e) {
    if (ctrl.signal.aborted) return;
    $('#nfc-msg').textContent = e.name === 'NotAllowedError'
      ? 'Appen fick inte använda NFC. Tillåt NFC för sidan och försök igen.'
      : 'Kunde inte skriva. Kontrollera att NFC är på och att lappen inte är låst, och försök igen.';
  } finally {
    nfcIgnoreUntil = Date.now() + 3000;
  }
}

// Läser lappar direkt i appen när den är öppen, så att Android inte öppnar länken i webbläsaren.
async function startNfcRead() {
  if (nfcReader || !('NDEFReader' in window)) return;
  const reader = new NDEFReader();
  await reader.scan();
  nfcReader = reader;
  reader.onreading = (ev) => {
    if (Date.now() < nfcIgnoreUntil) return;
    for (const rec of ev.message.records) {
      if (rec.recordType !== 'url' && rec.recordType !== 'text') continue;
      const code = parseQr(new TextDecoder(rec.encoding || 'utf-8').decode(rec.data));
      if (code) {
        if (document.querySelector('dialog[open]')) return;
        handleKind(code.kind, SOURCES.nfc, code.activity);
        return;
      }
    }
    toast('Det där är inte en stämpellapp');
  };
}

async function resumeNfcRead() {
  if (!state.settings.nfcRead || nfcReader || !('NDEFReader' in window)) return;
  try {
    const perm = await navigator.permissions.query({ name: 'nfc' });
    if (perm.state === 'granted') await startNfcRead();
  } catch (_) { /* startas igen nästa gång användaren slår på det */ }
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
          const code = parseQr(text);
          if (code) {
            closeScanner();
            handleKind(code.kind, SOURCES.qr, code.activity);
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
  const sel = $('#edit-act');
  const list = activities().slice();
  const cur = base.activity || (ACT_TYPES.includes(base.type) ? pickActivity(analyze(state.events)) : list[0]);
  if (cur && !list.includes(cur)) list.push(cur);
  sel.innerHTML = '';
  for (const a of list) sel.append(new Option(a, a, false, a === cur));
  syncEditAct();
  $('#edit-time').value = toLocalInput(base.ts);
  $('#edit-note').value = (event && event.note) || '';
  $('#edit-delete').hidden = !event;
  $('#edit-dialog').showModal();
}

function syncEditAct() {
  $('#edit-act-field').hidden = !ACT_TYPES.includes($('#edit-type').value) || activities().length < 2 && $('#edit-type').value !== 'switch';
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

/**
 * Sammanställer en period. Flex räknas bara för avslutade dagar med stämplingar;
 * dagen som pågår visas men räknas inte in i flex (eller i planerad tid).
 */
function summarize(info, fromKey, toKey) {
  const todayKey = dateKey(Date.now());
  const out = { from: fromKey, to: toKey, days: [], work: 0, expected: 0, flex: 0, acts: {}, inProgress: false };
  for (let d = keyToDate(fromKey); dateKey(d) <= toKey; d.setDate(d.getDate() + 1)) {
    const key = dateKey(d);
    const day = info.days.get(key);
    if (!day || (!day.events.length && !day.work)) continue;
    const inProgress = key === todayKey && info.status !== 'off';
    const expected = expectedMs(key);
    const row = {
      key,
      work: day.work,
      lunch: day.lunch,
      acts: day.acts,
      expected,
      flex: inProgress ? null : day.work - expected,
      inProgress,
      incomplete: day.incomplete,
      first: day.events.find((e) => e.type === 'in'),
      last: day.events.filter((e) => e.type === 'out').pop(),
      notes: day.events.filter((e) => e.note).map((e) => e.note),
      events: day.events,
    };
    out.days.push(row);
    out.work += day.work;
    for (const [a, ms] of Object.entries(day.acts)) out.acts[a] = (out.acts[a] || 0) + ms;
    if (inProgress) out.inProgress = true;
    else { out.expected += expected; out.flex += row.flex; }
  }
  return out;
}

function reportRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const monday = new Date(y, m, now.getDate() - (now.getDay() + 6) % 7);
  const week = (offset) => {
    const from = new Date(monday);
    from.setDate(from.getDate() + offset * 7);
    const to = new Date(from);
    to.setDate(to.getDate() + 6);
    return { from: dateKey(from), to: dateKey(to), label: `vecka ${isoWeek(from).week}` };
  };
  const month = (offset) => {
    const from = new Date(y, m + offset, 1);
    const to = new Date(y, m + offset + 1, 0);
    return { from: dateKey(from), to: dateKey(to), label: from.toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' }) };
  };
  switch ($('#rep-period').value) {
    case 'this-week': return week(0);
    case 'last-week': return week(-1);
    case 'this-month': return month(0);
    case 'last-month': return month(-1);
    default: {
      const from = $('#exp-from').value;
      const to = $('#exp-to').value;
      if (!from || !to || from > to) return null;
      return { from, to, label: `${from} – ${to}` };
    }
  }
}

function fmtShortDate(key) {
  return keyToDate(key).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
}

function reportText(range) {
  const sum = summarize(analyze(state.events), range.from, range.to);
  const multi = activities().length > 1 || Object.keys(sum.acts).length > 1;
  const lines = [];
  lines.push(`Tidrapport ${range.label} (${fmtShortDate(range.from)} – ${fmtShortDate(range.to)})`);
  lines.push('');
  if (!sum.days.length) {
    lines.push('Inga stämplingar under perioden.');
    return { subject: `Tidrapport ${range.label}`, body: lines.join('\n') };
  }
  lines.push(`Arbetad tid: ${fmtDur(sum.work)}`);
  lines.push(`Enligt schema: ${fmtDur(sum.expected)}`);
  lines.push(`Flex (mer än schemat): ${fmtFlex(sum.flex)}`);
  if (sum.inProgress) lines.push('(Dagen som pågår räknas inte i flex.)');

  if (multi) {
    lines.push('');
    lines.push('Fördelning:');
    for (const [a, ms] of Object.entries(sum.acts).sort((x, y) => y[1] - x[1])) {
      const pct = sum.work ? Math.round((ms / sum.work) * 100) : 0;
      lines.push(`- ${a}: ${fmtDur(ms)} (${pct} %)`);
    }
  }

  lines.push('');
  lines.push('Per dag:');
  for (const d of sum.days) {
    const name = keyToDate(d.key).toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short' });
    const span = `${d.first ? fmtTime(d.first.ts) : '?'}–${d.last ? fmtTime(d.last.ts) : (d.inProgress ? 'pågår' : '?')}`;
    const flex = d.flex != null ? ` (${fmtFlex(d.flex)})` : '';
    lines.push(`${name}: ${span}, ${fmtDur(d.work)}${flex}${d.lunch ? `, lunch ${fmtDur(d.lunch)}` : ''}`);
    const acts = Object.entries(d.acts).filter(([, ms]) => ms >= 60000);
    if (multi && acts.length) lines.push(`   ${acts.map(([a, ms]) => `${a} ${fmtDur(ms)}`).join(', ')}`);
    if (d.incomplete) lines.push('   OBS: utstämpling saknas');
    for (const n of d.notes) lines.push(`   Anteckning: ${n}`);
  }
  return { subject: `Tidrapport ${range.label} – ${fmtDur(sum.work)}, flex ${fmtFlex(sum.flex)}`, body: lines.join('\n') };
}

function updatePreview() {
  const range = reportRange();
  $('#rep-preview').textContent = range ? reportText(range).body : 'Välj ett giltigt datumintervall.';
}

function sendMail() {
  const range = reportRange();
  if (!range) return toast('Välj ett giltigt datumintervall');
  const email = $('#set-email').value.trim();
  const { subject, body } = reportText(range);
  location.href = `mailto:${encodeURIComponent(email).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

async function shareReport() {
  const range = reportRange();
  if (!range) return toast('Välj ett giltigt datumintervall');
  const { subject, body } = reportText(range);
  if (navigator.share) {
    try { await navigator.share({ title: subject, text: body }); } catch (_) { /* avbrutet */ }
  } else {
    copyText(body, 'Rapporten är kopierad');
  }
}

function exportCsv() {
  const range = reportRange();
  if (!range) return toast('Välj ett giltigt datumintervall');
  const sum = summarize(analyze(state.events), range.from, range.to);
  const acts = Array.from(new Set([...activities(), ...Object.keys(sum.acts)]))
    .filter((a) => sum.acts[a] || activities().length > 1);
  const rows = [['Datum', 'Veckodag', 'Vecka', 'Kom in', 'Lunch början', 'Lunch slut', 'Gick hem',
    'Lunch (min)', 'Arbetad tid (h:mm)', 'Arbetad tid (timmar)', 'Schema (h:mm)', 'Flex (h:mm)',
    ...acts.map((a) => `${a} (timmar)`), 'Anmärkning']];

  for (const d of sum.days) {
    const first = (t) => { const e = d.events.find((x) => x.type === t); return e ? fmtTime(e.ts) : ''; };
    const notes = d.notes.slice();
    if (d.incomplete) notes.unshift('Utstämpling saknas');
    if (d.inProgress) notes.unshift('Pågår');
    rows.push([
      d.key,
      keyToDate(d.key).toLocaleDateString('sv-SE', { weekday: 'long' }),
      isoWeek(keyToDate(d.key)).week,
      d.first ? fmtTime(d.first.ts) : '',
      first('lunch_out'),
      first('lunch_in'),
      d.last ? fmtTime(d.last.ts) : '',
      Math.round(d.lunch / 60000),
      fmtHM(d.work),
      fmtHours(d.work),
      fmtHM(d.expected),
      d.flex != null ? fmtHM(d.flex) : '',
      ...acts.map((a) => fmtHours(d.acts[a] || 0)),
      notes.join(' / '),
    ]);
  }
  rows.push([]);
  rows.push(['Totalt', '', '', '', '', '', '', '', fmtHM(sum.work), fmtHours(sum.work), fmtHM(sum.expected),
    fmtHM(sum.flex), ...acts.map((a) => fmtHours(sum.acts[a] || 0)), '']);

  const csv = rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
  download(`tidrapport_${range.from}_${range.to}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
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

/* ===================== Inställningar ===================== */

function renderSettings() {
  // Aktiviteter
  const ul = $('#act-list');
  ul.innerHTML = '';
  state.settings.activities.forEach((name, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<input type="text" maxlength="40" aria-label="Aktivitet ${i + 1}">
      <button type="button" class="icon-btn" aria-label="Ta bort">✕</button>`;
    const input = li.querySelector('input');
    input.value = name;
    input.onchange = () => {
      const v = input.value.trim();
      const old = state.settings.activities[i];
      if (v && state.settings.activities.some((a, j) => j !== i && a === v)) {
        toast('Den aktiviteten finns redan');
        input.value = old;
        return;
      }
      state.settings.activities[i] = v;
      // Byt namn även på gamla stämplingar så att historiken hänger ihop.
      if (old && v) state.events.forEach((e) => { if (e.activity === old) e.activity = v; });
      state.settings.activities = state.settings.activities.filter((a, j) => a || j === i);
      save();
      render();
    };
    li.querySelector('button').onclick = () => {
      if (state.settings.activities.filter(Boolean).length <= 1 && name) return toast('Minst en aktivitet behövs');
      state.settings.activities.splice(i, 1);
      save();
      renderSettings();
      render();
    };
    ul.append(li);
  });

  // Schema
  const box = $('#schedule');
  box.innerHTML = '';
  state.settings.schedule.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'sched-row';
    row.innerHTML = `
      <label class="sched-day"><input type="checkbox"> ${WEEKDAYS[i].slice(0, 3)}</label>
      <input type="time" aria-label="${WEEKDAYS[i]} start">
      <input type="time" aria-label="${WEEKDAYS[i]} slut">
      <label class="sched-lunch"><input type="number" min="0" max="180" step="5" inputmode="numeric" aria-label="${WEEKDAYS[i]} lunch i minuter"><span>min</span></label>
      <span class="sched-sum"></span>`;
    const [on, start, end, lunch] = row.querySelectorAll('input');
    on.checked = d.on;
    start.value = d.start;
    end.value = d.end;
    lunch.value = d.lunch;
    const sync = () => {
      [start, end, lunch].forEach((x) => (x.disabled = !on.checked));
      row.querySelector('.sched-sum').textContent = on.checked
        ? `${fmtDur(Math.max(0, hmToMin(end.value) - hmToMin(start.value) - (Number(lunch.value) || 0)) * 60000)} arbetstid`
        : 'Ledig';
    };
    const update = () => {
      state.settings.schedule[i] = { on: on.checked, start: start.value || '08:00', end: end.value || '17:00', lunch: Number(lunch.value) || 0 };
      save();
      sync();
      render();
    };
    [on, start, end, lunch].forEach((x) => (x.onchange = update));
    sync();
    box.append(row);
  });
  const weekMin = state.settings.schedule.reduce((s, d, i) => s + expectedMs(dateKey(new Date(2024, 0, 1 + i))) / 60000, 0);
  const total = document.createElement('p');
  total.className = 'hint';
  total.textContent = `Totalt per vecka: ${fmtDur(weekMin * 60000)}`;
  box.append(total);

  updatePreview();
}

/* ===================== Händelser ===================== */

function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'history') renderHistory();
  if (name === 'qr') renderQr();
  if (name === 'settings') { showStorageInfo(); renderSettings(); }
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
    const activity = ACT_TYPES.includes(type) ? $('#edit-act').value : undefined;
    const editing = state.events.find((e) => e.id === editingId);
    if (editing) {
      Object.assign(editing, { type, ts, activity, note: note || undefined });
    } else {
      state.events.push({ id: newId(), type, ts, activity, src: SOURCES.manual, note: note || undefined });
    }
    save();
    $('#edit-dialog').close();
    render();
    toast('Sparat');
  });

  $('#edit-type').onchange = syncEditAct;

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
  $('#rep-mail').onclick = sendMail;
  $('#rep-share').onclick = shareReport;
  $('#rep-period').onchange = () => {
    $('#rep-custom').hidden = $('#rep-period').value !== 'custom';
    updatePreview();
  };
  $('#exp-from').onchange = $('#exp-to').onchange = updatePreview;
  $('#set-email').value = state.settings.email;
  $('#set-email').onchange = (ev) => { state.settings.email = ev.target.value.trim(); save(); };
  $('#act-add').onclick = () => {
    state.settings.activities = [...activities(), ''];
    renderSettings();
    const inputs = $$('#act-list input');
    inputs[inputs.length - 1].focus();
  };
  $('#backup-btn').onclick = backup;
  $('#restore-input').onchange = (ev) => {
    if (ev.target.files[0]) restore(ev.target.files[0]);
    ev.target.value = '';
  };

  $('#set-vibrate').checked = state.settings.vibrate;
  $('#set-vibrate').onchange = (ev) => { state.settings.vibrate = ev.target.checked; save(); };

  if ('NDEFReader' in window) {
    $('#nfc-setting').hidden = false;
    $('#set-nfc').checked = state.settings.nfcRead;
    $('#set-nfc').onchange = async (ev) => {
      state.settings.nfcRead = ev.target.checked;
      save();
      if (!ev.target.checked) return toast('Gäller från nästa gång appen startas');
      try {
        await startNfcRead();
        toast('NFC-läsning på');
      } catch (e) {
        ev.target.checked = state.settings.nfcRead = false;
        save();
        toast('Fick inte använda NFC. Är NFC påslaget i telefonen?');
      }
    };
  }

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
    if (!document.hidden) { state = load(); render(); resumeNfcRead(); }
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
  const src = params.get('via') === 'nfc' ? SOURCES.nfc : SOURCES.qr;
  const activity = params.get('a') || undefined;
  params.delete('via');
  params.delete('a');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  if (QR_KINDS[kind] && (kind !== 'act' || activity)) handleKind(kind, src, activity);
}

/* ===================== Start ===================== */

bind();
render();
tickClock();
setInterval(tickClock, 1000);
setInterval(renderToday, 30000);
handleLaunchUrl();
resumeNfcRead();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker', e));
}
