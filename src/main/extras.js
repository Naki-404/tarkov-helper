'use strict';
// Дополнения к квестам из открытого проекта eft_quest_helper (MIT), собранного с вики EFT (CC BY-SA):
// подсказки к квестам tarkov.dev и сюжетные/текущие событийные квесты, которых в tarkov.dev нет.
// Только публичные данные; файл в assets собирается tools/build-extras.js, свежий — скачивается раз в неделю.

const fs = require('fs');
const path = require('path');

const SOURCE = 'eft_quest_helper (MIT) · escapefromtarkov.fandom.com (CC BY-SA)';
const URL = 'https://raw.githubusercontent.com/ugurturna/eft_quest_helper/main/data/tasks_en.json';
const UA = 'TarkovHelper/1.5 (personal quest overlay; reads public quest data)';
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_TASKS = 300; // меньше — значит, файл битый или не тот

const strs = (a) => [...new Set((Array.isArray(a) ? a : []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// пустые поля не пишутся — файл меньше
function compact(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && !v.length)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
    r[k] = v;
  }
  return r;
}

// у старых событий на вики флаг «идёт» иногда не снят — «Afterparty (8 December 2023)»; дата в названии старше полугода — событие прошло
function staleEvent(name) {
  const d = Date.parse(/\(([^)]*\d{4})\)/.exec(name || '')?.[1] || '');
  return !Number.isNaN(d) && Date.now() - d > 183 * 24 * 3600 * 1000;
}

function buildExtras(tasks) {
  if (!Array.isArray(tasks)) throw new Error('ожидался массив квестов');
  const hints = {};
  const quests = [];
  for (const t of tasks) {
    if (!t || typeof t !== 'object') continue;
    const objectives = Array.isArray(t.objectives) ? t.objectives : [];
    if (t.tarkovDevId) {
      const h = compact({
        details: strs(objectives.flatMap((o) => o?.details || [])),
        pve: strs(t.modeNotes?.pve),
        requirements: strs(t.requirementsText),
      });
      if (Object.keys(h).length) hints[t.tarkovDevId] = h;
      continue;
    }
    // квесты, которых нет в tarkov.dev: весь сюжет и только идущие сейчас события
    if (t.category !== 'story' && !(t.category === 'event' && t.eventActive === true && !staleEvent(t.eventName))) continue;
    quests.push(compact({
      id: 'x-' + t.id,
      name: t.name,
      category: t.category,
      eventName: t.eventName,
      trader: typeof t.trader === 'string' ? t.trader : undefined,
      maps: strs(t.map),
      minLevel: num(t.minLevel),
      kappaRequired: !!t.kappaRequired,
      objectives: objectives.map((o) => compact({
        id: o.id, text: o.text, count: num(o.count), optional: !!o.optional,
        maps: strs(o.maps), details: strs(o.details),
      })),
      guide: typeof t.guide === 'string' ? t.guide.trim() : undefined,
      wikiUrl: t.wikiUrl,
      rewards: compact({ xp: num(t.rewards?.xp) || undefined, items: strs(t.rewards?.items) }),
    }));
  }
  return { source: SOURCE, builtAt: Date.now(), hints, quests };
}

// дополнения: кэш (свежая сборка) или файл из assets; сеть — только raw.githubusercontent.com
class Extras {
  constructor(cacheDir, assetsDir) {
    this.file = path.join(cacheDir, 'quest-extras.json');
    this.bundled = path.join(assetsDir, 'quest-extras.json');
    this.data = null;
    this.inflight = null;
  }

  load() {
    for (const f of [this.file, this.bundled]) {
      try {
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (d && d.hints && Array.isArray(d.quests)) { this.data = d; return d; }
      } catch { /* нет файла или битый */ }
    }
    this.data = { source: SOURCE, builtAt: 0, hints: {}, quests: [] };
    return this.data;
  }

  isStale() {
    try { return Date.now() - fs.statSync(this.file).mtimeMs > STALE_MS; } catch { return true; }
  }

  // скачать, собрать и сохранить; при ошибке остаются прежние данные
  refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(URL, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const arr = await res.json();
        if (!Array.isArray(arr) || arr.length <= MIN_TASKS) throw new Error('неожиданный формат tasks_en.json');
        const d = buildExtras(arr);
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(d));
        fs.renameSync(this.file + '.tmp', this.file);
        this.data = d;
        return d;
      } finally { clearTimeout(timer); this.inflight = null; }
    })();
    return this.inflight;
  }
}

module.exports = { buildExtras, Extras, SOURCE, URL };
