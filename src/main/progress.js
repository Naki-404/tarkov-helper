'use strict';
// Прогресс по квестам. Хранится локально в JSON, отдельно для каждого профиля игры
// (у PvE и PvP разные профили, после вайпа появляется новый профиль).
// Источники: события из логов (взят / выполнен / провален) и ручные отметки.

const fs = require('fs');
const path = require('path');

const DEFAULT_PROFILE = 'default';

class ProgressStore {
  constructor(file) {
    this.file = file;
    this.data = { activeProfile: DEFAULT_PROFILE, profiles: {}, scannedSessions: [] };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...raw };
    } catch { /* первый запуск */ }
    this.profile(this.data.activeProfile);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, (k, v) => (k === '_keys' ? undefined : v)));
    fs.renameSync(tmp, this.file);
  }

  profile(id) {
    if (!this.data.profiles[id]) {
      this.data.profiles[id] = { mode: null, level: 1, firstSeen: Date.now(), lastSeen: Date.now(), logEvents: [], manual: {}, objectives: {} };
    }
    const p = this.data.profiles[id];
    if (!p.hideout) p.hideout = {}; // stationId -> построенный уровень
    if (!p.owned) p.owned = {};     // itemId -> сколько уже собрано (для списка нужных предметов)
    if (!p.counters) p.counters = {}; // objectiveId -> { n, ts } — ручной счётчик «2 из 5» (в логах его нет)
    if (!p.tracked) p.tracked = {};   // taskId -> ts — квесты, отмеченные звёздочкой «слежу»
    return p;
  }

  get active() { return this.profile(this.data.activeProfile); }

  setActiveProfile(id, mode) {
    // ручные отметки, сделанные до первого чтения логов, переезжают в настоящий профиль
    const def = this.data.profiles[DEFAULT_PROFILE];
    const p = this.profile(id);
    const hasData = (x) => ['manual', 'objectives', 'hideout', 'owned', 'counters', 'tracked'].some((k) => Object.keys(x[k] || {}).length);
    if (def && id !== DEFAULT_PROFILE && hasData(def) && !hasData(p)) {
      p.manual = def.manual; p.objectives = def.objectives; p.level = def.level;
      p.hideout = def.hideout || {}; p.owned = def.owned || {}; p.counters = def.counters || {}; p.tracked = def.tracked || {};
      if (def.levelSetAt) p.levelSetAt = def.levelSetAt;
      delete this.data.profiles[DEFAULT_PROFILE];
    }
    if (mode) p.mode = mode;
    p.lastSeen = Date.now();
    this.data.activeProfile = id;
  }

  addLogEvent(profileId, ev) {
    const p = this.profile(profileId);
    const key = ev.ts + ':' + ev.messageId + ':' + ev.kind;
    if (!p._keys) p._keys = new Set(p.logEvents.map((e) => e.ts + ':' + e.messageId + ':' + e.kind));
    if (p._keys.has(key)) return false;
    p._keys.add(key);
    p.logEvents.push({ ts: ev.ts, kind: ev.kind, messageId: ev.messageId });
    return true;
  }

  setManual(taskId, status) {
    const p = this.active;
    if (status == null) delete p.manual[taskId];
    else p.manual[taskId] = { status, ts: Date.now() };
  }

  toggleObjective(objectiveId, done) {
    const p = this.active;
    if (done) p.objectives[objectiveId] = Date.now(); else delete p.objectives[objectiveId];
  }

  // ручная отметка вайпа: всё, что было в логах раньше этого момента, не учитывается
  setWipe(ts) { if (ts) { this.active.wipeTs = ts; delete this.active.wipeIgnore; } else delete this.active.wipeTs; }

  // «это был не вайп»: автоопределение отключено, учитываются все логи
  setWipeIgnore(on) { if (on) this.active.wipeIgnore = true; else delete this.active.wipeIgnore; }

  setLevel(level) {
    const p = this.active;
    if (!level) { delete p.levelSetAt; p.level = 1; return; }
    p.level = Math.max(1, Math.min(79, Number(level) || 1));
    p.levelSetAt = Date.now();
  }

  setHideout(stationId, level) {
    const p = this.active;
    if (!level) delete p.hideout[stationId]; else p.hideout[stationId] = level;
  }

  setCounter(objectiveId, n) {
    const p = this.active;
    if (!n || n < 0) delete p.counters[objectiveId]; else p.counters[objectiveId] = { n: Math.floor(n), ts: Date.now() };
  }

  setTracked(taskId, on) {
    const p = this.active;
    if (on) p.tracked[taskId] = Date.now(); else delete p.tracked[taskId];
  }

  setOwned(itemId, count) {
    const p = this.active;
    if (!count || count < 0) delete p.owned[itemId]; else p.owned[itemId] = Math.floor(count);
  }

  resetActive() {
    const p = this.active;
    p.logEvents = []; p.manual = {}; p.objectives = {}; p.counters = {}; p.tracked = {}; delete p._keys;
  }

}

// Статус каждого квеста из событий логов + ручных отметок.
// messageIndex: messageId -> taskId (из полей *MessageId в данных tarkov.dev)
// tasks: массив квестов tarkov.dev
// в данных tarkov.dev ссылка на квест — строка id (в GraphQL — объект { id })
const reqId = (req) => (typeof req.task === 'string' ? req.task : req.task?.id);

const WIPE_CLUSTER = 3;                 // столько уже выполненных квестов «взято» заново…
const WIPE_WINDOW = 48 * 3600 * 1000;   // …в пределах двух суток — значит, профиль сброшен
const SESSION_GAP = 90 * 60 * 1000;

// Вайп в логах никак не помечается, а id профиля после вайпа может остаться прежним.
// Признак вайпа: квесты, которые уже были выполнены (и не повторяемые), снова приходят как «взят».
// Возвращает время начала игровой сессии, в которой это случилось (последний вайп), или 0.
function detectWipe(events, messageIndex, byId) {
  const cur = {};
  const hits = [];
  for (const ev of events) {
    const id = messageIndex[ev.messageId];
    if (!id) continue;
    if (ev.kind === 'started' && cur[id] === 'complete' && !byId.get(id)?.restartable) hits.push(ev.ts);
    cur[id] = ev.kind === 'started' ? 'active' : ev.kind === 'finished' ? 'complete' : 'failed';
  }
  let wipeAt = 0;
  for (let i = 0; i < hits.length; i++) {
    let n = 0;
    for (let j = i; j < hits.length && hits[j] - hits[i] <= WIPE_WINDOW; j++) n++;
    if (n >= WIPE_CLUSTER && hits[i] - wipeAt > 14 * 24 * 3600 * 1000) wipeAt = hits[i];
  }
  if (!wipeAt) return 0;
  // откатываемся к началу игровой сессии: события, идущие подряд без больших пауз
  const all = events.map((e) => e.ts).filter((t) => t <= wipeAt);
  let start = wipeAt;
  for (let k = all.length - 1; k > 0; k--) {
    if (all[k] - all[k - 1] > SESSION_GAP) { start = all[k]; break; }
    start = all[k - 1];
  }
  return start;
}

function computeStatuses(profile, tasks, messageIndex) {
  const status = {}; // taskId -> { status, ts, src }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const sorted = [...profile.logEvents].sort((a, b) => a.ts - b.ts);
  const detectedWipe = profile.wipeIgnore ? 0 : detectWipe(sorted, messageIndex, byId);
  // ручная отметка «вайп был» важнее автоматической, если она позже
  const wipeTs = Math.max(detectedWipe, profile.wipeTs || 0);
  const events = sorted.filter((e) => e.ts >= wipeTs);
  const unresolved = [];
  for (const ev of events) {
    const taskId = messageIndex[ev.messageId];
    if (!taskId) { unresolved.push(ev); continue; }
    const s = ev.kind === 'started' ? 'active' : ev.kind === 'finished' ? 'complete' : 'failed';
    status[taskId] = { status: s, ts: ev.ts, src: 'log' };
  }
  for (const [taskId, m] of Object.entries(profile.manual)) {
    if (m.ts < wipeTs) continue;
    const cur = status[taskId];
    if (!cur || m.ts >= cur.ts) status[taskId] = { status: m.status, ts: m.ts, src: 'manual' };
  }

  // Если квест взят или выполнен, все его обязательные предыдущие квесты уже выполнены.
  const implied = (taskId, seen) => {
    const t = byId.get(taskId);
    if (!t) return;
    for (const req of t.taskRequirements || []) {
      const rid = reqId(req);
      if (!rid || seen.has(rid)) continue;
      seen.add(rid);
      const st = req.status || [];
      if (!st.includes('complete')) continue; // требование «провален» или «активен» не выводим
      const cur = status[rid];
      if (!cur) status[rid] = { status: 'complete', ts: 0, src: 'implied' };
      if (!cur || cur.status === 'complete') implied(rid, seen);
    }
  };
  for (const [taskId, s] of Object.entries({ ...status })) {
    if (s.status === 'active' || s.status === 'complete') implied(taskId, new Set());
  }

  // Уровень персонажа в логах не пишется. Оценка — по требуемому уровню взятых/выполненных
  // квестов (из логов, после вайпа). Берётся 3-й по величине, а не максимум: у отдельных квестов
  // требование в базе tarkov.dev бывает завышено или их выдают без проверки уровня.
  const lvls = Object.entries(status)
    .filter(([, s]) => (s.status === 'active' || s.status === 'complete') && s.src !== 'implied')
    .map(([id]) => byId.get(id)?.minPlayerLevel || 1)
    .sort((a, b) => b - a);
  const estimatedLevel = lvls[Math.min(2, lvls.length - 1)] || 1;

  // Ручной уровень (если указан после вайпа) важнее оценки
  const manualLevel = profile.levelSetAt && profile.levelSetAt >= wipeTs ? profile.level : null;
  const level = manualLevel || estimatedLevel;

  // Фракция в логах не пишется, но квесты только для BEAR или USEC выдают лишь своей фракции
  const fc = {};
  for (const [id, s] of Object.entries(status)) {
    const f = byId.get(id)?.factionName;
    if (s.src !== 'implied' && f && f !== 'Any') fc[f] = (fc[f] || 0) + 1;
  }
  const faction = Object.keys(fc).sort((a, b) => fc[b] - fc[a])[0] || null;

  // Доступность: не начат, требования выполнены, уровень подходит, своя фракция
  for (const t of tasks) {
    if (status[t.id]) continue;
    if (faction && t.factionName && t.factionName !== 'Any' && t.factionName !== faction) { status[t.id] = { status: 'locked', ts: 0, src: 'computed', otherFaction: true }; continue; }
    const reqsOk = (t.taskRequirements || []).every((req) => {
      const rid = reqId(req);
      if (!rid) return true;
      const st = status[rid]?.status;
      const need = req.status || ['complete'];
      if (need.includes('complete') && st === 'complete') return true;
      if (need.includes('active') && (st === 'active' || st === 'complete')) return true;
      if (need.includes('failed') && st === 'failed') return true;
      return false;
    });
    if (reqsOk && (t.minPlayerLevel || 0) <= level) status[t.id] = { status: 'available', ts: 0, src: 'computed' };
    else status[t.id] = { status: 'locked', ts: 0, src: 'computed', levelLocked: reqsOk };
  }
  // отметки условий, сделанные до вайпа, не учитываются (старые отметки без времени сохраняются)
  const objectives = {};
  for (const [id, v] of Object.entries(profile.objectives || {})) {
    if (v === true || v >= wipeTs) objectives[id] = true;
  }
  const counters = {};
  for (const [id, c] of Object.entries(profile.counters || {})) if (c.ts >= wipeTs) counters[id] = c.n;
  // отслеживаемые: только незавершённые квесты
  const tracked = Object.keys(profile.tracked || {}).filter((id) => {
    const s = status[id]?.status;
    return s && s !== 'complete' && s !== 'failed';
  });
  return { faction, counters, tracked, status, unresolved, estimatedLevel, level, manualLevel, wipeTs, detectedWipe, objectives };
}

module.exports = { ProgressStore, computeStatuses, DEFAULT_PROFILE };
