// Данные и расчёты интерфейса (без DOM). Модель tarkov.dev — из main/tarkovdata.js,
// состояние (статусы квестов, прогресс) — снимок из main/main.js.

export const MONEY = new Set(['5449016a4bdc2d6f028b456f', '5696686a4bdc2da3298b456a', '569668774bdc2da2298b4568']);
export const MARKER_ITEM = '5991b51486f77447b112d44f'; // маркер MS2000
export const ST_LABEL = { active: 'Активен', available: 'Можно взять', locked: 'Закрыт', complete: 'Выполнен', failed: 'Провален' };
export const RAID_LABEL = { offline: 'игра не запущена', idle: 'в меню', matching: 'поиск рейда', loading: 'загрузка карты', inraid: 'в рейде' };
// условия с количеством — для ручного счётчика «2 из 5» (в логах прогресса условий нет)
const COUNTABLE = new Set(['shoot', 'giveItem', 'findItem', 'plantItem', 'findQuestItem', 'giveQuestItem', 'useItem', 'sellItem', 'extract', 'buildWeapon']);

export const S = { data: null, state: null, mapDefs: {}, events: [], wiki: new Map() };
export const idx = { task: new Map(), trader: new Map(), map: new Map(), station: new Map(), group: new Map(), next: new Map() };
export const idOf = (x) => (typeof x === 'string' ? x : x?.id);

export function indexData() {
  for (const k of Object.keys(idx)) idx[k].clear();
  const d = S.data;
  if (!d) return;
  for (const t of d.traders) idx.trader.set(t.id, t);
  for (const m of d.maps) idx.map.set(m.id, m);
  for (const s of d.hideout) idx.station.set(s.id, s);
  // группы карт: «Эпицентр»/«Эпицентр 21+», «Завод»/«Ночной завод», «Лаборатория»/Dark — одно место
  const key = (m) => { const n = m.normalizedName || ''; return n.startsWith('ground-zero') ? 'gz' : n.endsWith('factory') ? 'factory' : n === 'the-lab' || n === 'the-lab-dark' ? 'lab' : m.id; };
  const groups = new Map();
  for (const m of d.maps) { const k = key(m); if (!groups.has(k)) groups.set(k, new Set()); groups.get(k).add(m.id); }
  for (const m of d.maps) idx.group.set(m.id, groups.get(key(m)));
  const hidden = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: false, configurable: true });
  for (const t of d.tasks) {
    idx.task.set(t.id, t);
    const maps = new Set();
    if (t.map) maps.add(t.map);
    for (const o of t.objectives) {
      const om = new Set([...(o.maps || []), ...(o.zones || []).map((z) => z.map), ...(o.possibleLocations || []).map((l) => l.map)]);
      hidden(o, '_maps', om);
      om.forEach((m) => maps.add(m));
    }
    hidden(t, '_maps', maps);
    for (const r of t.taskRequirements || []) {
      const rid = idOf(r.task);
      if (!idx.next.has(rid)) idx.next.set(rid, []);
      idx.next.get(rid).push(t.id);
    }
  }
  for (const t of d.tasks) {
    hidden(t, '_hay', [t.name, trader(t.trader).name, ...mapNames(t), ...t.objectives.map(objText), ...t.objectives.flatMap((o) => objItems(o).map((id) => item(id).n))].join(' ').toLowerCase());
  }
}

export const item = (id) => S.data?.items?.[id] || { n: id, s: id, i: null };
export const trader = (id) => idx.trader.get(id) || { name: '?', imageLink: '' };
export const statusOf = (id) => S.state?.status?.[id]?.status || 'locked';
export const statusInfo = (id) => S.state?.status?.[id] || {};
export const isTracked = (id) => !!S.state?.profile?.tracked?.includes(id);
export const objCount = (o) => (COUNTABLE.has(o.type) && o.count > 1 ? o.count : 0);
export function objProgress(t, o) {
  const c = objCount(o);
  if (statusOf(t.id) === 'complete' || S.state?.profile?.objectives?.[o.id]) return c;
  return Math.min(c, S.state?.profile?.counters?.[o.id] || 0);
}
export const objDone = (t, o) => statusOf(t.id) === 'complete' || !!S.state?.profile?.objectives?.[o.id]
  || (objCount(o) > 0 && (S.state?.profile?.counters?.[o.id] || 0) >= objCount(o));
export function taskPct(t) {
  const o = t.objectives.filter((x) => !x.optional);
  return o.length ? o.filter((x) => objDone(t, x)).length / o.length : 0;
}

export function mapByLogId(logId) {
  if (!S.data || !logId) return null;
  const k = String(logId).toLowerCase();
  return S.data.maps.find((m) => m.nameId?.toLowerCase() === k) || null;
}
export function defFor(m) {
  if (!m) return null;
  return S.mapDefs[m.normalizedName === 'ground-zero-tutorial' ? 'ground-zero' : m.normalizedName] || null;
}
export const selectableMaps = () => (S.data?.maps || []).filter((m) => defFor(m) && m.normalizedName !== 'ground-zero-tutorial')
  .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
export const sameMapIds = (mapId) => idx.group.get(mapId) || new Set([mapId]);
export const taskOnMap = (t, mapId) => { const ids = sameMapIds(mapId); for (const m of t._maps) if (ids.has(m)) return true; return false; };
export const objOnMap = (o, ids) => !o._maps.size || [...o._maps].some((m) => ids.has(m));
export const objHere = (o, ids) => [...o._maps].some((m) => ids.has(m));
export const mapNames = (t) => [...new Set([...t._maps].map((id) => idx.map.get(id)?.name).filter(Boolean))];
export const hasMapPoints = (o) => !!(o.zones?.length || o.possibleLocations?.length);
export const byTrader = (a, b) => trader(a.trader).name.localeCompare(trader(b.trader).name, 'ru') || a.name.localeCompare(b.name, 'ru');

export function objText(o) {
  if (o.description && o.description !== o.id) return o.description;
  const it = (id) => item(id).n;
  switch (o.type) {
    case 'giveItem': return `Передать: ${o.items?.map(it).slice(0, 3).join(' / ')}`;
    case 'findItem': return `Найти в рейде: ${o.items?.map(it).slice(0, 3).join(' / ')}`;
    case 'plantItem': return `Спрятать: ${o.items?.map(it)[0]}`;
    case 'mark': return 'Отметить маркером';
    case 'visit': return 'Посетить точку';
    case 'extract': return `Выжить и выйти${o.exitName ? ': ' + o.exitName : ''}`;
    case 'shoot': return `Уничтожить: ${(o.targetNames || []).join(', ')}`;
    case 'traderLevel': return `Уровень торговца ${trader(o.trader).name}: ${o.level}`;
    case 'skill': return `Умение ${o.skill}: ${o.level}`;
    default: return o.type;
  }
}

export function objItems(o) {
  const ids = [];
  if (o.items?.length) ids.push(...o.items.slice(0, 6));
  if (o.useAny?.length) ids.push(...o.useAny.slice(0, 4));
  if (o.questItem?.id) ids.push(o.questItem.id);
  if (o.markerItem) ids.push(idOf(o.markerItem));
  if (o.type === 'mark' && !o.markerItem) ids.push(MARKER_ITEM);
  if (o.item) ids.push(idOf(o.item));
  return ids;
}

export function prereqChain(taskId) {
  const out = new Set();
  const walk = (id) => {
    const t = idx.task.get(id); if (!t) return;
    for (const r of t.taskRequirements || []) {
      const rid = idOf(r.task);
      if (!(r.status || []).includes('complete') || out.has(rid)) continue;
      out.add(rid); walk(rid);
    }
  };
  walk(taskId);
  return [...out].filter((id) => statusOf(id) !== 'complete');
}

// задания для карты: закреплённые, на этой карте, на любой локации, доступные здесь
export function raidGroups(mapId) {
  const tracked = [], onMap = [], anywhere = [], avail = [];
  for (const t of S.data.tasks) {
    const st = statusOf(t.id);
    if (st === 'available') { if (taskOnMap(t, mapId)) avail.push(t); continue; }
    if (st !== 'active') continue;
    if (isTracked(t.id)) tracked.push(t);
    else if (taskOnMap(t, mapId)) onMap.push(t);
    else if (!t._maps.size) anywhere.push(t);
  }
  tracked.sort((a, b) => (taskOnMap(b, mapId) - taskOnMap(a, mapId)) || byTrader(a, b));
  return { tracked, onMap: onMap.sort(byTrader), anywhere: anywhere.sort(byTrader), avail: avail.sort(byTrader) };
}

// что взять в рейд для заданий на этой карте
export function bringList(tasks, ids) {
  const groups = { keys: new Map(), plant: new Map(), use: new Map(), wear: new Map(), find: new Map(), fir: new Map() };
  const add = (g, id, count, why, alts) => {
    if (!id) return;
    const cur = groups[g].get(id) || { id, count: 0, why: new Set(), alts: 0 };
    cur.count = g === 'keys' ? 1 : cur.count + (count || 1); // ключ нужен один
    cur.why.add(why); cur.alts = Math.max(cur.alts, alts || 0);
    groups[g].set(id, cur);
  };
  for (const t of tasks) {
    for (const nk of t.neededKeys || []) if (ids.has(nk.map)) add('keys', idOf(nk.keys[0]), 1, t.name, nk.keys.length - 1);
    for (const o of t.objectives) {
      if (objDone(t, o) || !objOnMap(o, ids)) continue;
      const left = objCount(o) ? objCount(o) - objProgress(t, o) : o.count;
      for (const alt of o.requiredKeys || []) { const a = Array.isArray(alt) ? alt : [alt]; add('keys', idOf(a[0]), 1, t.name, a.length - 1); }
      if (o.type === 'plantItem') add('plant', o.items?.[0], left, t.name, (o.items?.length || 1) - 1);
      if (o.type === 'mark') add('plant', idOf(o.markerItem) || MARKER_ITEM, 1, t.name);
      if (o.type === 'useItem') add('use', o.useAny?.[0], left, t.name, (o.useAny?.length || 1) - 1);
      for (const w of o.wearing || []) { const a = Array.isArray(w) ? w : [w]; add('wear', idOf(a[0]), 1, t.name, a.length - 1); }
      if (o.usingWeapon?.length) add('wear', idOf(o.usingWeapon[0]), 1, t.name, o.usingWeapon.length - 1);
      if (o.type === 'findQuestItem' && o.questItem?.id) add('find', o.questItem.id, o.count || 1, t.name);
      if (o.type === 'giveItem' && o.foundInRaid && o.items?.length === 1 && !MONEY.has(o.items[0])) add('fir', o.items[0], left, t.name);
    }
  }
  return groups;
}

export const built = (id) => S.state?.profile?.hideout?.[id] || 0;
export const owned = (id) => S.state?.profile?.owned?.[id] || 0;
export const maxLevel = (s) => (s.levels.length ? Math.max(...s.levels.map((l) => l.level)) : 0);
export function stationState(s) {
  const lvl = built(s.id);
  const next = s.levels.find((l) => l.level === lvl + 1);
  if (!next) return { lvl, next: null, state: 'max' };
  const stOk = next.stationLevelRequirements.every((r) => built(r.station) >= r.level);
  const items = next.itemRequirements.filter((r) => !MONEY.has(r.item));
  const have = items.filter((r) => owned(r.item) >= r.count).length;
  return { lvl, next, state: !stOk ? 'blocked' : have === items.length ? 'ready' : 'open', have, total: items.length };
}

// все нужные предметы: квесты и/или убежище
export function neededItems({ quests = 'active', hideout = 'next' } = {}) {
  const need = new Map();
  const add = (key, id, count, fir, src, label) => {
    if (count <= 0) return;
    const cur = need.get(key) || { key, id, count: 0, fir: false, sources: [], label };
    cur.count += count; cur.fir = cur.fir || fir; cur.sources.push(src);
    need.set(key, cur);
  };
  if (quests !== 'none') {
    for (const t of S.data.tasks) {
      const st = statusOf(t.id);
      if (quests === 'active' ? st !== 'active' : st === 'complete' || st === 'failed') continue;
      for (const o of t.objectives) {
        if (objDone(t, o)) continue;
        const left = objCount(o) ? objCount(o) - objProgress(t, o) : o.count || 1;
        const src = `${t.name} (${trader(t.trader).name})`;
        if (o.type === 'giveItem' && o.items?.length) {
          if (o.items.length === 1) add(o.items[0], o.items[0], left, !!o.foundInRaid, src);
          else add('obj:' + o.id, o.items[0], left, !!o.foundInRaid, src, objText(o));
        }
        if (o.type === 'plantItem' && o.items?.[0]) add(o.items[0], o.items[0], left, false, `${t.name} — закладка`);
        if (o.type === 'mark') add(MARKER_ITEM, idOf(o.markerItem) || MARKER_ITEM, 1, false, `${t.name} — метка`);
        if (o.type === 'useItem' && o.useAny?.[0]) add(o.useAny[0], o.useAny[0], left, false, `${t.name} — использовать`);
        if (o.type === 'buildWeapon' && o.item) add(idOf(o.item), idOf(o.item), 1, false, `${t.name} — сборка оружия`);
      }
    }
  }
  if (hideout !== 'none') {
    for (const s of S.data.hideout) {
      const lvl = built(s.id);
      for (const l of s.levels) {
        if (l.level <= lvl || (hideout === 'next' && l.level !== lvl + 1)) continue;
        for (const r of l.itemRequirements) add(r.item, r.item, r.count, r.fir, `${s.name} ур. ${l.level}`);
      }
    }
  }
  return [...need.values()];
}
