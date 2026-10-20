'use strict';
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, dialog, shell, nativeImage, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { Settings } = require('./settings');
const { ProgressStore, computeStatuses } = require('./progress');
const { LogWatcher, detectLogsDir, listSessions, parseSession } = require('./logwatcher');
const { ScreenshotWatcher, defaultScreenshotsDir } = require('./screenshots');
const data = require('./tarkovdata');
const { Wiki } = require('./wiki');

// отладка (только при запуске из исходников): отдельная папка данных и снимки окна
const DEV = !app.isPackaged;
if (DEV && process.env.TH_USERDATA) app.setPath('userData', process.env.TH_USERDATA);
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const userDir = app.getPath('userData');
const settings = new Settings(path.join(userDir, 'settings.json'));

// Экономный режим (по умолчанию): без видеокарты и с сетевой службой внутри основного процесса.
// Замер: 3 процесса вместо 4, личная память ~170 МБ вместо ~270 МБ, видеокарта игре не мешает.
if (settings.get('lite') !== false) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');
  app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,MediaSessionService,HardwareMediaKeyHandling,Translate');
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');
}
const progress = new ProgressStore(path.join(userDir, 'progress.json'));
const watcher = new LogWatcher();
const shots = new ScreenshotWatcher();
const wiki = new Wiki(path.join(userDir, 'th-cache'));

let win = null;
let tray = null;
let clickThrough = false;
let quitting = false;

// Состояние, которое видит интерфейс
const live = {
  logsDir: null,
  logsOk: false,
  logsStatus: 'Поиск папки логов…',
  mode: null,        // pve | regular — из «Session mode» в логах
  map: null,         // id карты (как в логах игры)
  raidState: 'idle', // offline | idle | matching | loading | inraid
  side: null,        // pmc | scav — за кого текущий/последний рейд
  position: null,    // { map, x, y, z, ts } из имени скриншота
  events: [],        // последние события для вкладки «Лог»
};
let gameData = null; // { tasks, maps, traders, hideout, fetchedAt, lang, mode }
let messageIndex = {};
let lastDataError = null;

const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const HEX24 = /^[0-9a-f]{24}$/;
const isId = (v) => typeof v === 'string' && HEX24.test(v);
const LANGS = new Set(['ru', 'en']);
const MODES = new Set(['auto', 'pve', 'regular']);
// ссылки открываются только на известные сайты
const EXT_HOSTS = /^(?:[\w-]+\.)*(?:tarkov\.dev|escapefromtarkov\.fandom\.com|escapefromtarkov\.com|github\.com)$/i;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// системное уведомление Windows — только если окно сейчас не видно (скрыто, свёрнуто или «сквозь окно»)
function notifyOs(title, body) {
  if (!settings.get('notify') || !Notification.isSupported()) return;
  if (win && win.isVisible() && !win.isMinimized() && !clickThrough) return;
  new Notification({ title: 'Tarkov Helper — ' + title, body, icon: fs.existsSync(ICON) ? ICON : undefined, silent: true }).show();
}

function pushEvent(text, ts = Date.now()) {
  live.events.unshift({ ts, text });
  if (live.events.length > 200) live.events.length = 200;
  send('event', { ts, text });
}

function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && EXT_HOSTS.test(u.hostname)) shell.openExternal(u.toString());
  } catch { /* не ссылка */ }
}

function dataMode() {
  const m = settings.get('gameMode');
  if (m === 'pve' || m === 'regular') return m;
  return live.mode || progress.active.mode || 'regular';
}

// В уведомлении о квесте templateId = "<id квеста> description|successMessageText|failMessageText"
function buildMessageIndex() {
  messageIndex = {};
  for (const t of gameData?.tasks || []) messageIndex[t.id] = t.id;
}

function snapshot() {
  const p = progress.active;
  const tasks = gameData?.tasks || [];
  const r = computeStatuses(p, tasks, messageIndex);
  return {
    settings: settings.data,
    live: { ...live, events: undefined },
    profile: {
      id: progress.data.activeProfile, mode: p.mode, level: p.level, effectiveLevel: r.level, estimatedLevel: r.estimatedLevel, manualLevel: r.manualLevel,
      faction: r.faction, wipeTs: r.wipeTs, detectedWipe: r.detectedWipe, manualWipe: p.wipeTs || 0, wipeIgnored: !!p.wipeIgnore,
      objectives: r.objectives, counters: r.counters, tracked: r.tracked, hideout: p.hideout, owned: p.owned,
      logEventCount: p.logEvents.filter((e) => e.ts >= r.wipeTs).length, logEventTotal: p.logEvents.length,
    },
    status: r.status,
    unresolvedCount: r.unresolved.length,
    dataInfo: gameData ? { fetchedAt: gameData.fetchedAt, lang: gameData.lang, mode: gameData.mode, tasks: tasks.length } : null,
    dataError: gameData ? null : lastDataError,
    clickThrough,
  };
}

let stateTimer = null;
let stateDirty = false; // окно скрыто — снимок не считаем, отправим при показе
function stateChanged() {
  if (win && !win.isDestroyed() && (!win.isVisible() || win.isMinimized())) { stateDirty = true; return; }
  // группируем частые изменения (например, при пересканировании)
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; stateDirty = false; send('state', snapshot()); }, 120);
}
function flushState() { if (stateDirty) { stateDirty = false; stateChanged(); } }

let saveTimer = null;
function saveProgressSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; try { progress.save(); } catch (e) { console.error(e); } }, 800);
}

// ---------- События логов ----------
let pendingMode = null;
function taskName(messageId) {
  const id = messageIndex[messageId];
  const t = id && gameData?.tasks.find((x) => x.id === id);
  return t ? t.name : null;
}
function mapName(id) {
  if (!id) return '?';
  const m = data.findMap(gameData, id);
  return m ? m.name : id;
}

function wakeFromOffline() {
  if (live.raidState === 'offline') live.raidState = 'idle';
}

function applyEvent(ev, { live: isLive }) {
  switch (ev.type) {
    case 'mode':
      pendingMode = ev.mode;
      if (isLive) { live.mode = ev.mode; pushEvent(`Режим игры: ${ev.mode === 'pve' ? 'PvE' : 'PvP'}`, ev.ts); }
      break;
    case 'profile': {
      const changed = progress.data.activeProfile !== ev.profileId;
      progress.setActiveProfile(ev.profileId, pendingMode);
      if (isLive && changed) pushEvent(`Профиль: …${ev.profileId.slice(-6)}`, ev.ts);
      // профиль выбирается заново при возврате в меню — значит, рейд закончился
      if (isLive && (live.raidState === 'inraid' || live.raidState === 'loading')) {
        live.raidState = 'idle';
        pushEvent('Возврат в меню', ev.ts);
      }
      break;
    }
    case 'task': {
      const added = progress.addLogEvent(progress.data.activeProfile, ev);
      if (added && isLive) {
        const n = taskName(ev.messageId) || 'неизвестный квест (ежедневный?)';
        const verb = ev.kind === 'started' ? 'Квест взят' : ev.kind === 'finished' ? 'Квест выполнен' : 'Квест провален';
        pushEvent(`${verb}: ${n}`, ev.ts);
        send('toast', `${verb}: ${n}`);
        notifyOs(verb, n);
      }
      break;
    }
    case 'matchingStarted':
      if (isLive) live.raidState = 'matching';
      break;
    case 'mapLoading':
      if (isLive && ev.location) {
        live.map = ev.location; live.raidState = 'loading';
        pushEvent(`Загрузка карты: ${mapName(ev.location)}`, ev.ts);
        send('mapChanged', ev.location);
      }
      break;
    case 'raidCreated':
      if (isLive && ev.location) {
        const was = live.map;
        live.map = ev.location; live.raidState = 'loading';
        if (was !== ev.location) { pushEvent(`Карта рейда: ${mapName(ev.location)}`, ev.ts); send('mapChanged', ev.location); }
      }
      break;
    case 'raidStarted':
      if (isLive) { live.raidState = 'inraid'; pushEvent(`Рейд начался: ${mapName(live.map)} · ${live.side === 'scav' ? 'за Дикого' : 'за ЧВК'}`, ev.ts); }
      break;
    case 'raidEnded':
      if (isLive) { live.raidState = 'idle'; pushEvent(`Рейд окончен: ${mapName(ev.location || live.map)}`, ev.ts); }
      break;
    case 'matchingCancelled':
      if (isLive) { live.raidState = 'idle'; pushEvent('Поиск рейда отменён', ev.ts); }
      break;
  }
}

watcher.on('status', (s) => {
  live.logsDir = s.logsDir;
  live.logsOk = !!s.ok;
  live.logsStatus = s.ok ? s.message : (s.logsDir ? `Папка не найдена: ${s.logsDir}` : 'Папка логов не найдена') + '. Укажи её в настройках.';
  stateChanged();
});
watcher.on('session', ({ isNew }) => {
  if (isNew) { wakeFromOffline(); pushEvent('Игра запущена, новая сессия логов'); }
});
watcher.on('activity', (active) => {
  if (!active && live.raidState !== 'inraid') { live.raidState = 'offline'; stateChanged(); }
  if (active) { wakeFromOffline(); stateChanged(); }
});
// За кого рейд: в группе — из настроек рейда; иначе по отсчёту перед боем (у ЧВК ~10 с, у Дикого нет)
let startingT = null;
let groupSide = null;
function trackSide(ev) {
  if (ev.type === 'matchingStarted') { startingT = null; }
  if (ev.type === 'mapLoading' && ev.side) groupSide = ev.side;
  if (ev.type === 'raidStarting') startingT = ev.t;
  if (ev.type === 'raidStarted') {
    live.side = groupSide || (startingT != null && ev.t - startingT > 3 ? 'pmc' : 'scav');
    startingT = null; groupSide = null;
  }
  if (ev.type === 'raidEnded') groupSide = null;
}

watcher.on('event', (ev) => {
  trackSide(ev);
  if (scanning && ev.type === 'task') { queuedLive.push(ev); return; }
  if (ev.replay) {
    // при запуске приложения: молча восстанавливаем режим, карту и состояние рейда
    applyEvent(ev, { live: false });
    if (ev.type === 'mode') live.mode = ev.mode;
    if ((ev.type === 'mapLoading' || ev.type === 'raidCreated') && ev.location) { live.map = ev.location; live.raidState = 'loading'; }
    if (ev.type === 'matchingStarted') live.raidState = 'matching';
    if (ev.type === 'raidStarted') live.raidState = 'inraid';
    if (ev.type === 'raidEnded' || ev.type === 'matchingCancelled') live.raidState = 'idle';
    if (ev.type === 'profile' && (live.raidState === 'inraid' || live.raidState === 'loading')) live.raidState = 'idle';
  } else {
    wakeFromOffline();
    applyEvent(ev, { live: true });
  }
  if (ev.type === 'mode' && gameData && settings.get('gameMode') === 'auto' && gameData.mode !== dataMode()) loadData({});
  saveProgressSoon();
  stateChanged();
});

// Полное сканирование старых сессий (восстановление прогресса). Только одно за раз;
// профиль отслеживается локально, чтобы ручные отметки во время скана не уехали в чужой профиль.
let scanning = false;
let scanChain = Promise.resolve();
const queuedLive = [];
function scanAllLogs(force) {
  scanChain = scanChain.then(() => doScan(force)).catch((e) => { console.error(e); return { sessions: 0 }; });
  return scanChain;
}
async function doScan(force) {
  const dir = live.logsOk ? live.logsDir : null;
  if (!dir) return { sessions: 0 };
  scanning = true;
  try {
    const sessions = listSessions(dir);
    const done = new Set(force ? [] : progress.data.scannedSessions);
    const current = sessions[sessions.length - 1];
    let n = 0;
    let lastProfile = null, lastMode = null;
    for (const s of sessions) {
      if (done.has(s) && s !== current) continue;
      let prof = null, mode = null;
      for (const ev of parseSession(path.join(dir, s))) {
        if (ev.type === 'mode') mode = ev.mode;
        else if (ev.type === 'profile') { prof = ev.profileId; const p = progress.profile(prof); if (mode) p.mode = mode; lastProfile = prof; lastMode = mode; }
        else if (ev.type === 'task' && prof) progress.addLogEvent(prof, ev);
      }
      if (s !== current) done.add(s);
      n++;
      await new Promise((r) => setImmediate(r)); // между сессиями — дать окну и IPC подышать
    }
    progress.data.scannedSessions = [...done];
    if (lastProfile) progress.setActiveProfile(lastProfile, lastMode);
    progress.save();
    return { sessions: n };
  } finally {
    scanning = false;
    // события квестов, пришедшие во время скана, применяем после него
    for (const ev of queuedLive.splice(0)) applyEvent(ev, { live: !ev.replay });
    stateChanged();
  }
}

// ---------- Данные tarkov.dev ----------
// Одна загрузка на язык+режим; результат, не совпадающий с текущими настройками, отбрасывается.
const inflight = new Map();
async function loadData({ force = false, notify = false } = {}) {
  const lang = settings.get('lang');
  const mode = dataMode();
  const key = `${mode}-${lang}`;
  // уже загружено и свежо — без повторного разбора кэша (~20 МБ JSON) и повторной отправки в окно
  if (!force && gameData && gameData.lang === lang && gameData.mode === mode && !data.isStale(gameData)) return;
  if (inflight.has(key)) return inflight.get(key);
  const cached = data.loadCache(userDir, lang, mode);
  if (cached && (!gameData || gameData.lang !== lang || gameData.mode !== mode || gameData.fetchedAt < cached.fetchedAt)) {
    setGameData(cached);
  }
  if (cached && !force && !data.isStale(cached)) return;
  const job = (async () => {
    try {
      const fresh = await data.fetchAll(lang, mode);
      data.saveCache(userDir, fresh);
      if (settings.get('lang') === lang && dataMode() === mode) setGameData(fresh);
      lastDataError = null;
      if (notify) send('toast', 'База tarkov.dev обновлена');
    } catch (e) {
      console.error(e);
      lastDataError = e.message;
      if (notify || !gameData) send('toast', 'Не удалось загрузить базу tarkov.dev: ' + e.message);
      if (!gameData) send('dataError', e.message);
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, job);
  return job;
}
function setGameData(d) {
  gameData = d;
  buildMessageIndex();
  send('data', gameData);
  stateChanged();
}

// ---------- Окно ----------
const boundsKey = () => (settings.get('compact') ? 'compactWindow' : 'window');

function createWindow() {
  const w = settings.get(boundsKey());
  const opts = {
    width: w.width, height: w.height, minWidth: 360, minHeight: 420,
    frame: false, show: false, backgroundColor: '#0A0C10',
    alwaysOnTop: settings.get('alwaysOnTop'), skipTaskbar: false,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    title: 'Tarkov Helper',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: true },
  };
  if (w.x != null && w.y != null && screen.getAllDisplays().some((d) => {
    const b = d.workArea; return w.x >= b.x - 50 && w.y >= b.y - 50 && w.x < b.x + b.width && w.y < b.y + b.height;
  })) { opts.x = w.x; opts.y = w.y; }

  win = new BrowserWindow(opts);
  if (settings.get('alwaysOnTop')) win.setAlwaysOnTop(true, 'screen-saver');
  win.setOpacity(settings.get('opacity'));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(settings.get('uiScale') || 1));
  win.once('ready-to-show', () => win.show());

  let boundsTimer = null;
  const saveBounds = () => {
    if (!win || win.isMinimized() || win.isMaximized() || applyingCompact) return;
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      const b = win.getBounds();
      settings.set({ [boundsKey()]: { width: b.width, height: b.height, x: b.x, y: b.y } });
    }, 400);
  };
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);
  win.on('show', flushState);
  win.on('restore', flushState);
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });

  // ссылки (вики и т.п.) открываются в обычном браузере
  win.webContents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// Компактный режим: узкая панель с заданиями поверх игры (как оверлей Visor)
let applyingCompact = false;
function toggleCompact() {
  if (!win) return;
  const on = !settings.get('compact');
  if (win.isMaximized()) win.unmaximize();
  settings.set({ compact: on });
  const w = settings.get(boundsKey());
  applyingCompact = true;
  const cur = win.getBounds();
  win.setBounds({ width: w.width, height: w.height, x: w.x ?? cur.x, y: w.y ?? cur.y });
  setTimeout(() => { applyingCompact = false; }, 300);
  if (on && settings.get('alwaysOnTop')) win.setAlwaysOnTop(true, 'screen-saver');
  if (!win.isVisible()) win.show();
  send('compact', on);
  stateChanged();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else { win.show(); if (settings.get('alwaysOnTop')) win.setAlwaysOnTop(true, 'screen-saver'); }
}

function setClickThrough(on) {
  clickThrough = on;
  if (!win) return;
  win.setIgnoreMouseEvents(on, { forward: true });
  send('clickThrough', on);
  updateTrayMenu();
  stateChanged();
}

function showTab(tab) {
  if (!win) return;
  if (!win.isVisible()) win.show();
  send('showTab', tab);
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = settings.get('hotkeys');
  const failed = [];
  const reg = (acc, fn) => {
    if (!acc) return;
    try { if (!globalShortcut.register(acc, fn)) failed.push(acc); } catch { failed.push(acc); }
  };
  reg(hk.toggle, toggleWindow);
  reg(hk.clickThrough, () => setClickThrough(!clickThrough));
  reg(hk.map, () => showTab('map'));
  reg(hk.quests, () => showTab('quests'));
  reg(hk.compact, toggleCompact);
  return failed;
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Показать / скрыть', click: toggleWindow },
    { label: 'Компактный режим', click: toggleCompact },
    { label: 'Сквозь окно', type: 'checkbox', checked: clickThrough, click: (i) => setClickThrough(i.checked) },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const img = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('Tarkov Helper');
  tray.on('click', toggleWindow);
  updateTrayMenu();
}

// ---------- Скриншоты (координаты в имени файла) ----------
shots.on('position', (pos) => {
  live.position = { ...pos, map: live.map };
  pushEvent(`Позиция по скриншоту: ${pos.x.toFixed(0)}, ${pos.z.toFixed(0)}`, pos.ts);
  send('position', live.position);
});
function startScreenshots() {
  shots.stop();
  if (!settings.get('screenshotsEnabled')) return;
  shots.start(settings.get('screenshotsDir') || defaultScreenshotsDir(app.getPath('documents')));
}

async function startLogs() {
  const dir = settings.get('logsDir') || await detectLogsDir();
  watcher.start(dir);
  if (live.logsOk) {
    const first = !progress.data.scannedSessions.length;
    if (first) pushEvent('Первичное сканирование старых логов…');
    const r = await scanAllLogs(false);
    if (first) pushEvent(`Просканировано сессий логов: ${r.sessions}`);
  }
}

// ---------- Проверка данных из интерфейса ----------
const approvedDirs = new Set(); // папки, выбранные пользователем в системном диалоге
function cleanSettings(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
  if ('lang' in patch && LANGS.has(patch.lang)) out.lang = patch.lang;
  if ('gameMode' in patch && MODES.has(patch.gameMode)) out.gameMode = patch.gameMode;
  if ('opacity' in patch && num(patch.opacity, 0.3, 1) !== undefined) out.opacity = num(patch.opacity, 0.3, 1);
  if ('uiScale' in patch && num(patch.uiScale, 0.7, 1.6) !== undefined) out.uiScale = num(patch.uiScale, 0.7, 1.6);
  for (const k of ['alwaysOnTop', 'screenshotsEnabled', 'notify', 'lite']) if (k in patch) out[k] = !!patch[k];
  for (const k of ['logsDir', 'screenshotsDir']) {
    if (!(k in patch)) continue;
    if (patch[k] === null || approvedDirs.has(patch[k])) out[k] = patch[k];
  }
  if (patch.hotkeys && typeof patch.hotkeys === 'object') {
    out.hotkeys = {};
    for (const k of ['toggle', 'clickThrough', 'map', 'quests', 'compact']) {
      const v = patch.hotkeys[k];
      // акселератор Electron: буквы, цифры, F1…F24, Up/Down, Plus, знаки препинания — любой печатный ASCII без пробелов
      if (typeof v === 'string' && v.length < 40 && /^[!-~]*$/.test(v)) out.hotkeys[k] = v;
    }
  }
  return out;
}
const handle = (name, fn) => ipcMain.handle(name, (_e, ...args) => fn(...args));
const mutate = (fn) => (...args) => { const r = fn(...args); saveProgressSoon(); stateChanged(); return r; };

// ---------- IPC ----------
handle('init', () => ({ state: snapshot(), data: gameData, events: live.events, version: app.getVersion() }));
handle('setManual', mutate((id, status) => {
  if (isId(id) && (status === null || ['active', 'complete', 'failed'].includes(status))) progress.setManual(id, status);
}));
handle('setManualMany', mutate((ids, status) => {
  if (Array.isArray(ids) && ['active', 'complete'].includes(status)) for (const id of ids.slice(0, 600)) if (isId(id)) progress.setManual(id, status);
}));
handle('toggleObjective', mutate((id, done) => { if (isId(id)) progress.toggleObjective(id, !!done); }));
handle('setLevel', mutate((lvl) => progress.setLevel(Number(lvl) || 0)));
handle('setCounter', mutate((id, n) => { if (isId(id)) progress.setCounter(id, Number(n) || 0); }));
handle('setTracked', mutate((id, on) => { if (isId(id)) progress.setTracked(id, !!on); }));
handle('setWipe', mutate((ts) => progress.setWipe(Number(ts) || 0)));
handle('setWipeIgnore', mutate((on) => progress.setWipeIgnore(!!on)));
handle('setHideout', mutate((id, lvl) => { if (isId(id)) progress.setHideout(id, Math.max(0, Math.min(10, Number(lvl) || 0))); }));
handle('setOwned', mutate((id, n) => { if (isId(id)) progress.setOwned(id, Math.max(0, Math.min(1e7, Number(n) || 0))); }));
const ASSETS = path.join(__dirname, '..', '..', 'assets');
handle('getMapDefs', () => JSON.parse(fs.readFileSync(path.join(ASSETS, 'mapdefs.json'), 'utf8')));
// русские названия мест на картах (свой словарь)
handle('getLabelsRu', () => { try { return JSON.parse(fs.readFileSync(path.join(ASSETS, 'map-labels-ru.json'), 'utf8')); } catch { return {}; } });
// SVG-карты tarkov.dev: загружаются один раз и хранятся в кэше (только с assets.tarkov.dev)
const sanitizeSvg = (txt) => txt
  .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
  .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
  .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  .replace(/\s(?:xlink:)?href\s*=\s*(["']?)\s*javascript:[^"'>\s]*\1/gi, '');
handle('getSvg', async (url) => {
  if (typeof url !== 'string' || !/^https:\/\/assets\.tarkov\.dev\/maps\/svg\/[\w-]+\.svg$/.test(url)) throw new Error('bad url');
  // векторные карты лежат в самом приложении (assets/maps) — сеть нужна, только если файла нет
  const bundled = path.join(ASSETS, 'maps', path.basename(url));
  if (fs.existsSync(bundled)) return fs.readFileSync(bundled, 'utf8');
  const f = path.join(userDir, 'th-cache', 'svg', path.basename(url));
  try {
    const st = fs.statSync(f);
    if (Date.now() - st.mtimeMs < 7 * 24 * 3600 * 1000) return fs.readFileSync(f, 'utf8');
  } catch {}
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const txt = sanitizeSvg(await res.text());
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, txt);
    return txt;
  } catch (e) {
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
    throw e;
  }
});
// полный сброс статистики профиля: квесты, счётчики, убежище, собранные предметы
handle('resetAll', async () => {
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Сбросить всё', 'Отмена'], defaultId: 1, cancelId: 1,
    message: 'Сбросить всю статистику текущего профиля?', detail: 'Удалятся квесты из логов и ручные отметки, счётчики, закреплённые квесты, уровни убежища и собранные предметы. Квесты из логов можно вернуть кнопкой «Пересканировать логи».' });
  if (r.response !== 0) return false;
  const p = progress.active; progress.resetActive(); p.hideout = {}; p.owned = {}; delete p.levelSetAt; p.level = 1;
  progress.save(); stateChanged(); return true;
});
// заново скачать фото квестов и выходов с вики
handle('clearWiki', () => { try { fs.rmSync(path.join(userDir, 'th-cache', 'wiki'), { recursive: true, force: true }); } catch {} wiki.inflight.clear(); return true; });
handle('resetProfile', async () => {
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Сбросить квесты', 'Отмена'], defaultId: 1, cancelId: 1,
    message: 'Сбросить прогресс квестов текущего профиля?',
    detail: 'Удалятся ручные отметки квестов и условий, счётчики и события из логов. Уровни убежища и собранные предметы останутся. События из логов можно вернуть кнопкой «Пересканировать логи».' });
  if (r.response !== 0) return false;
  progress.resetActive(); progress.save(); stateChanged(); return true;
});
handle('rescan', async () => {
  if (!live.logsOk) { send('toast', 'Папка логов недоступна — пересканировать нечего, прогресс оставлен'); return { sessions: 0 }; }
  // старые события убираются только после удачного скана: если логи уже удалены, история профиля не пропадёт
  const p = progress.active;
  const backup = p.logEvents;
  p.logEvents = []; delete p._keys;
  const r = await scanAllLogs(true);
  if (!r.sessions) { p.logEvents = backup; delete p._keys; stateChanged(); send('toast', 'Сессий логов не найдено — прогресс оставлен как был'); return r; }
  send('toast', `Логи пересканированы: ${r.sessions} сессий`);
  return r;
});
handle('refreshData', () => loadData({ force: true, notify: true }));
handle('setSettings', async (patch) => {
  const clean = cleanSettings(patch);
  const before = { ...settings.data };
  settings.set(clean);
  if ('opacity' in clean && win) win.setOpacity(clean.opacity);
  if ('uiScale' in clean && win) win.webContents.setZoomFactor(clean.uiScale);
  if ('alwaysOnTop' in clean && win) win.setAlwaysOnTop(clean.alwaysOnTop, 'screen-saver');
  if ('logsDir' in clean) startLogs();
  if ('screenshotsEnabled' in clean || 'screenshotsDir' in clean) startScreenshots();
  if (clean.lang && clean.lang !== before.lang || clean.gameMode && clean.gameMode !== before.gameMode) loadData({ notify: true });
  let failed = [];
  if (clean.hotkeys) failed = registerHotkeys();
  stateChanged();
  return { failed };
});
handle('browseFolder', async (title) => {
  const r = await dialog.showOpenDialog(win, { title: String(title || 'Выбор папки'), properties: ['openDirectory'] });
  if (r.canceled) return null;
  approvedDirs.add(r.filePaths[0]);
  return r.filePaths[0];
});
handle('detectLogs', async () => { settings.set({ logsDir: null }); await startLogs(); return live.logsOk ? live.logsDir : null; });
handle('win', (action) => {
  if (!win) return;
  if (action === 'min') win.minimize();
  if (action === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  if (action === 'compact') toggleCompact();
  if (action === 'hide') win.hide();
  if (action === 'clickThrough') setClickThrough(!clickThrough);
  // «сквозь окно»: над верхней панелью мышь снова ловится окном, чтобы можно было нажать кнопки
  if (action === 'ctHover-on' && clickThrough) win.setIgnoreMouseEvents(false);
  if (action === 'ctHover-off' && clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
  if (action === 'pin') {
    const on = !settings.get('alwaysOnTop'); settings.set({ alwaysOnTop: on }); win.setAlwaysOnTop(on, 'screen-saver'); stateChanged();
  }
});
handle('openExternal', (url) => openExternalSafe(String(url)));
handle('relaunch', () => { quitting = true; try { progress.save(); } catch {} app.relaunch(); app.exit(0); });
// скриншоты квеста с вики: ссылка берётся из базы, интерфейс передаёт только id квеста
const wikiTask = (id) => (isId(id) ? gameData?.tasks.find((t) => t.id === id && t.wikiLink) : null);
handle('getWiki', async (id) => { const t = wikiTask(id); return t ? wiki.get(t) : null; });
// скриншоты выходов и переходов карты
handle('getMapWiki', async (id) => {
  const m = isId(id) ? gameData?.maps.find((x) => x.id === id && x.wiki) : null;
  return m ? wiki.getMap(m) : null;
});
handle('prefetchWiki', (ids) => {
  if (!Array.isArray(ids)) return;
  const tasks = ids.slice(0, 60).map(wikiTask).filter(Boolean);
  wiki.prefetch(tasks, (d) => send('wiki', d));
  // уже скачанное — сразу
  return tasks.map((t) => wiki.cached(t.id)).filter(Boolean);
});

// ---------- Запуск ----------
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('before-quit', () => { quitting = true; try { progress.save(); } catch {} });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(async () => {
  app.setAppUserModelId('TarkovHelper');
  createWindow();
  createTray();
  const failed = registerHotkeys();
  if (failed.length) setTimeout(() => send('toast', 'Не удалось назначить клавиши: ' + failed.join(', ') + ' — поменяй их в настройках'), 2500);
  // кэш показывается сразу; свежая база (если устарела) догружается, пока читаются логи
  const firstLoad = loadData({});
  await startLogs();
  if (!watcher.gameActive && live.raidState !== 'inraid') live.raidState = 'offline';
  await firstLoad;
  // режим (PvE/PvP) становится известен только после чтения логов — база грузится под него
  if (!gameData || gameData.mode !== dataMode() || gameData.lang !== settings.get('lang')) await loadData({});
  startScreenshots();
  stateChanged();
  if (DEV && process.env.TH_SHOT) runShots(process.env.TH_SHOT);
  if (DEV && process.env.TH_HIDE) setTimeout(() => win?.hide(), Number(process.env.TH_HIDE) * 1000); // замер памяти со скрытым окном
  // базы нет (первый запуск без сети) — пробуем снова, всё реже, пока не загрузится
  const retry = (ms) => setTimeout(async () => { if (gameData) return; await loadData({}); if (!gameData) retry(Math.min(ms * 2, 10 * 60 * 1000)); }, ms);
  if (!gameData) retry(30 * 1000);
  // периодическое обновление базы (цены, новые квесты после патчей) — тихо
  setInterval(() => { if (gameData && data.isStale(gameData)) loadData({ force: true }); }, 30 * 60 * 1000);
});

// отладка: TH_SHOT=<папка> TH_PAGES=raid@bigmap@tasks,quests — снимки окна по страницам
function runShots(dir) {
  const pages = (process.env.TH_PAGES || 'raid').split(',');
  let i = 0;
  const next = async () => {
    if (i >= pages.length) { quitting = true; app.quit(); return; }
    const [p, mapId, side] = pages[i++].split('@');
    if (p === 'compact') toggleCompact(); else send('showTab', p);
    if (mapId) send('mapChanged', mapId);
    if (side?.startsWith('w:')) win.setSize(Number(side.slice(2)), 860); else if (side) send('debugSide', side);
    await new Promise((r) => setTimeout(r, Number(process.env.TH_DELAY || 3500)));
    const img = await win.webContents.capturePage();
    const name = `shot-${p}${mapId ? '-' + mapId : ''}${side ? '-' + side : ''}`.replace(/[^\w.-]+/g, '_');
    fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
    next();
  };
  setTimeout(next, 4000);
}
