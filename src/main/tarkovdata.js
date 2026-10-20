'use strict';
// Открытые данные tarkov.dev (https://json.tarkov.dev — тот же источник, что у сайта tarkov.dev).
// Загружаются квесты, карты, убежище, торговцы и предметы, переводятся на выбранный язык
// и ужимаются до компактной модели, которая кэшируется на диск.

const fs = require('fs');
const path = require('path');

const BASE = 'https://json.tarkov.dev';
const STALE_MS = 12 * 60 * 60 * 1000; // данные старше 12 часов обновляются в фоне (база ~20 МБ)
const CACHE_VERSION = 4;

const TRANSLATE_KEYS = new Set(['name', 'shortName', 'description', 'exitName', 'targetNames', 'exitStatus',
  'effects', 'bodyParts', 'zoneName', 'Nickname', 'customizationTypeName']);

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function dataset(mode, name, lang) {
  const jm = mode === 'pve' ? 'pve' : 'regular';
  const [main, tr, en] = await Promise.all([
    getJson(`${BASE}/${jm}/${name}`),
    getJson(`${BASE}/${jm}/${name}_${lang}`).catch(() => null),
    lang !== 'en' ? getJson(`${BASE}/${jm}/${name}_en`).catch(() => null) : Promise.resolve(null),
  ]);
  const dict = { ...(en?.data || {}), ...(tr?.data || {}) };
  // en — отдельно: английские названия нужны для сопоставления с вики
  return { data: main.data, dict, en: lang === 'en' ? tr?.data || {} : en?.data || {} };
}

function makeTranslator(dict) {
  const t = (v) => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(dict, v) ? dict[v] : v);
  const walk = (obj) => {
    if (Array.isArray(obj)) { for (const x of obj) walk(x); return; }
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (TRANSLATE_KEYS.has(k)) {
        if (typeof v === 'string') obj[k] = t(v);
        else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) obj[k] = v.map(t);
        else walk(v);
      } else if (v && typeof v === 'object') walk(v);
    }
  };
  return { t, walk };
}

const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined && o[k] !== null) r[k] = o[k]; return r; };
const pos = (p) => (p ? { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) } : null);
const zone = (z) => ({ map: z.map, position: pos(z.position), outline: z.outline?.map(pos), top: z.top, bottom: z.bottom });

function buildTasks(raw, tr) {
  const tasks = Object.values(raw.tasks);
  tr.walk(tasks);
  const questItems = raw.questItems || {};
  tr.walk(Object.values(questItems));
  return tasks.map((t) => ({
    ...pick(t, ['id', 'name', 'normalizedName', 'trader', 'map', 'wikiLink', 'minPlayerLevel', 'kappaRequired', 'lightkeeperRequired',
      'taskImageLink', 'factionName', 'restartable', 'experience', 'requiredPrestige']),
    taskRequirements: (t.taskRequirements || []).map((r) => ({ task: r.task, status: r.status })),
    traderRequirements: t.traderRequirements || [],
    neededKeys: t.neededKeys || [],
    objectives: (t.objectives || []).map((o) => {
      const r = pick(o, ['id', 'type', 'description', 'optional', 'count', 'foundInRaid', 'items', 'useAny', 'exitName', 'exitStatus',
        'targetNames', 'maps', 'level', 'trader', 'skill', 'task', 'status', 'item', 'markerItem', 'usingWeapon', 'wearing', 'requiredKeys',
        'dogTagLevel', 'minDurability']);
      if (o.zones?.length) r.zones = o.zones.map(zone);
      if (o.possibleLocations?.length) r.possibleLocations = o.possibleLocations.map((l) => ({ map: l.map, positions: l.positions.map(pos) }));
      if (o.questItem) {
        const q = typeof o.questItem === 'string' ? questItems[o.questItem] : o.questItem;
        r.questItem = q ? { id: q.id, name: q.name, shortName: q.shortName, iconLink: q.iconLink } : { id: o.questItem };
      }
      if (r.items && r.items.length > 60) { r.itemsCount = r.items.length; r.items = r.items.slice(0, 60); }
      return r;
    }),
    finishRewards: t.finishRewards ? {
      items: (t.finishRewards.items || []).map((i) => ({ item: i.item, count: i.count })),
      traderStanding: t.finishRewards.traderStanding || [],
      offerUnlock: (t.finishRewards.offerUnlock || []).map((o) => ({ trader: o.trader, level: o.level, item: o.item })),
    } : null,
  }));
}

function buildMaps(raw, tr, enDict = {}) {
  const maps = Object.values(raw.maps);
  // английские названия выходов и переходов (до перевода) — по ним ищутся скриншоты на вики
  for (const m of maps) {
    for (const e of m.extracts || []) e._en = enDict[e.name] || e.name;
    for (const t of m.transits || []) t._en = enDict[t.description] || t.description;
  }
  tr.walk(maps);
  return maps.map((m) => ({
    ...pick(m, ['id', 'name', 'normalizedName', 'nameId', 'scenePath', 'raidDuration', 'players', 'minPlayerLevel', 'maxPlayerLevel', 'wiki']),
    extracts: (m.extracts || []).map((e) => ({ name: e.name, en: e._en, faction: e.faction, position: pos(e.position), outline: e.outline?.map(pos), top: e.top, bottom: e.bottom, switch: !!e.switch })),
    transits: (m.transits || []).map((t) => ({ description: t.description, en: t._en, position: pos(t.position), top: t.top, bottom: t.bottom })),
    locks: (m.locks || []).filter((l) => l.key).map((l) => ({ key: l.key, lockType: l.lockType, needsPower: l.needsPower, position: pos(l.position) })),
    bosses: (m.bosses || []).map((b) => ({ name: b.name || b.boss, spawnChance: b.spawnChance })),
    accessKeys: m.accessKeys || [],
  }));
}

function buildHideout(raw, tr) {
  const st = Object.values(raw);
  tr.walk(st);
  return st.map((s) => ({
    ...pick(s, ['id', 'name', 'normalizedName', 'imageLink', 'areaType']),
    levels: (s.levels || []).map((l) => ({
      level: l.level,
      constructionTime: l.constructionTime,
      itemRequirements: (l.itemRequirements || []).map((r) => ({ item: r.item, count: r.count, fir: !!r.attributes?.foundInRaid })),
      stationLevelRequirements: (l.stationLevelRequirements || []).map((r) => ({ station: r.station, level: r.level })),
      traderRequirements: (l.traderRequirements || []).map((r) => ({ trader: r.trader, value: r.value ?? r.level, requirementType: r.requirementType })),
      skillRequirements: (l.skillRequirements || []).map((r) => ({ name: r.name || r.skill, level: r.level })),
    })),
  }));
}

function buildTraders(raw, tr) {
  const list = Object.values(raw.traders || raw);
  tr.walk(list);
  return list.map((t) => ({
    ...pick(t, ['id', 'name', 'normalizedName', 'imageLink']),
    levels: (t.levels || []).map((l) => pick(l, ['level', 'requiredPlayerLevel', 'requiredReputation', 'requiredCommerce'])),
  }));
}

function buildItems(raw, tr, traderNames) {
  const out = {};
  for (const it of Object.values(raw.items)) {
    const best = (it.sellToTrader || []).reduce((a, s) => (!a || (s.priceRUB || 0) > (a.priceRUB || 0) ? s : a), null);
    out[it.id] = {
      n: tr.t(it.name), s: tr.t(it.shortName), i: it.iconLink,
      p: it.avg24hPrice || it.lastLowPrice || null,
      b: best ? { t: traderNames[best.trader] || best.trader, p: best.priceRUB } : null,
      w: it.wikiLink || null,
      ty: it.types || [],
    };
  }
  // квестовые предметы тоже нужны для поиска
  return out;
}

async function fetchAll(lang, mode) {
  const [tasks, maps, hideout, traders, items] = await Promise.all([
    dataset(mode, 'tasks', lang),
    dataset(mode, 'maps', lang),
    dataset(mode, 'hideout', lang),
    dataset(mode, 'traders', lang),
    dataset(mode, 'items', lang),
  ]);
  const trT = makeTranslator(tasks.dict);
  const trM = makeTranslator(maps.dict);
  const trH = makeTranslator(hideout.dict);
  const trTr = makeTranslator(traders.dict);
  const trI = makeTranslator(items.dict);

  const traderList = buildTraders(traders.data, trTr);
  const traderNames = Object.fromEntries(traderList.map((t) => [t.id, t.name]));
  const taskList = buildTasks(tasks.data, trT);
  const itemMap = buildItems(items.data, trI, traderNames);
  for (const q of Object.values(tasks.data.questItems || {})) {
    if (!itemMap[q.id]) itemMap[q.id] = { n: q.name, s: q.shortName, i: q.iconLink, p: null, b: null, quest: true };
  }
  return {
    version: CACHE_VERSION,
    fetchedAt: Date.now(),
    lang, mode,
    tasks: taskList,
    maps: buildMaps(maps.data, trM, maps.en),
    hideout: buildHideout(hideout.data, trH),
    traders: traderList,
    items: itemMap,
    skills: items.data.skills ? Object.values(items.data.skills).map((s) => ({ id: s.id, name: trI.t(s.name) })) : [],
  };
}

function cacheFile(dir, lang, mode) { return path.join(dir, 'th-cache', `data-${mode}-${lang}.json`); }

function loadCache(dir, lang, mode) {
  try {
    const d = JSON.parse(fs.readFileSync(cacheFile(dir, lang, mode), 'utf8'));
    return d.version === CACHE_VERSION ? d : null;
  } catch { return null; }
}

function saveCache(dir, d) {
  const f = cacheFile(dir, d.lang, d.mode);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(d));
  fs.renameSync(f + '.tmp', f);
}

function isStale(d) { return !d || Date.now() - d.fetchedAt > STALE_MS; }

// id карты из логов (nameId, например "bigmap") → карта tarkov.dev
function findMap(d, logId) {
  if (!d || !logId) return null;
  const k = String(logId).toLowerCase();
  return d.maps.find((m) => m.nameId?.toLowerCase() === k || m.id === logId || m.normalizedName === k) || null;
}

module.exports = { fetchAll, loadCache, saveCache, isStale, findMap };
