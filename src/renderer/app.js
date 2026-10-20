import { TarkovMap } from './map.js';
import {
  S, idx, idOf, MONEY, ST_LABEL, RAID_LABEL, indexData, item, trader, statusOf, statusInfo, isTracked, objCount, objProgress, objDone, taskPct,
  mapByLogId, defFor, selectableMaps, sameMapIds, taskOnMap, objOnMap, objHere, mapNames, hasMapPoints, byTrader, objText, objItems, prereqChain,
  raidGroups, bringList, built, owned, maxLevel, stationState, neededItems,
} from './store.js';

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('ru-RU'));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const VIEWS = ['raid', 'dossier', 'base', 'stash', 'summary'];

// ---------------------------------------------------------------- состояние интерфейса
const ui = {
  view: 'raid', raidMap: null, follow: true, brief: 'bring', fold: [], collapsed: ['anywhere', 'avail'],
  qStatus: 'active', qTrader: '', qMap: '', qSearch: '', qKappa: false, qLk: false, qSort: 'trader', qSel: null,
  station: null, iQuest: 'active', iHide: 'next', iFir: false, iHideDone: true, iSearch: '', compact: false,
};
try { Object.assign(ui, JSON.parse(localStorage.getItem('ui2') || '{}')); } catch {}
const saveUi = debounce(() => { try { localStorage.setItem('ui2', JSON.stringify(ui)); } catch {} }, 200);
const openTasks = new Set(); // раскрытые задачи в панели рейда

const tmap = new TarkovMap($('#map'), api);
tmap.onError = (msg) => toast(msg);
tmap.shotsFor = (taskId) => S.wiki.get(taskId)?.images || [];
// выходы и переходы: фото и требования со страницы карты на вики (сопоставление по английскому названию)
const mapWiki = new Map();
const normName = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
tmap.exitMedia = (item) => {
  const w = mapWiki.get(loadedMapId);
  if (!w || !item.en) return null;
  const n = normName(item.en);
  const all = [...(w.extracts || []), ...(w.transits || [])];
  const hit = all.find((x) => normName(x.name) === n) || all.find((x) => { const k = normName(x.name); return k && (k.includes(n) || n.includes(k)); });
  return hit ? { images: hit.images.map((im) => ({ ...im, caption: hit.name })), requirements: hit.requirements, notes: hit.notes } : null;
};
tmap.onExitClick = (item, kind) => {
  const media = tmap.exitMedia(item, kind);
  if (media?.images?.length) openGallery(media.images.map((im) => ({ ...im, caption: kind === 'transit' ? item.description : item.name })));
};
// здания найдены — этажи переключаются кликом по зданию, кнопки этажей не нужны
tmap.onBuildings = (n) => updateFloorUi(n);
function updateFloorUi(nBuildings) {
  const floors = tmap.floors();
  const byClick = nBuildings > 0 && tmap.style === 'svg';
  setHtml($('#floorSeg'), byClick ? '<span class="floor-hint">этажи — клик по зданию</span>'
    : floors.length ? '<button data-floor="" class="on">Все этажи</button>' + floors.map((f) => `<button data-floor="${esc(f)}">${esc(floorName(f))}</button>`).join('') : '');
}
let loadedMapId = null;
let pointsSig = '';
let locksSig = '';

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = text;
  $('#toasts').appendChild(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 4200);
}
function setHtml(el, html) { if (el._html !== html) { el.innerHTML = html; el._html = html; } }

// ---------------------------------------------------------------- навигация и рендер
function setView(v) {
  if (!VIEWS.includes(v)) v = 'raid';
  ui.view = v; saveUi();
  $$('#ws button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  $$('.view').forEach((s) => s.classList.toggle('on', s.id === 'view-' + v));
  render();
  if (v === 'raid') setTimeout(() => tmap.map?.invalidateSize(), 30);
}
$$('#ws button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

// Окно скрыто (трей, свёрнуто) — ничего не рисуем; через минуту выгружаем карту, чтобы не держать память.
let dirtyWhileHidden = false;
let unloadTimer = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    unloadTimer = setTimeout(() => {
      tmap.destroy(); loadedMapId = null; pointsSig = locksSig = '';
      $('#peekImg').removeAttribute('src'); $('#lbImg').removeAttribute('src');
    }, 60000);
  } else {
    clearTimeout(unloadTimer);
    if (dirtyWhileHidden || !loadedMapId) { dirtyWhileHidden = false; render(); }
  }
});

let queued = false;
function render() {
  if (document.hidden) { dirtyWhileHidden = true; return; }
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    renderBar();
    $('#boot').classList.toggle('hidden', !!(S.data && S.state));
    if (!S.data || !S.state) return;
    if (ui.view === 'raid' || ui.compact) renderRaid();
    if (ui.compact) return;
    if (ui.view === 'dossier') renderDossier();
    if (ui.view === 'base') renderBase();
    if (ui.view === 'stash') renderStash();
    if (ui.view === 'summary') renderSummary();
    if (!$('#settings').classList.contains('hidden')) renderSettings();
  });
}

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
  if (!$('#lightbox').classList.contains('hidden')) {
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') lbStep(-1);
    if (e.key === 'ArrowRight') lbStep(1);
    return;
  }
  if (e.ctrlKey && /^Digit[1-5]$/.test(e.code)) { e.preventDefault(); setView(VIEWS[Number(e.code.slice(5)) - 1]); return; }
  if (e.ctrlKey && e.code === 'KeyK') { e.preventDefault(); openPalette(); return; }
  if (e.ctrlKey && e.code === 'KeyF') { e.preventDefault(); if (ui.view === 'stash') $('#iSearch').focus(); else { setView('dossier'); setTimeout(() => $('#qSearch').focus(), 30); } return; }
  if (e.key === 'Escape') {
    if (!$('#palette').classList.contains('hidden')) { closePalette(); return; }
    if (!$('#onboard').classList.contains('hidden')) { closeOnboarding(); return; }
    if (!$('#settings').classList.contains('hidden')) { $('#settings').classList.add('hidden'); return; }
    if (typing) { document.activeElement.blur(); return; }
    tmap.map?.closePopup();
  }
  // в досье: стрелки вверх/вниз — по списку
  if (ui.view === 'dossier' && !typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const ids = $$('#qList .qrow').map((r) => r.dataset.task);
    const i = ids.indexOf(ui.qSel);
    const n = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (n) { selectQuest(n); $(`#qList .qrow[data-task="${n}"]`)?.scrollIntoView({ block: 'nearest' }); }
  }
});

// ---------------------------------------------------------------- командная строка
function renderBar() {
  const s = S.state;
  const led = $('#led');
  led.className = 'led';
  if (!s) { $('#tlMain').textContent = 'запуск'; return; }
  const live = s.live;
  if (!live.logsOk) {
    led.classList.add('err');
    $('#tlMain').textContent = 'нет логов';
    $('#tlSub').textContent = 'укажи папку Logs в настройках';
  } else {
    const mode = live.mode || s.profile.mode;
    const m = mapByLogId(live.map);
    $('#tlMain').textContent = RAID_LABEL[live.raidState] || 'в меню';
    $('#tlSub').textContent = [mode === 'pve' ? 'PvE' : mode ? 'PvP' : '', live.raidState !== 'idle' && live.raidState !== 'offline' ? m?.name : '', s.profile.effectiveLevel ? `ур. ${s.profile.effectiveLevel}` : ''].filter(Boolean).join(' · ');
    led.classList.add(live.raidState === 'inraid' ? 'live' : live.raidState === 'loading' || live.raidState === 'matching' ? 'busy' : live.raidState === 'offline' ? 'off' : 'ok');
  }
  $('#btnPin').classList.toggle('on', !!s.settings.alwaysOnTop);
  $('#btnClick').classList.toggle('on', !!s.clickThrough);
  $('#btnCompact').classList.toggle('on', ui.compact);
  document.body.classList.toggle('clickthrough', !!s.clickThrough);
  $('#clickBanner').classList.toggle('hidden', !s.clickThrough);
  if (S.data) {
    let a = 0;
    for (const t of S.data.tasks) if (statusOf(t.id) === 'active') a++;
    $('#wsQuestBadge').textContent = a || '';
  }
}
$('#telemetry').addEventListener('click', () => { if (S.state?.live?.logsOk) setView('summary'); else openSettings(); });
$('#btnMin').addEventListener('click', () => api.win('min'));
$('#btnMax').addEventListener('click', () => api.win('max'));
$('#btnClose').addEventListener('click', () => api.win('hide'));
$('#btnPin').addEventListener('click', () => api.win('pin'));
$('#btnClick').addEventListener('click', () => api.win('clickThrough'));
$('#btnCompact').addEventListener('click', () => api.win('compact'));
$('#btnSettings').addEventListener('click', () => openSettings());
$('#btnHelp').addEventListener('click', () => showOnboarding());
$('#omniBtn').addEventListener('click', () => openPalette());

// ---------------------------------------------------------------- скриншоты с вики
const wikiWanted = new Set();
function wantWiki(ids) {
  const need = ids.filter((id) => !S.wiki.has(id) && !wikiWanted.has(id) && idx.task.get(id)?.wikiLink);
  if (!need.length) return;
  need.forEach((id) => wikiWanted.add(id));
  api.prefetchWiki(need).then((list) => { for (const d of list || []) S.wiki.set(d.id, d); if (list?.length) render(); });
}
const renderSoon = debounce(() => render(), 120);
api.onWiki((d) => { if (d?.id) { S.wiki.set(d.id, d); wikiWanted.delete(d.id); renderSoon(); } });
const shots = (taskId) => S.wiki.get(taskId)?.images || [];
function camBtn(taskId) {
  const n = shots(taskId).length;
  return `<button class="ibtn cam${n ? '' : ' none'}" data-act="shots" data-id="${taskId}" data-peek="${taskId}" title="Скриншоты места (${n})"><i class="ic ic-cam"></i>${n > 1 ? `<b>${n}</b>` : ''}</button>`;
}

// превью при наведении
const peek = $('#peek');
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-peek],[data-peekimg]');
  if (!el) { peek.classList.add('hidden'); return; }
  const img = el.dataset.peekimg ? { thumb: el.dataset.peekimg, caption: el.dataset.peekcap } : shots(el.dataset.peek)[Number(el.dataset.i || 0)];
  if (!img) return;
  $('#peekImg').src = img.thumb;
  $('#peekCap').textContent = img.caption || '';
  peek.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  const w = 400, h = 270;
  let x = r.left - w - 12; if (x < 8) x = r.right + 12;
  if (x + w > innerWidth - 8) x = Math.max(8, innerWidth - w - 8);
  let y = r.top - 40; if (y + h > innerHeight - 8) y = innerHeight - h - 8;
  peek.style.left = x + 'px'; peek.style.top = Math.max(50, y) + 'px';
});
document.addEventListener('mouseleave', () => peek.classList.add('hidden'));

// просмотр во весь экран: фото места квеста или фото выхода
let lb = { list: [], i: 0 };
function openLightbox(taskId, i = 0) {
  const list = shots(taskId);
  if (!list.length) { toast(S.wiki.has(taskId) ? 'На вики нет фото места для этого квеста — только карта' : 'Фото ещё загружаются с вики'); return; }
  openGallery(list, i);
}
function openGallery(list, i = 0) {
  if (!list?.length) return;
  lb = { list, i };
  peek.classList.add('hidden');
  showLb();
  $('#lightbox').classList.remove('hidden');
}
function showLb() {
  const img = lb.list[lb.i];
  $('#lbImg').src = img.full;
  $('#lbCap').textContent = `${img.caption || ''}   ${lb.i + 1} / ${lb.list.length}`;
  $('#lbPrev').classList.toggle('hidden', lb.list.length < 2);
  $('#lbNext').classList.toggle('hidden', lb.list.length < 2);
}
function lbStep(d) { const n = lb.list.length; if (n) { lb.i = (lb.i + d + n) % n; showLb(); } }
function closeLightbox() { $('#lightbox').classList.add('hidden'); }
$('#lbPrev').addEventListener('click', () => lbStep(-1));
$('#lbNext').addEventListener('click', () => lbStep(1));
$('#lbClose').addEventListener('click', closeLightbox);
$('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });

// ---------------------------------------------------------------- условия квеста (общие для всех экранов)
function objRow(t, o, ids) {
  const d = objDone(t, o);
  const c = objCount(o);
  const done = statusOf(t.id) === 'complete';
  const itemIds = objItems(o);
  const here = ids ? objHere(o, ids) : true;
  const go = hasMapPoints(o) ? `<button class="ogo${here ? '' : ' far'}" data-act="focus" data-task="${t.id}" data-obj="${o.id}" title="Показать на карте"><i class="ic ic-target" style="width:12px;height:12px"></i>${here ? 'карта' : 'др. карта'}</button>` : '';
  const counter = c ? `<span class="ocount${d ? ' full' : ''}"><button data-act="cnt" data-obj="${o.id}" data-d="-1" title="−1">−</button><b>${objProgress(t, o)}/${c}</b><button data-act="cnt" data-obj="${o.id}" data-d="1" data-max="${c}" title="+1">+</button></span>` : '';
  const check = done ? '<div class="ocheck locked" title="Квест выполнен"></div>'
    : `<div class="ocheck" data-act="obj" data-obj="${o.id}" data-done="${d ? 1 : 0}" title="${d ? 'Снять отметку' : 'Отметить выполненным'}"></div>`;
  return `<div class="obj${d ? ' done' : ''}">${check}<div class="otext">${esc(objText(o))}${o.optional ? ' <span class="oopt">(необязательно)</span>' : ''}${o.foundInRaid ? ' <span class="tag fir" title="Найдено в рейде">FiR</span>' : ''}
    ${itemIds.length && !d ? `<div class="oitems">${itemIds.slice(0, 4).map((id) => { const it = item(id); return `<span class="oitem" title="${esc(it.n)}"><img src="${esc(it.i || '')}" alt="" loading="lazy">${esc(it.s || it.n)}</span>`; }).join('')}${(o.itemsCount || itemIds.length) > 4 ? `<span class="oitem more">+${(o.itemsCount || itemIds.length) - 4}</span>` : ''}</div>` : ''}
    </div>${counter}${go}</div>`;
}

// делегирование кликов по всему окну
document.addEventListener('click', async (e) => {
  const ext = e.target.closest('[data-ext]');
  if (ext) { e.preventDefault(); api.openExternal(ext.getAttribute('href')); return; }
  const g = e.target.closest('.grp[data-group]');
  if (g) { const k = g.dataset.group; ui.collapsed = ui.collapsed.includes(k) ? ui.collapsed.filter((x) => x !== k) : [...ui.collapsed, k]; saveUi(); render(); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('.leaflet-popup')) return;
  const { act } = el.dataset;
  if (act === 'expand') { const id = el.dataset.task; openTasks.has(id) ? openTasks.delete(id) : openTasks.add(id); render(); return; }
  e.stopPropagation();
  if (act === 'track') { const on = !isTracked(el.dataset.task); await api.setTracked(el.dataset.task, on); if (on) toast('Закреплено: квест вверху задач, точки на карте — янтарные'); }
  if (act === 'obj') await api.toggleObjective(el.dataset.obj, el.dataset.done !== '1');
  if (act === 'cnt') {
    const cur = S.state.profile.counters?.[el.dataset.obj] || 0;
    await api.setCounter(el.dataset.obj, Math.max(0, Math.min(Number(el.dataset.max) || Infinity, cur + Number(el.dataset.d))));
  }
  if (act === 'status') { await api.setManual(el.dataset.task, el.dataset.st || null); if (el.dataset.st === 'complete') toast('Квест отмечен выполненным'); }
  if (act === 'chain') { const list = prereqChain(el.dataset.task); await api.setManualMany(list, 'complete'); toast(list.length ? `Отмечено выполненными: ${list.length}` : 'Предыдущих невыполненных квестов нет'); }
  if (act === 'focus') focusObjective(el.dataset.task, el.dataset.obj);
  if (act === 'shots') openLightbox(el.dataset.id, Number(el.dataset.i || 0));
  if (act === 'dossier') { ui.qSel = el.dataset.task; ui.qStatus = 'all'; saveUi(); setView('dossier'); }
  if (act === 'own') await api.setOwned(el.dataset.id, el.dataset.set != null ? Number(el.dataset.set) : Math.max(0, owned(el.dataset.id) + Number(el.dataset.d)));
  if (act === 'hlvl') await api.setHideout(el.dataset.station, Number(el.dataset.lvl));
});

// ---------------------------------------------------------------- РЕЙД
function ensureRaidMap() {
  if (ui.raidMap && defFor(idx.map.get(ui.raidMap))) return;
  const fromLog = mapByLogId(S.state?.live?.map);
  ui.raidMap = (fromLog && defFor(fromLog) ? fromLog.id : null) || selectableMaps().find((m) => m.normalizedName === 'customs')?.id || selectableMaps()[0]?.id;
}
const groupKey = (id) => [...sameMapIds(id)].sort().join();

function renderMapStrip(counts) {
  const liveMap = mapByLogId(S.state.live.map);
  const liveKey = liveMap && S.state.live.raidState !== 'offline' ? groupKey(liveMap.id) : null;
  // одна кнопка на группу карт (Эпицентр / 21+ и т.п. — вместе)
  const seen = new Set();
  const list = selectableMaps().filter((m) => { const k = groupKey(m.id); if (seen.has(k)) return false; seen.add(k); return true; });
  const cur = groupKey(ui.raidMap);
  setHtml($('#mapStrip'), list.map((m) => {
    const k = groupKey(m.id);
    const n = counts.get(k) || 0;
    return `<button class="mapchip${k === cur ? ' on' : ''}" data-map="${m.id}" title="${esc(m.name)}${n ? ` — активных квестов: ${n}` : ''}">${k === liveKey ? '<span class="live">● LIVE</span>' : ''}${esc(m.name)}${n ? `<em>${n}</em>` : ''}</button>`;
  }).join(''));
}
$('#mapStrip').addEventListener('click', (e) => { const b = e.target.closest('[data-map]'); if (b) changeRaidMap(b.dataset.map); });
function changeRaidMap(id) { if (groupKey(id) === groupKey(ui.raidMap)) return; ui.raidMap = id; ui.follow = false; saveUi(); render(); }
$('#compactMap').addEventListener('change', (e) => { ui.raidMap = e.target.value; ui.follow = false; saveUi(); render(); });

// названия этажей из tarkov.dev — по-русски (значение для карты остаётся оригинальным)
const FLOORS = { 'Ground Floor': '1 этаж', 'Second Floor': '2 этаж', 'Third Floor': '3 этаж', '2nd Floor': '2 этаж', '3rd Floor': '3 этаж', '4th Floor': '4 этаж', '5th Floor': '5 этаж',
  Underground: 'Подвал', Basement: 'Подвал', Tunnels: 'Тоннели', Bunkers: 'Бункеры', Garage: 'Гараж', 'Second Level': '2 уровень', Technical: 'Техуровень' };
const floorName = (f) => FLOORS[f] || f;

function renderRaid() {
  ensureRaidMap();
  const m = idx.map.get(ui.raidMap);
  const def = defFor(m);
  const ids = sameMapIds(ui.raidMap);
  $('#mapFollow').checked = ui.follow;

  // сколько активных квестов на каждой карте — для полосы карт
  const counts = new Map();
  for (const t of S.data.tasks) {
    if (statusOf(t.id) !== 'active') continue;
    new Set([...t._maps].map(groupKey)).forEach((k) => counts.set(k, (counts.get(k) || 0) + 1));
  }
  if (!ui.compact) renderMapStrip(counts);
  const sel = $('#compactMap');
  const opts = selectableMaps().map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  if (sel._o !== opts) { sel.innerHTML = opts; sel._o = opts; }
  sel.value = ui.raidMap;

  // складные панели
  for (const id of ['dockLeft', 'dockRight']) {
    const folded = ui.fold.includes(id) && !ui.compact;
    $('#' + id).classList.toggle('hidden', folded);
    $(`[data-unfold="${id}"]`).classList.toggle('hidden', !folded);
  }
  document.body.classList.toggle('no-right', ui.fold.includes('dockRight'));
  document.body.classList.toggle('no-left', ui.fold.includes('dockLeft'));

  if (loadedMapId !== ui.raidMap && !ui.compact) {
    loadedMapId = ui.raidMap;
    pointsSig = locksSig = '';
    tmap.style = localStorage.getItem('mapStyle') || 'svg';
    tmap.load(def, m);
    updateFloorUi(0);
    if (m && !mapWiki.has(m.id)) api.getMapWiki(m.id).then((w) => { if (w) { mapWiki.set(m.id, w); render(); } });
    $('#styleSeg').classList.toggle('hidden', !tmap.hasStyles());
    $$('#styleSeg button').forEach((b) => b.classList.toggle('on', b.dataset.style === tmap.style));
    $('#mapCredit').textContent = def?.author ? `карта: ${def.author} · tarkov.dev` : 'tarkov.dev';
    const pos = S.state.live.position;
    if (pos && ids.has(mapByLogId(pos.map)?.id)) tmap.setPlayer(pos);
  }
  $('#mapEmpty').classList.toggle('hidden', !!def);
  if (!def) $('#mapEmpty').innerHTML = '<div><b>Для этой карты нет схемы</b>Выбери другую локацию</div>';

  const g = raidGroups(ui.raidMap);
  const here = [...g.tracked.filter((t) => taskOnMap(t, ui.raidMap)), ...g.onMap];
  const number = new Map(here.map((t, i) => [t.id, i + 1]));
  wantWiki([...g.tracked, ...here, ...g.anywhere.slice(0, 10)].map((t) => t.id));

  if (!ui.compact) {
    const points = [];
    const addPoints = (t, extra) => {
      for (const o of t.objectives) {
        const base = { objectiveId: o.id, taskId: t.id, title: t.name, sub: trader(t.trader).name, text: objText(o), ...extra(o) };
        for (const z of o.zones || []) if (ids.has(z.map) && z.position) points.push({ ...base, kind: 'zone', position: z.position, outline: z.outline, top: z.top, bottom: z.bottom });
        for (const l of o.possibleLocations || []) if (ids.has(l.map)) for (const p of l.positions) points.push({ ...base, kind: 'item', position: p });
      }
    };
    for (const t of here) addPoints(t, (o) => ({ done: objDone(t, o), n: number.get(t.id), tracked: isTracked(t.id) }));
    for (const t of g.avail) addPoints(t, () => ({ avail: true, n: '', sub: `${trader(t.trader).name} · можно взять` }));
    const sig = points.map((p) => `${p.objectiveId}${p.done ? 1 : 0}${p.n}${p.tracked ? 't' : ''}${p.avail ? 'a' : ''}`).join('|');
    if (sig !== pointsSig) { pointsSig = sig; tmap.drawQuests(points); }
    const needKeys = new Set();
    for (const t of here) {
      for (const nk of t.neededKeys || []) if (ids.has(nk.map)) nk.keys.forEach((k) => needKeys.add(idOf(k)));
      for (const o of t.objectives) if (objOnMap(o, ids)) for (const alt of o.requiredKeys || []) (Array.isArray(alt) ? alt : [alt]).forEach((k) => needKeys.add(idOf(k)));
    }
    const ls = ui.raidMap + [...needKeys].sort().join();
    if (ls !== locksSig) { locksSig = ls; tmap.drawLocks(m?.locks, (id) => ({ name: item(id).n, need: needKeys.has(id) })); }
  }

  // брифинг
  $('#briefMap').textContent = m?.name || '—';
  const info = [];
  if (m?.raidDuration) info.push(`${m.raidDuration} мин`);
  if (m?.players) info.push(`${m.players} игроков`);
  const bosses = (m?.bosses || []).filter((b) => b.name && b.spawnChance > 0).map((b) => `${b.name} ${Math.round(b.spawnChance * 100)}%`);
  if (bosses.length) info.push(bosses.slice(0, 2).join(', '));
  $('#briefInfo').textContent = info.join(' · ');
  $$('#briefTabs button').forEach((b) => b.classList.toggle('on', b.dataset.brief === ui.brief));
  const bring = bringHtml(bringList(here, ids));
  $('#bringCount').textContent = bring.count || '';
  setHtml($('#briefBody'), ui.brief === 'bring' ? bring.html : exitsHtml(m));

  // задачи
  $('#taskInfo').textContent = `${m?.name || ''} · на карте ${here.length}${g.tracked.length ? ` · закреплено ${g.tracked.length}` : ''}`;
  const group = (key, title, list, opt = {}) => {
    if (!list.length) return '';
    const col = ui.collapsed.includes(key);
    return `<div class="grp${col ? ' collapsed' : ''}" data-group="${key}"><span class="chev"></span>${title} · ${list.length}</div>`
      + (col ? '' : list.map((t) => taskRow(t, { n: number.get(t.id), ids, ...opt })).join(''));
  };
  let html = group('tracked', '★ Закреплённые', g.tracked) + group('here', 'На этой карте', g.onMap)
    + group('anywhere', 'На любой локации', g.anywhere) + group('avail', 'Можно взять здесь', g.avail, { avail: true });
  if (!here.length && !g.tracked.length) html = '<div class="empty"><b>На этой карте активных задач нет</b>Возьми квест в игре — он появится здесь сам. ★ закрепит любой квест наверху.</div>' + html;
  setHtml($('#taskBody'), html);
}

function taskRow(t, opt) {
  const tr = trader(t.trader);
  const st = statusOf(t.id);
  const objs = t.objectives.filter((o) => !o.optional);
  const done = objs.filter((o) => objDone(t, o)).length;
  const tracked = isTracked(t.id);
  const isOpen = openTasks.has(t.id);
  let body = '';
  if (!opt.avail) {
    const undone = t.objectives.filter((o) => !objDone(t, o) && !o.optional).sort((a, b) => objHere(b, opt.ids) - objHere(a, opt.ids));
    const list = isOpen ? t.objectives : undone.slice(0, 3);
    body = `<div class="task-b">${list.map((o) => objRow(t, o, opt.ids)).join('')}${!isOpen && undone.length > 3 ? `<div class="task-more" data-act="expand" data-task="${t.id}">ещё ${undone.length - 3}…</div>` : ''}</div>`;
  }
  const maps = mapNames(t);
  return `<div class="task${tracked ? ' tracked' : ''}${opt.avail ? ' avail' : ''}" data-task="${t.id}">
    <div class="task-h" data-act="expand" data-task="${t.id}" title="${isOpen ? 'Свернуть' : 'Все условия'}">
      <span class="tnum${opt.n ? '' : ' none'}">${opt.n || '·'}</span>
      <div class="task-t"><div class="task-n">${esc(t.name)}</div><div class="task-m"><img src="${esc(tr.imageLink)}" alt="" loading="lazy">${esc(tr.name)} · ${esc(maps.slice(0, 2).join(', ') || 'любая карта')}${t.minPlayerLevel > 1 ? ` · ур. ${t.minPlayerLevel}` : ''}</div></div>
      ${st === 'active' && objs.length ? `<span class="task-p">${done}/${objs.length}</span>` : ''}
      ${camBtn(t.id)}
      <button class="ibtn star${tracked ? ' on' : ''}" data-act="track" data-task="${t.id}" title="${tracked ? 'Открепить' : 'Закрепить наверху'}">★</button>
      <button class="ibtn" data-act="dossier" data-task="${t.id}" title="Открыть в досье"><i class="ic ic-dossier" style="width:13px;height:13px"></i></button>
    </div>${body}</div>`;
}

function bringHtml(groups) {
  const titles = { keys: 'Ключи', plant: 'Спрятать / отметить', use: 'Использовать', wear: 'Надеть / оружие', find: 'Найти на карте', fir: 'Найти в рейде для сдачи' };
  let html = '', count = 0;
  for (const [g, map] of Object.entries(groups)) {
    if (!map.size) continue;
    html += `<div class="grp static">${titles[g]}</div>`;
    for (const v of map.values()) {
      const it = item(v.id);
      count++;
      html += `<div class="bring"><img src="${esc(it.i || '')}" alt="" loading="lazy"><div class="bn"><b>${esc(it.n)}${v.alts > 0 ? ` <span class="tag">или ещё ${v.alts}</span>` : ''}</b><span>${esc([...v.why].join(', '))}</span></div><div class="bc">×${v.count}</div></div>`;
    }
  }
  return { html: html || '<div class="empty"><b>Ничего особенного</b>Ключи, маркеры, закладки и снаряжение для задач на этой карте появятся здесь.</div>', count };
}

function exitsHtml(m) {
  if (!m) return '';
  const by = (f) => (m.extracts || []).filter((e) => e.faction === f);
  const row = (e, color, note) => {
    const media = tmap.exitMedia(e);
    const img = media?.images?.[0];
    const req = media?.requirements || note || '';
    return `<div class="exit" data-focus='${esc(JSON.stringify(e.position))}' ${img ? `data-peekimg="${esc(img.thumb)}" data-peekcap="${esc(e.name)}"` : ''} title="Показать на карте"><i style="background:${color}"></i><span>${esc(e.name)}${req ? `<small class="exit-req">${esc(req)}</small>` : ''}</span>${img ? '<i class="ic ic-cam exit-cam"></i>' : ''}</div>`;
  };
  const sec = (title, list, color, note) => (list.length ? `<div class="grp static">${title} · ${list.length}</div>` + list.map((e) => row(e, color, note?.(e))).join('') : '');
  return sec('ЧВК', by('pmc'), 'var(--ok)', (e) => (e.switch ? 'рубильник' : '')) + sec('Общие', by('shared'), 'var(--accent)', (e) => (e.switch ? 'рубильник' : ''))
    + sec('Дикие', by('scav'), 'var(--amber)') + sec('Переходы', (m.transits || []).map((e) => ({ ...e, name: e.description })), 'var(--violet)') || '<div class="empty">Нет данных о выходах</div>';
}
$('#briefBody').addEventListener('click', (e) => { const r = e.target.closest('[data-focus]'); if (r) tmap.focusPoint(JSON.parse(r.dataset.focus)); });
$$('#briefTabs button').forEach((b) => b.addEventListener('click', () => { ui.brief = b.dataset.brief; saveUi(); render(); }));
$$('[data-fold]').forEach((b) => b.addEventListener('click', () => { ui.fold = [...new Set([...ui.fold, b.dataset.fold])]; saveUi(); render(); setTimeout(() => tmap.map?.invalidateSize(), 30); }));
$$('[data-unfold]').forEach((b) => b.addEventListener('click', () => { ui.fold = ui.fold.filter((x) => x !== b.dataset.unfold); saveUi(); render(); }));
$('#taskBody').addEventListener('mouseover', (e) => tmap.highlightTask(e.target.closest('.task')?.dataset.task || null));
$('#taskBody').addEventListener('mouseleave', () => tmap.highlightTask(null));
$('#mapFollow').addEventListener('change', (e) => {
  ui.follow = e.target.checked; saveUi();
  if (ui.follow) { const m = mapByLogId(S.state?.live?.map); if (m && defFor(m)) ui.raidMap = m.id; render(); }
});
$('#floorSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-floor]'); if (!b) return;
  tmap.setFloor(b.dataset.floor);
  $$('#floorSeg button').forEach((x) => x.classList.toggle('on', x === b));
});
$$('#styleSeg button').forEach((b) => b.addEventListener('click', () => {
  localStorage.setItem('mapStyle', b.dataset.style);
  tmap.setStyle(b.dataset.style);
  updateFloorUi(tmap.buildings.length);
  $$('#styleSeg button').forEach((x) => x.classList.toggle('on', x === b));
}));
$$('#layerChips .chip').forEach((b) => {
  const saved = localStorage.getItem('layer-' + b.dataset.layer);
  if (saved != null) b.classList.toggle('on', saved === '1');
  tmap.layersOn[b.dataset.layer] = b.classList.contains('on');
  b.addEventListener('click', () => {
    const on = !b.classList.contains('on');
    b.classList.toggle('on', on);
    localStorage.setItem('layer-' + b.dataset.layer, on ? '1' : '0');
    tmap.setLayer(b.dataset.layer, on);
  });
});
$('#btnFit').addEventListener('click', () => tmap.fit());
$('#btnMe').addEventListener('click', () => {
  if (tmap.me) tmap.focusPoint(tmap.me);
  else toast(S.state?.settings?.screenshotsEnabled ? 'Сделай скриншот в игре (Print Screen) — позиция появится на карте' : 'Включи «Позиция по скриншотам» в настройках');
});

function focusObjective(taskId, objId) {
  const t = idx.task.get(taskId);
  const o = t?.objectives.find((x) => x.id === objId);
  if (!o) return;
  const pts = [...(o.zones || []).map((z) => z.map), ...(o.possibleLocations || []).map((l) => l.map)];
  if (!pts.some((id) => sameMapIds(ui.raidMap).has(id))) {
    const target = pts.map((id) => idx.map.get(id)).find((m) => m && defFor(m));
    if (target) { ui.raidMap = target.id; ui.follow = false; saveUi(); toast(`Карта: ${target.name} (следование за игрой выключено)`); }
  }
  if (!['active', 'available'].includes(statusOf(taskId))) toast('Квест не активен — на карте показываются точки активных квестов');
  if (ui.compact) api.win('compact');
  if (ui.view !== 'raid') setView('raid'); else render();
  setTimeout(() => {
    if (!tmap.focusObjective(objId)) {
      const p = o.zones?.[0]?.position || o.possibleLocations?.[0]?.positions?.[0];
      if (p) tmap.focusPoint(p);
    }
  }, 160);
}

tmap.onPopupAction = async (d) => {
  if (d.act === 'toggleObj') { await api.toggleObjective(d.id, !S.state.profile.objectives[d.id]); tmap.map?.closePopup(); }
  if (d.act === 'openTask') { ui.qSel = d.id; ui.qStatus = 'all'; saveUi(); setView('dossier'); }
  if (d.act === 'shots') openLightbox(d.id, 0);
};

// ---------------------------------------------------------------- ДОСЬЕ
const STATUSES = [['active', 'Активные'], ['tracked', '★ Закреплённые'], ['available', 'Можно взять'], ['locked', 'Закрытые'], ['complete', 'Выполненные'], ['all', 'Все квесты']];
const stOk = (t) => ui.qStatus === 'all' || (ui.qStatus === 'tracked' ? isTracked(t.id) : statusOf(t.id) === ui.qStatus);
function renderDossier() {
  const q = ui.qSearch.trim().toLowerCase();
  if (document.activeElement !== $('#qSearch')) $('#qSearch').value = ui.qSearch;
  $('#qKappa').checked = ui.qKappa; $('#qLk').checked = ui.qLk; $('#qSort').value = ui.qSort;
  const mapOpts = '<option value="">Все карты</option>' + selectableMaps().map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  if ($('#qMap')._o !== mapOpts) { $('#qMap').innerHTML = mapOpts; $('#qMap')._o = mapOpts; }
  $('#qMap').value = ui.qMap;

  const base = S.data.tasks.filter((t) => (!ui.qMap || taskOnMap(t, ui.qMap)) && (!ui.qKappa || t.kappaRequired) && (!ui.qLk || t.lightkeeperRequired) && (!q || t._hay.includes(q)));
  const sc = {};
  for (const t of base) {
    const s = statusOf(t.id); sc[s] = (sc[s] || 0) + 1; sc.all = (sc.all || 0) + 1;
    if (isTracked(t.id)) sc.tracked = (sc.tracked || 0) + 1;
  }
  setHtml($('#qStatusList'), STATUSES.map(([k, l]) => `<button class="fitem${ui.qStatus === k ? ' on' : ''}" data-st="${k}"><span>${l}</span><em>${sc[k] || 0}</em></button>`).join(''));
  const tc = new Map();
  for (const t of base) if (stOk(t)) tc.set(t.trader, (tc.get(t.trader) || 0) + 1);
  const trs = S.data.traders.filter((t) => S.data.tasks.some((x) => x.trader === t.id));
  setHtml($('#qTraderList'), `<button class="fitem${!ui.qTrader ? ' on' : ''}" data-tr=""><span>Все торговцы</span></button>` +
    trs.map((t) => `<button class="fitem${ui.qTrader === t.id ? ' on' : ''}${tc.get(t.id) ? '' : ' zero'}" data-tr="${t.id}"><img src="${esc(t.imageLink)}" alt="" loading="lazy"><span>${esc(t.name)}</span><em>${tc.get(t.id) || 0}</em></button>`).join(''));

  const sorters = {
    trader: (a, b) => byTrader(a, b) || (a.minPlayerLevel || 0) - (b.minPlayerLevel || 0),
    level: (a, b) => (a.minPlayerLevel || 0) - (b.minPlayerLevel || 0) || byTrader(a, b),
    map: (a, b) => (mapNames(a)[0] || 'я').localeCompare(mapNames(b)[0] || 'я', 'ru') || byTrader(a, b),
    progress: (a, b) => taskPct(b) - taskPct(a) || byTrader(a, b),
  };
  const list = base.filter((t) => stOk(t) && (!ui.qTrader || t.trader === ui.qTrader)).sort(sorters[ui.qSort] || sorters.trader);
  $('#qListTitle').textContent = (STATUSES.find(([k]) => k === ui.qStatus) || [null, 'Квесты'])[1];
  $('#qListCount').textContent = `${list.length}`;
  if (!ui.qSel || !idx.task.get(ui.qSel)) ui.qSel = list[0]?.id || null;
  const shown = list.slice(0, 400);
  setHtml($('#qList'), shown.length ? shown.map((t) => {
    const st = statusOf(t.id);
    const pct = Math.round(taskPct(t) * 100);
    return `<div class="qrow${ui.qSel === t.id ? ' on' : ''}" data-task="${t.id}"><img src="${esc(trader(t.trader).imageLink)}" alt="" loading="lazy">
      <div class="qr-t"><div class="qr-n">${isTracked(t.id) ? '<span class="star-on">★</span> ' : ''}${esc(t.name)}</div><div class="qr-m"><i class="dot ${st}"></i>${esc(trader(t.trader).name)} · ${esc(mapNames(t)[0] || 'любая карта')}${t.minPlayerLevel > 1 ? ` · ур. ${t.minPlayerLevel}` : ''}</div></div>
      ${st === 'active' ? `<div class="bar" title="${pct}%"><i style="width:${pct}%"></i></div>` : ''}</div>`;
  }).join('') : `<div class="empty"><b>Пусто</b>${ui.qStatus === 'active' ? 'Активные квесты появляются сами, когда берёшь их в игре. Взятые до установки — отметь «Уже взят» во вкладке «Можно взять».' : 'Измени фильтры или поиск'}</div>`);
  renderQuestDetail(idx.task.get(ui.qSel));
}
function selectQuest(id) { ui.qSel = id; saveUi(); render(); }
$('#qList').addEventListener('click', (e) => { const r = e.target.closest('.qrow'); if (r) selectQuest(r.dataset.task); });
$('#qStatusList').addEventListener('click', (e) => { const b = e.target.closest('[data-st]'); if (b) { ui.qStatus = b.dataset.st; ui.qSel = null; saveUi(); render(); } });
$('#qTraderList').addEventListener('click', (e) => { const b = e.target.closest('[data-tr]'); if (b) { ui.qTrader = b.dataset.tr; ui.qSel = null; saveUi(); render(); } });
$('#qMap').addEventListener('change', (e) => { ui.qMap = e.target.value; ui.qSel = null; saveUi(); render(); });
$('#qSort').addEventListener('change', (e) => { ui.qSort = e.target.value; saveUi(); render(); });
$('#qKappa').addEventListener('change', (e) => { ui.qKappa = e.target.checked; saveUi(); render(); });
$('#qLk').addEventListener('change', (e) => { ui.qLk = e.target.checked; saveUi(); render(); });
$('#qSearch').addEventListener('input', debounce((e) => { ui.qSearch = e.target.value; ui.qSel = null; render(); }, 120));

const wikiAsked = new Set();
function renderQuestDetail(t) {
  if (!t) { setHtml($('#qDetail'), '<div class="dt-empty"><div><span class="glyph big"></span><br><br>Выбери квест в списке</div></div>'); return; }
  if (!S.wiki.has(t.id) && t.wikiLink && !wikiAsked.has(t.id)) {
    wikiAsked.add(t.id);
    api.getWiki(t.id).then((d) => { if (d) { S.wiki.set(t.id, d); render(); } });
  }
  const st = statusOf(t.id);
  const info = statusInfo(t.id);
  const tr = trader(t.trader);
  const tracked = isTracked(t.id);
  const w = S.wiki.get(t.id);
  const maps = mapNames(t);
  const tags = [
    `<span class="tag st-${st}">${ST_LABEL[st]}</span>`,
    t.factionName && t.factionName !== 'Any' ? `<span class="tag${info.otherFaction ? ' bad' : ''}">${esc(t.factionName)}</span>` : '',
    t.kappaRequired ? '<span class="tag kappa">Каппа</span>' : '', t.lightkeeperRequired ? '<span class="tag lk">Смотритель</span>' : '',
    info.levelLocked ? `<span class="tag bad">нужен ур. ${t.minPlayerLevel}</span>` : '',
  ].join('');
  const prev = (t.taskRequirements || []).map((r) => idx.task.get(idOf(r.task))).filter(Boolean);
  const next = (idx.next.get(t.id) || []).map((id) => idx.task.get(id)).filter(Boolean);
  const qlink = (x) => `<button class="qlink" data-sel="${x.id}"><i class="${statusOf(x.id)}"></i>${esc(x.name)}</button>`;
  const rew = [];
  if (t.experience) rew.push(`<span class="tag">${fmt(t.experience)} опыта</span>`);
  for (const r of t.finishRewards?.items || []) { const it = item(r.item); rew.push(`<span class="oitem"><img src="${esc(it.i || '')}" alt="" loading="lazy">${esc(it.s || it.n)} ×${fmt(r.count)}</span>`); }
  const src = info.src === 'log' ? 'статус — по логам игры' : info.src === 'manual' ? 'статус отмечен вручную' : info.src === 'implied' ? 'выполнен по цепочке' : '';
  const gallery = w?.images?.length
    ? `<div class="gallery">${w.images.map((im, i) => `<div class="shot" data-act="shots" data-id="${t.id}" data-i="${i}" title="${esc(im.caption)}"><img src="${esc(im.thumb)}" alt="" loading="lazy"><span>${esc(im.caption)}</span></div>`).join('')}</div>`
    : `<div class="note">${!t.wikiLink ? 'У квеста нет страницы на вики.' : w ? 'На вики для этого квеста есть только карта — фото самого места нет. Точка уже отмечена на нашей карте.' : 'Загружаю фото места с вики…'}</div>`;
  setHtml($('#qDetail'), `
    <div class="dt-head"><img class="portrait" src="${esc(tr.imageLink)}" alt="">
      <div class="dt-title"><h2>${esc(t.name)}</h2>
        <div class="dt-meta">${esc(tr.name)} · ${esc(maps.join(', ') || 'любая карта')}${t.minPlayerLevel > 1 ? ` · с ${t.minPlayerLevel} ур.` : ''} ${tags}</div>
        <div class="dt-actions">
          ${st !== 'complete' && st !== 'failed' ? `<button class="btn sm${tracked ? ' accent' : ''}" data-act="track" data-task="${t.id}">${tracked ? '★ Закреплён' : '☆ Закрепить'}</button>` : ''}
          ${st !== 'active' && st !== 'complete' ? `<button class="btn sm" data-act="status" data-st="active" data-task="${t.id}" title="Если квест уже взят, но этого нет в логах">Уже взят</button>` : ''}
          ${st !== 'complete' ? `<button class="btn sm" data-act="status" data-st="complete" data-task="${t.id}">Выполнен</button>` : ''}
          ${st === 'locked' || st === 'available' ? `<button class="btn sm" data-act="chain" data-task="${t.id}">Предыдущие выполнены</button>` : ''}
          ${info.src === 'manual' ? `<button class="btn sm" data-act="status" data-st="" data-task="${t.id}">Отменить отметку</button>` : ''}
          ${t.wikiLink ? `<a class="btn sm" href="${esc(t.wikiLink)}" data-ext style="display:inline-flex;align-items:center">Вики ↗</a>` : ''}
        </div>
        ${src ? `<div class="note">${src}</div>` : ''}
      </div></div>
    <div class="dt-sec"><div class="panel-title">Условия</div><div class="dt-obj">${t.objectives.map((o) => objRow(t, o, null)).join('')}</div></div>
    <div class="dt-sec"><div class="panel-title">Фото места</div>${gallery}
      ${w?.guide ? `<div class="guide" style="margin-top:8px">${esc(w.guide)}</div>` : ''}
      ${w?.images?.length || w?.guide ? '<div class="attrib">Источник: Escape from Tarkov Wiki (escapefromtarkov.fandom.com), CC BY-SA</div>' : ''}</div>
    ${prev.length || next.length ? `<div class="dt-sec"><div class="panel-title">Цепочка</div>
      ${prev.length ? `<div class="chain"><span class="note" style="margin:0">после:</span>${prev.map(qlink).join('')}</div>` : ''}
      ${next.length ? `<div class="chain" style="margin-top:6px"><span class="note" style="margin:0">открывает:</span>${next.map(qlink).join('')}</div>` : ''}</div>` : ''}
    ${rew.length ? `<div class="dt-sec"><div class="panel-title">Награда</div><div class="rewards">${rew.join('')}</div></div>` : ''}
  `);
}
$('#qDetail').addEventListener('click', (e) => { const b = e.target.closest('[data-sel]'); if (b) { ui.qSel = b.dataset.sel; ui.qStatus = 'all'; saveUi(); render(); } });

// ---------------------------------------------------------------- УБЕЖИЩЕ
function skillName(id) { return S.data.skills?.find((s) => s.id === id)?.name || id; }
function fmtTime(sec) { const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return h ? `${h} ч${m ? ' ' + m + ' мин' : ''}` : `${m} мин`; }
function renderBase() {
  const order = { ready: 0, open: 1, blocked: 2, max: 3 };
  const withState = S.data.hideout.map((s) => ({ s, st: stationState(s) })).sort((a, b) => order[a.st.state] - order[b.st.state] || a.s.name.localeCompare(b.s.name, 'ru'));
  if (!ui.station || !idx.station.get(ui.station)) ui.station = withState[0]?.s.id;
  setHtml($('#baseTiles'), withState.map(({ s, st }) => {
    const max = maxLevel(s);
    // клик по делению: отметить построенный уровень (повторный клик по текущему — на уровень ниже)
    const pips = Array.from({ length: max + 1 }, (_, i) => `<button class="pip${i === 0 ? ' zero' : ''}${i <= st.lvl && i > 0 ? ' on' : ''}" data-act="hlvl" data-station="${s.id}" data-lvl="${i === st.lvl && i > 0 ? i - 1 : i}" title="${i === 0 ? 'Не построено' : `Построен уровень ${i}`}">${i}</button>`).join('');
    const sub = st.state === 'max' ? 'максимум' : st.state === 'blocked' ? `ур. ${st.lvl + 1}: нужен другой модуль` : `ур. ${st.lvl + 1}: предметы ${st.have}/${st.total}`;
    return `<div class="tile ${st.state}${ui.station === s.id ? ' on' : ''}" data-station="${s.id}"><div class="tile-top"><img src="${esc(s.imageLink || '')}" alt="" loading="lazy"><span class="tile-name">${esc(s.name)}</span><i class="tile-state"></i></div>
      <div class="pips">${pips}</div><div class="tile-sub">${sub}</div></div>`;
  }).join(''));
  const s = idx.station.get(ui.station);
  if (!s) return;
  const lvl = built(s.id);
  const lv = s.levels.map((l) => {
    const isDone = l.level <= lvl, isNext = l.level === lvl + 1;
    const lines = [];
    for (const r of l.stationLevelRequirements) { const ok = built(r.station) >= r.level; lines.push(`<div class="req ${isDone ? '' : ok ? 'ok' : 'no'}">${ok ? '✓' : '•'} ${esc(idx.station.get(r.station)?.name || '?')} — ур. ${r.level}</div>`); }
    for (const r of l.traderRequirements) lines.push(`<div class="req">• ${esc(trader(r.trader).name)} — ${r.requirementType === 'reputation' ? 'репутация' : 'уровень'} ${r.value}</div>`);
    for (const r of l.skillRequirements) lines.push(`<div class="req">• Умение ${esc(skillName(r.name))} — ${r.level}</div>`);
    if (l.constructionTime) lines.push(`<div class="req">⏱ ${fmtTime(l.constructionTime)}</div>`);
    const items = l.itemRequirements.map((r) => {
      const it = item(r.item), h = owned(r.item), money = MONEY.has(r.item);
      return `<div class="ritem${!money && h >= r.count ? ' have' : ''}" title="${esc(it.n)}"><img src="${esc(it.i || '')}" alt="" loading="lazy"><div class="rn"><b>${esc(it.s || it.n)}</b>${money ? fmt(r.count) : `${h}/${r.count}`}${r.fir ? ' <span class="tag fir">FiR</span>' : ''}</div>
        ${money || isDone ? '' : `<div class="step"><button data-act="own" data-id="${r.item}" data-d="1">+</button><button data-act="own" data-id="${r.item}" data-d="-1">−</button></div>`}</div>`;
    }).join('');
    return `<div class="lvl${isDone ? ' done' : ''}${isNext ? ' next' : ''}"><div class="lvl-h"><b>Уровень ${l.level}</b><span>${isDone ? 'построен' : isNext ? 'следующий' : ''}</span>
      ${isNext ? `<button class="btn sm accent" data-act="hlvl" data-station="${s.id}" data-lvl="${l.level}">✓ Построил</button>` : ''}</div>${lines.join('')}${isDone ? '' : `<div class="reqitems">${items}</div>`}</div>`;
  }).join('');
  setHtml($('#baseDetail'), `<div class="dt-head"><img class="portrait" src="${esc(s.imageLink || '')}" alt="" style="object-fit:contain;padding:6px">
    <div class="dt-title"><h2>${esc(s.name)}</h2><div class="dt-meta">построено: ${lvl} из ${maxLevel(s)}</div></div></div><div class="lvls">${lv}</div>`);
}
$('#baseTiles').addEventListener('click', (e) => { if (e.target.closest('[data-act]')) return; const t = e.target.closest('[data-station]'); if (t) { ui.station = t.dataset.station; saveUi(); render(); } });

// ---------------------------------------------------------------- СКЛАД
let itemIndex = null;
// одинаковые источники — одной строкой с количеством («Квест — закладка ×3»)
const srcList = (list) => { const m = new Map(); for (const s of list) m.set(s, (m.get(s) || 0) + 1); return [...m].map(([s, n]) => (n > 1 ? `${s} ×${n}` : s)); };
const priceCell = (it) => `${it.p ? `барахолка <b>${fmt(it.p)}</b>` : ''}${it.b?.p ? `<br>${esc(it.b.t)} <b>${fmt(it.b.p)}</b>` : ''}`;
function renderStash() {
  $$('#iQuestSeg button').forEach((b) => b.classList.toggle('on', b.dataset.iq === ui.iQuest));
  $$('#iHideSeg button').forEach((b) => b.classList.toggle('on', b.dataset.ih === ui.iHide));
  $('#iFir').checked = ui.iFir; $('#iHideDone').checked = ui.iHideDone;
  if (document.activeElement !== $('#iSearch')) $('#iSearch').value = ui.iSearch;
  const q = ui.iSearch.trim().toLowerCase();
  let list = neededItems({ quests: ui.iQuest, hideout: ui.iHide });
  const all = list.length;
  let left = 0, cost = 0, firLeft = 0;
  for (const x of list) {
    if (x.key.startsWith('obj:') || MONEY.has(x.id)) continue;
    const miss = Math.max(0, x.count - owned(x.key));
    if (miss) { left++; cost += miss * (item(x.id).p || 0); if (x.fir) firLeft++; }
  }
  if (ui.iFir) list = list.filter((x) => x.fir);
  if (ui.iHideDone) list = list.filter((x) => x.key.startsWith('obj:') || MONEY.has(x.id) || owned(x.key) < x.count);
  if (q) list = list.filter((x) => (x.label || item(x.id).n).toLowerCase().includes(q) || (item(x.id).s || '').toLowerCase().includes(q));
  list.sort((a, b) => (MONEY.has(a.id) - MONEY.has(b.id)) || b.sources.length - a.sources.length || b.count - a.count);
  $('#stashCaption').textContent = 'Отмечай «+», когда кладёшь предмет в схрон. Счётчики общие с «Убежищем».';
  setHtml($('#stashSummary'), [
    `<div class="stat"><b>${all}</b><span>позиций нужно</span></div>`,
    `<div class="stat"><b>${left}</b><span>ещё не собрано</span></div>`,
    `<div class="stat"><b>${firLeft}</b><span>из них найти в рейде (FiR)</span></div>`,
    `<div class="stat"><b>${fmt(cost)} ₽</b><span>докупить всё на барахолке</span></div>`,
  ].join(''));
  const rows = list.slice(0, 300).map((x) => {
    const it = item(x.id), money = MONEY.has(x.id), grp = x.key.startsWith('obj:');
    const have = grp ? null : owned(x.key);
    const src = srcList(x.sources);
    const cnt = grp ? `<div class="cnt"><b>×${x.count}</b></div>` : money ? `<div class="cnt"><b>${fmt(x.count)}</b></div>`
      : `<div class="cnt"><button data-act="own" data-id="${x.key}" data-d="-1">−</button><b>${have}<small>/${x.count}</small></b><button data-act="own" data-id="${x.key}" data-d="1">+</button><button data-act="own" data-id="${x.key}" data-set="${x.count}" title="Собрано всё">✓</button></div>`;
    return `<div class="tr${have != null && !money && have >= x.count ? ' have' : ''}"><img src="${esc(it.i || '')}" alt="" loading="lazy">
      <div class="nm"><b title="${esc(x.label || it.n)}">${esc(x.label || it.n)}</b>${x.fir ? '<span class="tag fir">FiR</span>' : ''}</div>${cnt}
      <div class="src" title="${esc(src.join('\n'))}">${esc(src.slice(0, 3).join(' · '))}${src.length > 3 ? ` · ещё ${src.length - 3}` : ''}</div>
      <div class="pr">${priceCell(it)}</div></div>`;
  });
  let extra = '';
  if (q.length >= 2 && list.length < 6) {
    if (!itemIndex) itemIndex = Object.entries(S.data.items).map(([id, it]) => [id, `${it.n} ${it.s}`.toLowerCase(), it]);
    const more = itemIndex.filter(([id, hay]) => hay.includes(q) && !list.some((x) => x.id === id)).slice(0, 20);
    if (more.length) extra = '<div class="tr th"><span></span><span>Сейчас не нужны</span><span></span><span>Ещё понадобится</span><span>Цена, ₽</span></div>' + more.map(([id, , it]) => {
      const used = S.data.tasks.filter((t) => statusOf(t.id) !== 'complete' && t.objectives.some((o) => objItems(o).includes(id))).map((t) => t.name);
      return `<div class="tr"><img src="${esc(it.i || '')}" alt="" loading="lazy"><div class="nm"><b>${esc(it.n)}</b></div><div></div><div class="src">${esc(used.slice(0, 3).join(', ') || 'можно продавать')}</div><div class="pr">${priceCell(it)}</div></div>`;
    }).join('');
  }
  setHtml($('#stashTable'), (rows.length ? '<div class="tr th"><span></span><span>Предмет</span><span>Собрано</span><span>Для чего</span><span>Цена, ₽</span></div>' + rows.join('')
    : `<div class="empty"><b>${q ? 'Ничего не найдено' : 'Всё собрано'}</b>${q ? '' : 'Или нет активных квестов — включи «все невыполненные».'}</div>`) + extra);
}
$$('#iQuestSeg button').forEach((b) => b.addEventListener('click', () => { ui.iQuest = b.dataset.iq; saveUi(); render(); }));
$$('#iHideSeg button').forEach((b) => b.addEventListener('click', () => { ui.iHide = b.dataset.ih; saveUi(); render(); }));
$('#iFir').addEventListener('change', (e) => { ui.iFir = e.target.checked; saveUi(); render(); });
$('#iHideDone').addEventListener('change', (e) => { ui.iHideDone = e.target.checked; saveUi(); render(); });
$('#iSearch').addEventListener('input', debounce((e) => { ui.iSearch = e.target.value; render(); }, 150));

// ---------------------------------------------------------------- СВОДКА
const ring = (pct, color = 'var(--accent)') => {
  const c = 2 * Math.PI * 18, off = c * (1 - Math.max(0, Math.min(1, pct || 0)));
  return `<svg class="ring" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="var(--line)" stroke-width="4"/><circle cx="22" cy="22" r="18" fill="none" stroke="${color}" stroke-width="4" stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 22 22)"/></svg>`;
};
function renderSummary() {
  const p = S.state.profile;
  const cnt = { active: 0, available: 0, complete: 0 };
  let kA = 0, kD = 0, lA = 0, lD = 0;
  for (const t of S.data.tasks) {
    const s = statusOf(t.id);
    if (s in cnt) cnt[s]++;
    if (t.kappaRequired) { kA++; if (s === 'complete') kD++; }
    if (t.lightkeeperRequired) { lA++; if (s === 'complete') lD++; }
  }
  const all = S.data.tasks.length;
  const kpi = (r, v, label) => `<div class="kpi">${r}<div><b>${v}</b><span>${label}</span></div></div>`;
  setHtml($('#kpis'), [
    kpi(ring((p.effectiveLevel || 1) / 79, 'var(--violet)'), p.effectiveLevel, p.manualLevel ? 'уровень (вручную)' : 'уровень (оценка)'),
    kpi(ring(cnt.complete / all), `${cnt.complete}/${all}`, 'квестов выполнено'),
    kpi(ring(cnt.active / Math.max(1, cnt.active + cnt.available)), cnt.active, 'активных сейчас'),
    kpi(ring(cnt.available / all, 'var(--violet)'), cnt.available, 'можно взять'),
    kpi(ring(kA ? kD / kA : 0, 'var(--amber)'), `${kD}/${kA}`, 'для Каппы'),
    kpi(ring(lA ? lD / lA : 0, '#93C5FD'), `${lD}/${lA}`, 'для Смотрителя'),
  ].join(''));
  $('#pProfile').textContent = p.id === 'default' ? 'ещё не найден в логах' : '…' + p.id.slice(-8);
  $('#pMode').textContent = `${p.mode === 'pve' ? 'PvE' : p.mode ? 'PvP' : '—'} · ${p.faction ? p.faction.toUpperCase() : 'фракция не определена'}`;
  if (document.activeElement !== $('#pLevel')) $('#pLevel').value = p.manualLevel || '';
  $('#pEstLevel').textContent = p.estimatedLevel;
  const dt = (ts) => new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('#pWipe').textContent = p.wipeIgnored && !p.manualWipe ? 'всех логов (вайп не учитывается)' : p.wipeTs ? `${dt(p.wipeTs)} · ${p.manualWipe && p.manualWipe >= p.detectedWipe ? 'вручную' : 'найден в логах'}` : 'начала логов';
  $('#btnWipeIgnore').classList.toggle('hidden', !(p.detectedWipe && !p.wipeIgnored && !(p.manualWipe >= p.detectedWipe)));
  $('#btnWipeAuto').classList.toggle('hidden', !p.manualWipe && !p.wipeIgnored);
  $('#pLogCount').textContent = p.logEventTotal > p.logEventCount ? `${p.logEventCount} (до вайпа ещё ${p.logEventTotal - p.logEventCount})` : p.logEventCount;
  $('#pUnresolved').textContent = S.state.unresolvedCount;
  $('#pData').textContent = S.state.dataInfo ? `${S.state.dataInfo.mode === 'pve' ? 'PvE' : 'PvP'} · ${dt(S.state.dataInfo.fetchedAt)}` : '—';
  setHtml($('#pTraders'), S.data.traders.map((t) => {
    let a = 0, d = 0;
    for (const x of S.data.tasks) if (x.trader === t.id) { a++; if (statusOf(x.id) === 'complete') d++; }
    return a ? `<div class="trow" data-trader="${t.id}" title="Квесты торговца"><img src="${esc(t.imageLink)}" alt="" loading="lazy"><span>${esc(t.name)}</span><div class="bar"><i style="width:${Math.round((d / a) * 100)}%"></i></div><em>${d}/${a}</em></div>` : '';
  }).join(''));
  setHtml($('#journal'), S.events.length ? S.events.map((e) => `<div class="jrow"><time>${new Date(e.ts).toLocaleString('ru-RU')}</time><span>${esc(e.text)}</span></div>`).join('')
    : '<div class="empty">Пока пусто. Здесь появятся загрузки карт, рейды и квесты из логов.</div>');
}
$('#pTraders').addEventListener('click', (e) => { const t = e.target.closest('[data-trader]'); if (t) { ui.qTrader = t.dataset.trader; ui.qStatus = 'all'; ui.qSel = null; saveUi(); setView('dossier'); } });
$('#pLevel').addEventListener('change', (e) => api.setLevel(Number(e.target.value) || 0));
$('#pLevelAuto').addEventListener('click', () => api.setLevel(0));
$('#btnWipeNow').addEventListener('click', async () => { await api.setWipe(Date.now()); toast('Прогресс считается с этого момента. Взятые раньше квесты отметь «Уже взят».'); });
$('#btnWipeAuto').addEventListener('click', async () => { await api.setWipe(0); await api.setWipeIgnore(false); toast('Вайп снова определяется автоматически'); });
$('#btnWipeIgnore').addEventListener('click', async () => { await api.setWipeIgnore(true); toast('Учитываются все логи — найденный вайп проигнорирован'); });
$('#btnRescan').addEventListener('click', async () => { const b = $('#btnRescan'); b.disabled = true; b.textContent = 'Сканирую…'; await api.rescan(); b.disabled = false; b.textContent = 'Пересканировать логи'; });
$('#btnRefresh').addEventListener('click', () => { toast('Обновляю базу tarkov.dev…'); api.refreshData(); });
$('#btnReset').addEventListener('click', () => api.resetProfile());

// ---------------------------------------------------------------- НАСТРОЙКИ
const HK = [['hkToggle', 'toggle'], ['hkClick', 'clickThrough'], ['hkMap', 'map'], ['hkQuests', 'quests'], ['hkCompact', 'compact']];
function openSettings() { $('#settings').classList.remove('hidden'); renderSettings(); }
$('#settingsClose').addEventListener('click', () => $('#settings').classList.add('hidden'));
$('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('#settings').classList.add('hidden'); });
function renderSettings() {
  const s = S.state.settings;
  $('#sLogsDir').textContent = S.state.live.logsDir || 'не найдена';
  $('#sLogsDir').classList.toggle('bad', !S.state.live.logsOk);
  $('#sLogsStatus').textContent = S.state.live.logsStatus || '';
  $('#sShots').checked = !!s.screenshotsEnabled;
  $('#sShotsDir').textContent = s.screenshotsDir || 'Документы\\Escape from Tarkov\\Screenshots (по умолчанию)';
  $('#sLang').value = s.lang; $('#sMode').value = s.gameMode;
  if (document.activeElement !== $('#sOpacity')) $('#sOpacity').value = s.opacity;
  if (document.activeElement !== $('#sScale')) $('#sScale').value = s.uiScale || 1;
  $('#sOpacityVal').textContent = Math.round(s.opacity * 100) + '%';
  $('#sScaleVal').textContent = Math.round((s.uiScale || 1) * 100) + '%';
  $('#sTop').checked = !!s.alwaysOnTop; $('#sNotify').checked = !!s.notify; $('#sLite').checked = s.lite !== false;
  for (const [id, k] of HK) if (document.activeElement !== $('#' + id)) $('#' + id).value = s.hotkeys[k] || '';
}
$('#sLogsBrowse').addEventListener('click', async () => { const p = await api.browseFolder('Папка Logs игры'); if (p) api.setSettings({ logsDir: p }); });
$('#sLogsAuto').addEventListener('click', async () => { const d = await api.detectLogs(); toast(d ? 'Папка логов найдена' : 'Не нашёл автоматически — выбери папку вручную'); });
$('#sShots').addEventListener('change', (e) => api.setSettings({ screenshotsEnabled: e.target.checked }));
$('#sShotsBrowse').addEventListener('click', async () => { const p = await api.browseFolder('Папка скриншотов'); if (p) api.setSettings({ screenshotsDir: p }); });
$('#sLang').addEventListener('change', (e) => { toast('Загружаю данные…'); api.setSettings({ lang: e.target.value }); });
$('#sMode').addEventListener('change', (e) => { toast('Загружаю данные…'); api.setSettings({ gameMode: e.target.value }); });
const saveOpacity = debounce((v) => api.setSettings({ opacity: v }), 60);
$('#sOpacity').addEventListener('input', (e) => { $('#sOpacityVal').textContent = Math.round(e.target.value * 100) + '%'; saveOpacity(Number(e.target.value)); });
$('#sScale').addEventListener('input', (e) => { $('#sScaleVal').textContent = Math.round(e.target.value * 100) + '%'; });
$('#sScale').addEventListener('change', (e) => api.setSettings({ uiScale: Number(e.target.value) }));
$('#sTop').addEventListener('change', (e) => api.setSettings({ alwaysOnTop: e.target.checked }));
$('#sNotify').addEventListener('change', (e) => api.setSettings({ notify: e.target.checked }));
$('#sLite').addEventListener('change', async (e) => { await api.setSettings({ lite: e.target.checked }); $('#sLiteRestart').classList.remove('hidden'); });
$('#sRelaunch').addEventListener('click', () => api.relaunch());
$$('.hk').forEach((inp) => inp.addEventListener('keydown', (e) => {
  e.preventDefault();
  if (e.key === 'Escape') { inp.blur(); return; }
  if (e.key === 'Backspace' || e.key === 'Delete') { inp.value = ''; return; }
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl'); if (e.altKey) parts.push('Alt'); if (e.shiftKey) parts.push('Shift');
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  if (key === ' ') key = 'Space';
  if (!parts.length && !/^F\d+$/.test(key)) { toast('Добавь Ctrl, Alt или Shift — одиночная клавиша мешала бы в игре'); return; }
  parts.push(key);
  inp.value = parts.join('+');
}));
$('#sHkSave').addEventListener('click', async () => {
  const r = await api.setSettings({ hotkeys: Object.fromEntries(HK.map(([id, k]) => [k, $('#' + id).value])) });
  toast(r.failed?.length ? 'Не удалось назначить: ' + r.failed.join(', ') + ' — занято другой программой?' : 'Горячие клавиши применены');
});
$('#sHelp').addEventListener('click', () => { $('#settings').classList.add('hidden'); showOnboarding(); });

// ---------------------------------------------------------------- ПОИСК ПО ВСЕМУ (Ctrl+K)
let palItems = [], palSel = 0;
function openPalette() { $('#palette').classList.remove('hidden'); $('#palInput').value = ''; palSearch(''); setTimeout(() => $('#palInput').focus(), 10); }
function closePalette() { $('#palette').classList.add('hidden'); }
function palSearch(q) {
  q = q.trim().toLowerCase();
  const out = [];
  if (S.data) {
    if (q) {
      for (const t of S.data.tasks) if (t.name.toLowerCase().includes(q)) out.push({ k: 'квест', img: trader(t.trader).imageLink, name: t.name, sub: `${trader(t.trader).name} · ${ST_LABEL[statusOf(t.id)]}`, go: () => { ui.qSel = t.id; ui.qStatus = 'all'; ui.qSearch = ''; saveUi(); setView('dossier'); } });
      for (const m of selectableMaps()) if (m.name.toLowerCase().includes(q)) out.push({ k: 'карта', name: m.name, sub: 'открыть в «Рейде»', go: () => { ui.raidMap = m.id; ui.follow = false; saveUi(); setView('raid'); } });
      for (const s of S.data.hideout) if (s.name.toLowerCase().includes(q)) out.push({ k: 'убежище', img: s.imageLink, name: s.name, sub: `построено ${built(s.id)} из ${maxLevel(s)}`, go: () => { ui.station = s.id; saveUi(); setView('base'); } });
      if (!itemIndex) itemIndex = Object.entries(S.data.items).map(([id, it]) => [id, `${it.n} ${it.s}`.toLowerCase(), it]);
      for (const [, hay, it] of itemIndex) { if (out.length > 60) break; if (hay.includes(q)) out.push({ k: 'предмет', img: it.i, name: it.n, sub: it.p ? `барахолка ${fmt(it.p)} ₽` : '', go: () => { ui.iSearch = it.n; ui.iQuest = 'open'; saveUi(); setView('stash'); } }); }
    } else {
      out.push(...[['Рейд', 'raid'], ['Досье квестов', 'dossier'], ['Убежище', 'base'], ['Склад', 'stash'], ['Сводка', 'summary']].map(([n, v]) => ({ k: 'раздел', name: n, sub: '', go: () => setView(v) })));
      out.push({ k: 'действие', name: 'Настройки', sub: '', go: openSettings });
      out.push({ k: 'действие', name: 'Компактная панель поверх игры', sub: '', go: () => api.win('compact') });
    }
  }
  palItems = out.slice(0, 60); palSel = 0;
  drawPal();
}
function drawPal() {
  $('#palList').innerHTML = palItems.length ? palItems.map((x, i) => `<div class="prow${i === palSel ? ' on' : ''}" data-i="${i}"><span class="pk">${x.k}</span>${x.img ? `<img src="${esc(x.img)}" alt="" loading="lazy">` : ''}<span class="pn">${esc(x.name)}</span><small>${esc(x.sub)}</small></div>`).join('')
    : '<div class="empty">Ничего не найдено</div>';
  $('#palList .prow.on')?.scrollIntoView({ block: 'nearest' });
}
$('#palInput').addEventListener('input', debounce((e) => palSearch(e.target.value), 80));
$('#palInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); drawPal(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); drawPal(); }
  if (e.key === 'Enter' && palItems[palSel]) { const go = palItems[palSel].go; closePalette(); go(); }
});
$('#palList').addEventListener('click', (e) => { const r = e.target.closest('[data-i]'); if (r) { const go = palItems[Number(r.dataset.i)].go; closePalette(); go(); } });
$('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') closePalette(); });

// ---------------------------------------------------------------- первый запуск
function showOnboarding() {
  const s = S.state;
  const hk = s?.settings?.hotkeys || {};
  $('#obLogs').innerHTML = s?.live?.logsOk ? `<b class="ok">✓ Логи игры найдены</b><div class="path">${esc(s.live.logsDir)}</div>`
    : '<b class="err">✗ Папка логов не найдена</b><span>Укажи её в настройках: обычно <code>…\\Escape from Tarkov\\build\\Logs</code></span>';
  $('#obKeys').innerHTML = [['toggle', 'показать / скрыть'], ['clickThrough', 'клики сквозь окно'], ['compact', 'компактная панель'], ['map', 'карта']]
    .map(([k, l]) => `<div><kbd>${esc(hk[k] || '—')}</kbd>${l}</div>`).join('');
  $('#onboard').classList.remove('hidden');
}
function closeOnboarding() { $('#onboard').classList.add('hidden'); try { localStorage.setItem('onboarded', '3'); } catch {} }
$('#obClose').addEventListener('click', closeOnboarding);
$('#obLevel').addEventListener('click', () => { closeOnboarding(); setView('summary'); setTimeout(() => $('#pLevel').focus(), 50); });
$('#obBase').addEventListener('click', () => { closeOnboarding(); setView('base'); });
$('#obSettings').addEventListener('click', () => { closeOnboarding(); openSettings(); });

// ---------------------------------------------------------------- связь с main
function setCompact(on) {
  ui.compact = on;
  document.body.classList.toggle('compact', on);
  if (!on) loadedMapId = null;
  render();
  setTimeout(() => tmap.map?.invalidateSize(), 60);
}
api.onState((s) => {
  const prev = S.state?.live?.map;
  S.state = s;
  if (ui.follow && s.live.map && s.live.map !== prev) { const m = mapByLogId(s.live.map); if (m && defFor(m)) ui.raidMap = m.id; }
  render();
});
api.onData((d) => {
  S.data = d; itemIndex = null; indexData();
  pointsSig = locksSig = '';
  const m = idx.map.get(loadedMapId);
  if (m && tmap.def && defFor(m)?.key === tmap.def.key) { tmap.mapData = m; tmap.drawStatic(); } else loadedMapId = null;
  render();
});
api.onDataError((msg) => { if (S.data) return; $('#boot').classList.remove('hidden'); $('#bootText').innerHTML = `<b>Не удалось загрузить базу tarkov.dev</b>${esc(msg)}<br>Проверь интернет — приложение повторит попытку.`; });
api.onEvent((e) => { S.events.unshift(e); if (S.events.length > 200) S.events.length = 200; if (ui.view === 'summary') render(); });
api.onToast((t) => toast(t));
api.onMapChanged((logId) => { if (!ui.follow) return; const m = mapByLogId(logId); if (m && defFor(m)) { ui.raidMap = m.id; render(); } });
api.onPosition((p) => { const m = mapByLogId(p.map); if (!p.map || (m && sameMapIds(ui.raidMap).has(m.id))) { tmap.setPlayer(p); tmap.focusPoint(p); } });
api.onShowTab((t) => setView({ map: 'raid', quests: 'dossier', progress: 'summary', hideout: 'base', items: 'stash', events: 'summary' }[t] || t));
api.onClickThrough(() => {});
api.onCompact((on) => setCompact(on));
// отладочные снимки (только при запуске из исходников)
api.onDebugSide((x) => {
  if (x === 'onboard') { showOnboarding(); return; }
  closeOnboarding();
  if (x === 'palette') openPalette();
  if (x?.startsWith('go:')) { const mm = mapByLogId(x.slice(3)); if (mm) { ui.raidMap = mm.id; ui.follow = false; render(); } }
  const nearCenter = (list) => { const c = tmap.map.getCenter(); return list.sort((p, q) => p.getLatLng().distanceTo(c) - q.getLatLng().distanceTo(c))[0]; };
  if (x === 'exit') nearCenter(tmap.groups.pmc.getLayers().filter((l) => /<img/.test(l.getTooltip()?._content?.(l) || '')))?.openTooltip();
  if (x === 'qtip') nearCenter([...tmap.taskMarkers.entries()].filter(([id]) => shots(id).length).map(([, l]) => l[0]))?.openTooltip();
  if (x?.startsWith('bldg') && tmap.style !== 'svg') { localStorage.setItem('mapStyle', 'svg'); tmap.setStyle('svg'); }
  if (x?.startsWith('bldg')) setTimeout(() => {
    const b =[...tmap.buildings].sort((a, c) => c.levels.length - a.levels.length || (c.rect.w * c.rect.h) - (a.rect.w * a.rect.h))[0];
    if (b) {
      const lv = b.levels[Math.min(b.levels.length - 1, Number(x.slice(4)) || 1)];
      tmap.setBuildingFloor(b, lv.id);
      const r = b.hot.getBoundingClientRect();
      tmap.map.panTo(tmap.map.containerPointToLatLng([r.left + r.width / 2 - tmap.el.getBoundingClientRect().left, r.top + r.height / 2 - tmap.el.getBoundingClientRect().top]), { animate: false });
      setTimeout(() => { const r2 = b.hot.getBoundingClientRect(); tmap.openFloorMenu(b, { clientX: r2.left + r2.width / 2, clientY: r2.top + r2.height / 2 }); }, 300);
    }
    console.log('buildings', tmap.buildings.length, 'max', Math.max(0, ...tmap.buildings.map((y) => y.levels.length)));
  }, tmap.buildings.length ? 0 : 2500);
  if (x?.startsWith('zoom')) { const z = Number(x.slice(4)) || 2; const mk = [...tmap.questMarkers.values()][0]?.[0]; tmap.map?.setView(mk ? mk.getLatLng() : tmap.map.getCenter(), tmap.map.getZoom() + z, { animate: false }); }
  if (x?.startsWith('lb:')) { const t = S.data.tasks.find((y) => y.name === x.slice(3)); if (t) api.getWiki(t.id).then((d) => { S.wiki.set(t.id, d); openLightbox(t.id); }); }
  if (x?.startsWith('sel:')) { const t = S.data.tasks.find((y) => y.name === x.slice(4)); if (t) { ui.qSel = t.id; ui.qStatus = 'all'; render(); } }
});

(async () => {
  S.mapDefs = await api.getMapDefs();
  const init = await api.init();
  S.state = init.state;
  S.events = init.events || [];
  if (init.data) { S.data = init.data; indexData(); }
  else if (S.state.dataError) $('#bootText').innerHTML = `<b>Не удалось загрузить базу tarkov.dev</b>${esc(S.state.dataError)}<br>Проверь интернет — приложение повторит попытку.`;
  setCompact(!!S.state.settings.compact);
  setView(ui.view);
  let ob = null;
  try { ob = localStorage.getItem('onboarded'); } catch {}
  if (ob !== '3') setTimeout(showOnboarding, 400);
})();
