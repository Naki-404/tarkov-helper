'use strict';
// Наблюдение за папкой логов EFT.
// Только чтение: список папок, размер файлов и новые байты в конце файлов.
// Файлы открываются в режиме 'r' (только чтение) и сразу закрываются.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { splitEntries, entryToEvent } = require('./logparser');

const WATCHED_FILES = /(application|push-notifications)_\d+\.log$/;
const POLL_MS = 1000;

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const m = new RegExp(value + '\\s+REG_\\w+\\s+(.+)').exec(out);
      resolve(m ? m[1].trim() : null);
    });
  });
}

// Ищет папку Logs: путь из настроек → установка через лаунчер BSG → библиотеки Steam → типовые пути.
async function detectLogsDir() {
  const candidates = [];

  const bsg = await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EscapeFromTarkov', 'InstallLocation');
  if (bsg) candidates.push(path.join(bsg, 'Logs'), path.join(bsg, 'build', 'Logs'));

  const steam = await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  const steamRoots = [];
  if (steam) steamRoots.push(steam.replace(/\//g, '\\'));
  for (const root of steamRoots) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (exists(vdf)) {
      const txt = fs.readFileSync(vdf, 'utf8');
      for (const m of txt.matchAll(/"path"\s+"([^"]+)"/g)) {
        const lib = m[1].replace(/\\\\/g, '\\');
        candidates.push(path.join(lib, 'steamapps', 'common', 'Escape from Tarkov', 'build', 'Logs'));
        candidates.push(path.join(lib, 'steamapps', 'common', 'Escape from Tarkov', 'Logs'));
      }
    }
  }

  for (const d of ['C:', 'D:', 'E:', 'F:']) {
    candidates.push(`${d}\\Battlestate Games\\EFT\\Logs`);
    candidates.push(`${d}\\Battlestate Games\\Escape from Tarkov\\Logs`);
    candidates.push(`${d}\\SteamLibrary\\steamapps\\common\\Escape from Tarkov\\build\\Logs`);
    candidates.push(`${d}\\Steam\\steamapps\\common\\Escape from Tarkov\\build\\Logs`);
  }
  return candidates.find(exists) || null;
}

// Время из имени папки: log_2026.10.06_8-09-30_1.1.5.1.47510 (час без ведущего нуля!)
function sessionTime(name) {
  const m = /^log_(\d{4})\.(\d{1,2})\.(\d{1,2})_(\d{1,2})-(\d{1,2})-(\d{1,2})/.exec(name);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0;
}

function listSessions(logsDir) {
  try {
    return fs.readdirSync(logsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('log_'))
      .map((d) => d.name)
      // сортировка по времени, а не по имени: "8-09" по алфавиту оказался бы позже "21-42"
      .sort((a, b) => sessionTime(a) - sessionTime(b) || a.localeCompare(b));
  } catch { return []; }
}

function listSessionFiles(sessionDir) {
  try {
    return fs.readdirSync(sessionDir).filter((f) => WATCHED_FILES.test(f)).map((f) => path.join(sessionDir, f));
  } catch { return []; }
}

function readRange(file, start, end) {
  const len = end - start;
  if (len <= 0) return Buffer.alloc(0);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

function parseFileFully(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const { entries } = splitEntries(text, true);
  const events = [];
  for (const e of entries) {
    const ev = entryToEvent(e);
    if (ev) events.push(ev);
  }
  return events;
}

// Полный разбор одной сессии (папки log_...): события из всех файлов, по времени.
function parseSession(sessionDir) {
  const events = [];
  for (const f of listSessionFiles(sessionDir)) events.push(...parseFileFully(f));
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

const LIST_EVERY_MS = 5000;       // список папок сессий (их сотни) перечитывается раз в 5 с
const IDLE_MS = 5 * 60 * 1000;      // логи не растут 5 минут — игра, скорее всего, закрыта

class LogWatcher extends EventEmitter {
  constructor() {
    super();
    this.logsDir = null;
    this.session = null;
    this.files = new Map(); // file -> { offset, rest, lastGrowth, restIsReplay, decoder }
    this.timer = null;
    this.lastList = 0;
    this.lastActivity = 0;  // когда любой файл текущей сессии (включая backend/output) последний раз вырос
    this.sizes = new Map();
    this.wasActive = null;  // прошлое значение gameActive — переход true→false случается между тиками
  }

  start(logsDir) {
    this.stop();
    this.logsDir = logsDir;
    if (!logsDir || !exists(logsDir)) {
      this.emit('status', { ok: false, logsDir, message: 'Папка логов не найдена' });
      return;
    }
    this.emit('status', { ok: true, logsDir, message: 'Слежу за логами' });
    this.tick(true);
    this.timer = setInterval(() => this.tick(false), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.files.clear();
    this.sizes.clear();
    this.session = null;
    this.lastList = 0;
  }

  get gameActive() { return Date.now() - this.lastActivity < IDLE_MS; }

  // активность игры: растёт ли хоть один файл сессии (только размер, без чтения).
  // Один readdir + stat на тик; возвращает размеры отслеживаемых файлов логов.
  checkActivity(dir, initial) {
    const watched = new Map();
    let names;
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.log')); } catch { return watched; }
    for (const f of names) {
      let st;
      try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
      const prev = this.sizes.get(f);
      if (initial) this.lastActivity = Math.max(this.lastActivity, st.mtimeMs);
      else if (prev !== undefined && st.size > prev) this.lastActivity = Date.now();
      else if (prev === undefined) this.lastActivity = Math.max(this.lastActivity, st.mtimeMs);
      this.sizes.set(f, st.size);
      if (WATCHED_FILES.test(f)) watched.set(path.join(dir, f), st.size);
    }
    return watched;
  }

  tick(initial) {
    // игра закрыта — проверяем логи раз в 5 секунд вместо каждой секунды
    if (!initial && !this.gameActive && (this.idleSkip = ((this.idleSkip || 0) + 1) % 5) !== 0) return;
    if (initial || Date.now() - this.lastList > LIST_EVERY_MS || !this.session) {
      this.lastList = Date.now();
      const sessions = listSessions(this.logsDir);
      const latest = sessions[sessions.length - 1];
      if (!latest) return;
      if (latest !== this.session) {
        const isNew = !initial;
        this.session = latest;
        this.files.clear();
        this.sizes.clear();
        if (isNew) this.lastActivity = Date.now();
        // при старте приложения последняя сессия читается целиком (события уже были),
        // новая сессия (перезапуск игры) — тоже с начала
        this.emit('session', { name: latest, isNew });
      }
    }
    const dir = path.join(this.logsDir, this.session);
    const sizes = this.checkActivity(dir, initial);
    const active = this.gameActive;
    if (!initial && this.wasActive !== null && this.wasActive !== active) this.emit('activity', active);
    this.wasActive = active;
    // при первом чтении события всех файлов сессии отдаются по времени: иначе квесты из push-notifications
    // приписались бы последнему профилю из application.log, а не тому, при котором случились
    const batch = initial ? [] : null;
    const out = (ev) => (batch ? batch.push(ev) : this.emit('event', ev));
    for (const [file, size] of sizes) {
      let state = this.files.get(file);
      if (!state) {
        // декодер на файл: многобайтовая буква на границе куска не ломается
        state = { offset: 0, rest: '', lastGrowth: Date.now(), restIsReplay: false, decoder: new StringDecoder('utf8') };
        this.files.set(file, state);
      }
      if (size < state.offset) { state.offset = 0; state.rest = ''; state.decoder = new StringDecoder('utf8'); }
      let chunk = '';
      if (size > state.offset) {
        let buf;
        try { buf = readRange(file, state.offset, size); } catch { continue; }
        state.offset += buf.length;
        chunk = state.decoder.write(buf);
        state.lastGrowth = Date.now();
      }
      // если файл не рос 2 секунды, последняя запись считается дописанной
      const flush = !chunk && state.rest && Date.now() - state.lastGrowth > 2000;
      if (!chunk && !flush) continue;
      // replay: события, которые уже были в логе на момент запуска приложения
      // (в том числе последняя запись, придержанная при первом чтении, — даже если файл дорос раньше чем за 2 с)
      const replay = initial || (!chunk && state.restIsReplay);
      const firstIsReplay = state.restIsReplay && !!state.rest;
      const { entries, rest } = splitEntries(state.rest + chunk, flush);
      state.rest = rest;
      state.restIsReplay = initial;
      entries.forEach((e, i) => {
        const ev = entryToEvent(e);
        if (ev) out({ ...ev, replay: replay || (i === 0 && firstIsReplay), session: this.session });
      });
    }
    if (batch) { batch.sort((a, b) => a.ts - b.ts); for (const ev of batch) this.emit('event', ev); }
  }
}

module.exports = { LogWatcher, detectLogsDir, listSessions, parseSession };
