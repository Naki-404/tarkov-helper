// Интерактивная карта (Leaflet). Координаты — по открытому коду tarkov.dev (MIT): transform + coordinateRotation.
// Векторная основа — SVG из assets/maps (геометрия tarkov-dev-svg-maps, CC BY-NC-SA), оформление — map-theme.css.
// Здания находятся по геометрии этажей и следам зданий на земле; этаж переключается кликом по зданию.
/* global L */

const SVGNS = 'http://www.w3.org/2000/svg';
const ICON = {
  lock: '<svg viewBox="0 0 24 24"><path d="M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z"/></svg>',
  exit: '<svg viewBox="0 0 24 24"><path d="M13.34,8.17C12.41,8.17 11.65,7.4 11.65,6.47A1.69,1.69 0 0,1 13.34,4.78C14.28,4.78 15.04,5.54 15.04,6.47C15.04,7.4 14.28,8.17 13.34,8.17M10.3,19.93L4.37,18.75L4.71,17.05L8.86,17.9L10.21,11.04L8.69,11.64V14.5H7V10.54L11.4,8.67L12.07,8.59C12.67,8.59 13.17,8.93 13.5,9.44L14.36,10.79C15.04,12 16.39,12.82 18,12.82V14.5C16.14,14.5 14.44,13.67 13.34,12.4L12.84,14.94L14.61,16.63V23H12.92V17.9L11.14,16.21L10.3,19.93M21,23H19V3H6V16.82L4,16.4V1H21V23M6,23H4V19.85L6,20.27V23Z"/></svg>',
  // переход: две встречные стрелки
  transit: '<svg viewBox="0 0 24 24"><path d="M8,10V13H14V18H8V21L2,15.5L8,10M22,8.5L16,3V6H10V11H16V14L22,8.5Z"/></svg>',
  // спавн: человек
  spawn: '<svg viewBox="0 0 24 24"><path d="M12,2A2,2 0 0,1 14,4A2,2 0 0,1 12,6A2,2 0 0,1 10,4A2,2 0 0,1 12,2M10.5,7H13.5A2,2 0 0,1 15.5,9V14.5H14V22H10V14.5H8.5V9A2,2 0 0,1 10.5,7Z"/></svg>',
};

// Названия уровней SVG → по-русски
const LEVEL_NAMES = [
  [/^bunkers?$/i, 'Бункеры', -1, 'Б'], [/^(underground|basement)/i, 'Подвал', -1, 'П'], [/^technical/i, 'Техуровень', -1, 'Т'],
  [/^(first|ground)_?(floor|level)/i, '1 этаж', 1, '1'], [/^second/i, '2 этаж', 2, '2'], [/^third/i, '3 этаж', 3, '3'],
  [/^fourth/i, '4 этаж', 4, '4'], [/^fifth/i, '5 этаж', 5, '5'],
];
function levelInfo(id, layer) {
  for (const [re, name, order, short] of LEVEL_NAMES) if (re.test(id)) return { name, order, short };
  return { name: layer?.name || id.replace(/_/g, ' '), order: 9, short: '?' };
}

function applyRotation(latLng, rotation) {
  if (!latLng.lng && !latLng.lat) return L.latLng(0, 0);
  if (!rotation) return latLng;
  const a = (rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const { lng: x, lat: y } = latLng;
  return L.latLng(x * sin + y * cos, x * cos - y * sin);
}
function getCRS(def) {
  let scaleX = 1, scaleY = 1, marginX = 0, marginY = 0;
  if (def.transform) { scaleX = def.transform[0]; scaleY = def.transform[2] * -1; marginX = def.transform[1]; marginY = def.transform[3]; }
  return L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(scaleX, marginX, scaleY, marginY),
    projection: L.extend({}, L.Projection.LonLat, {
      project: (ll) => L.Projection.LonLat.project(applyRotation(ll, def.coordinateRotation)),
      unproject: (pt) => applyRotation(L.Projection.LonLat.unproject(pt), def.coordinateRotation * -1),
    }),
  });
}

const pos = (p) => [p.z, p.x];
const getBounds = (b) => L.latLngBounds([b[0][1], b[0][0]], [b[1][1], b[1][0]]);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FACTION = { pmc: 'ЧВК', scav: 'Дикие', shared: 'ЧВК и Дикие' };
const SHAPES = 'path,rect,polygon,polyline,circle,ellipse';
const mul = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
const matrixAttr = (m) => `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;

export class TarkovMap {
  constructor(el, api) {
    this.el = el;
    this.api = api;
    this.map = null;
    this.def = null;
    this.style = 'svg';
    this.floor = '';
    this.layersOn = { avail: false, quests: true, pmc: true, scav: false, transits: true, locks: false, labels: true, spawnPmc: false, spawnScav: false };
    this.groups = {};
    this.base = null;
    this.floorLayer = null;
    this.svgEl = null;
    this.svgRoot = null;
    this.questMarkers = new Map();
    this.taskMarkers = new Map();
    this.buildings = [];
    this.bState = new Map();       // building -> id уровня ('' — базовый)
    this.labelsRu = {};
    this.me = null;
    this.onPopupAction = null;
    this.shotsFor = null;
    this.exitMedia = null;
    this.onBuildings = null;
  }

  tr(text) { return this.labelsRu[text] || text; }

  destroy() {
    this.showHint(null);
    if (this.map) { this.map.remove(); this.map = null; }
    this.buildings = [];
    this.bState.clear();
    this.svgRoot = null;
  }

  load(def, mapData) {
    this.destroy();
    this.def = def;
    this.mapData = mapData;
    this.floor = '';
    this.me = null;
    if (!def) return;
    const maxZoom = Math.max(7, def.maxZoom || 6);
    const bounds = getBounds(def.bounds);
    this.map = L.map(this.el, {
      crs: getCRS(def), attributionControl: false, zoomControl: true, zoomSnap: 0.25, zoomDelta: 0.5,
      wheelPxPerZoomLevel: 90, minZoom: Math.max(0, (def.minZoom || 1) - 2), maxZoom, maxBounds: bounds.pad(0.5), maxBoundsViscosity: 0.6,
    });
    this.map.zoomControl.setPosition('topright');
    for (const k of ['badges', 'spawnPmc', 'spawnScav', 'avail', 'quests', 'questLocks', 'pmc', 'scav', 'transits', 'locks', 'labels', 'me']) this.groups[k] = L.layerGroup();
    for (const [k, g] of Object.entries(this.groups)) {
      const on = k === 'me' || k === 'badges' || (k === 'questLocks' ? this.layersOn.quests : this.layersOn[k]);
      if (on) g.addTo(this.map);
    }
    this.map.on('zoomend', () => this.scaleLabels());
    this.setStyle(def.svgPath ? (this.style || 'svg') : 'tile', true);
    this.map.fitBounds(bounds);
    setTimeout(() => { if (this.map) { this.map.invalidateSize(); this.map.fitBounds(bounds); } }, 80);
    this.drawStatic();
    this.map.on('popupopen', (e) => {
      const root = e.popup.getElement();
      root?.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => this.onPopupAction?.(b.dataset)));
    });
  }

  hasStyles() { return !!(this.def?.svgPath && this.def?.tilePath); }

  setStyle(style, initial) {
    if (!this.map || !this.def) return;
    if (style === 'svg' && !this.def.svgPath) style = 'tile';
    if (style === 'tile' && !this.def.tilePath) style = 'svg';
    this.style = style;
    this.bState.clear();
    this.groups.badges?.clearLayers();
    if (this.base) this.base.remove();
    if (this.floorLayer) { this.floorLayer.remove(); this.floorLayer = null; }
    const bounds = getBounds(this.def.bounds);
    const maxZoom = Math.max(7, this.def.maxZoom || 6);
    const def = this.def;
    this.buildings = [];
    this.svgRoot = null;
    if (style === 'tile') {
      // карты без векторной схемы (Лабиринт, Ледокол) и «спутник»: плитки, приглушённые под тему
      this.base = L.tileLayer(def.tilePath, { tileSize: def.tileSize || 256, bounds, maxZoom, maxNativeZoom: def.maxZoom, noWrap: true, className: def.svgPath ? 'th-sat' : 'th-tiles' });
      this.svgEl = null;
      this.base.addTo(this.map);
      this.onBuildings?.(0);
    } else {
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('xmlns', SVGNS);
      svg.classList.add('th-svg');
      this.svgEl = svg;
      this.base = L.svgOverlay(svg, def.svgBounds ? getBounds(def.svgBounds) : bounds, { interactive: false });
      this.base.addTo(this.map);
      this.api.getSvg(def.svgPath).then((txt) => {
        if (this.def !== def || this.svgEl !== svg) return;
        svg.innerHTML = txt;
        const root = svg.querySelector('svg');
        if (!root) return;
        svg.setAttribute('viewBox', root.getAttribute('viewBox') || '');
        for (const g of [...root.children].filter((c) => c.nodeName === 'g' && c.id)) {
          if (g.id === def.svgLayer || g.dataset.keepWithGroup === def.svgLayer) g.classList.add('base-layer');
          else g.classList.add('hidden-layer', 'overlay-layer');
        }
        requestAnimationFrame(() => { if (this.svgEl === svg) this.findBuildings(root); });
      }).catch(() => {
        if (this.def !== def) return;
        if (def.tilePath) this.setStyle('tile');
        else this.onError?.('Не удалось загрузить схему карты. Точки заданий и выходы всё равно показаны.');
      });
    }
    this.base.bringToBack?.();
    if (!initial && this.floor && style === 'tile') this.setFloor(this.floor);
  }

  // ---------- здания ----------
  shapeBox(el, inv) {
    let bb;
    try { bb = el.getBBox(); } catch { return null; }
    if (!bb.width && !bb.height) return null;
    const m = inv.multiply(el.getScreenCTM());
    const pts = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]].map(([x, y]) => mul(m, x, y));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys), m, el };
  }

  findBuildings(root) {
    const rootCTM = root.getScreenCTM();
    if (!rootCTM) return;
    const inv = rootCTM.inverse();
    const vb = root.viewBox.baseVal;
    const total = vb.width * vb.height;
    const area = (r) => (r.x2 - r.x1) * (r.y2 - r.y1);
    this.svgRoot = root;
    this.baseLabel = [...root.children].some((g) => g.classList?.contains('base-layer') && /^(first|ground)_?(floor|level)/i.test(g.id)) ? '1 этаж' : 'Снаружи';

    // 1) фигуры верхних/нижних уровней
    const levels = [...root.children].filter((g) => g.classList?.contains('overlay-layer'));
    const floorRects = [];
    for (const g of levels) {
      const layer = (this.def.layers || []).find((l) => l.svgLayer === g.id);
      const info = { id: g.id, ...levelInfo(g.id, layer), height: layer?.extents?.[0]?.height || null };
      g.classList.remove('hidden-layer');
      for (const el of g.querySelectorAll(SHAPES)) {
        const r = this.shapeBox(el, inv);
        if (r && area(r) > total * 1e-6) floorRects.push({ ...r, level: info });
      }
      g.classList.add('hidden-layer');
    }
    // 2) следы зданий на земле (класс building на базовом уровне) — по ним части одного здания объединяются
    const prints = [];
    for (const g of [...root.children].filter((c) => c.classList?.contains('base-layer'))) {
      for (const el of g.querySelectorAll(SHAPES)) {
        if (!(el.classList.contains('building') || el.closest('[id*="uilding" i]'))) continue;
        const r = this.shapeBox(el, inv);
        if (r && area(r) > total * 2e-6 && area(r) < total * 0.2) prints.push(r);
      }
    }
    // 3) объединение: фигуры этажей между собой + через общий след на земле
    const nodes = [...floorRects, ...prints];
    const parent = nodes.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const inter = (a, b) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    // этажи одного здания лежат друг над другом — заметное перекрытие; дома «стена к стене» только касаются
    for (let i = 0; i < floorRects.length; i++) {
      for (let j = i + 1; j < floorRects.length; j++) {
        const a = floorRects[i], b = floorRects[j];
        if (inter(a, b) > 0.3 * Math.min(area(a), area(b))) parent[find(i)] = find(j);
      }
    }
    // этаж лежит внутри следа по настоящей форме (дворы-колодцы не в счёт), а не по описанному прямоугольнику
    const inside = (p, r) => {
      if (!p.el.isPointInFill) return inter(p, r) > 0.5 * area(r);
      const back = p.m.inverse();
      let n = 0;
      for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const [x, y] = mul(back, r.x1 + (r.x2 - r.x1) * fx, r.y1 + (r.y2 - r.y1) * fy);
        try { if (p.el.isPointInFill(new DOMPoint(x, y))) n++; } catch { return inter(p, r) > 0.5 * area(r); }
      }
      return n >= 3;
    };
    // след на земле связывает части одного здания, но не целый квартал, нарисованный одной фигурой
    this._bigPrints = new Set();
    for (let p = 0; p < prints.length; p++) {
      const pi = floorRects.length + p;
      const hits = floorRects.map((r, i) => [r, i]).filter(([r]) => inter(prints[p], r) > 0.5 * area(r) && inside(prints[p], r));
      if (!hits.length) continue;
      const hx1 = Math.min(...hits.map(([r]) => r.x1)), hy1 = Math.min(...hits.map(([r]) => r.y1));
      const hx2 = Math.max(...hits.map(([r]) => r.x2)), hy2 = Math.max(...hits.map(([r]) => r.y2));
      const covered = (hx2 - hx1) * (hy2 - hy1);
      if (area(prints[p]) > 1.8 * covered) { this._bigPrints.add(prints[p]); continue; }
      for (const [, i] of hits) parent[find(pi)] = find(i);
    }
    const groups = new Map();
    nodes.forEach((n, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, { floors: [], prints: [] }); (i < floorRects.length ? groups.get(k).floors : groups.get(k).prints).push(n); });

    const hot = document.createElementNS(SVGNS, 'g');
    hot.setAttribute('id', 'th-hot');
    const dim = document.createElementNS(SVGNS, 'g');
    dim.setAttribute('id', 'th-dim');
    this.buildings = [];
    for (const { floors, prints: pr } of groups.values()) {
      if (!floors.length) continue; // след без этажей — обычная крыша
      const all = [...floors, ...pr];
      const rect = { x: Math.min(...all.map((r) => r.x1)), y: Math.min(...all.map((r) => r.y1)) };
      rect.w = Math.max(...all.map((r) => r.x2)) - rect.x; rect.h = Math.max(...all.map((r) => r.y2)) - rect.y;
      if (rect.w * rect.h < total * 2e-5) continue;
      const lv = new Map();
      for (const r of floors) lv.set(r.level.id, r.level);
      // контур здания: след на земле, а если его нет — фигуры самого крупного уровня
      let outline = pr;
      if (!outline.length) {
        const byLevel = new Map();
        for (const r of floors) { if (!byLevel.has(r.level.id)) byLevel.set(r.level.id, []); byLevel.get(r.level.id).push(r); }
        outline = [...byLevel.values()].sort((a, b) => b.reduce((s, r) => s + area(r), 0) - a.reduce((s, r) => s + area(r), 0))[0];
      }
      const b = { rect, levels: [...lv.values()].sort((a, c) => a.order - c.order), outline, name: this.buildingName(rect) };
      b.hot = this.outlineGroup(outline, 'th-bld');
      this.bindBuilding(b);
      hot.appendChild(b.hot);
      this.buildings.push(b);
    }
    // порядок: основа → затемнение под выбранным этажом → уровни → контуры для наведения
    const firstOverlay = [...root.children].find((c) => c.classList?.contains('overlay-layer'));
    root.insertBefore(dim, firstOverlay || null);
    root.appendChild(hot);
    this.dimEl = dim;
    this.onBuildings?.(this.buildings.length);
  }

  // копии фигур контура в координатах корня SVG
  outlineGroup(list, cls) {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', cls);
    for (const r of list) {
      const wrap = document.createElementNS(SVGNS, 'g');
      wrap.setAttribute('transform', matrixAttr(r.m));
      const c = r.el.cloneNode(false);
      c.removeAttribute('id'); c.removeAttribute('class'); c.removeAttribute('style'); c.removeAttribute('transform');
      wrap.appendChild(c);
      g.appendChild(wrap);
    }
    return g;
  }

  buildingName(rect) {
    for (const lb of this.def.labels || []) {
      if (!lb.position) continue;
      const s = this.toSvg({ x: lb.position[0], z: lb.position[1] });
      if (s && s.x >= rect.x && s.x <= rect.x + rect.w && s.y >= rect.y && s.y <= rect.y + rect.h) return this.tr(lb.text);
    }
    return null;
  }

  levelsOf(b) {
    return [...b.levels.map((l) => ({ id: l.id, name: l.name, short: l.short, order: l.order, height: l.height })),
      { id: '', name: this.baseLabel || 'Снаружи', short: this.baseLabel === '1 этаж' ? '1' : 'У', order: 0.5 }].sort((x, y) => x.order - y.order);
  }

  bindBuilding(b) {
    let down = null;
    const hint = (e) => {
      const lv = this.levelsOf(b);
      const cur = this.bState.get(b) || '';
      const name = lv.find((l) => l.id === cur)?.name;
      this.showHint(`${b.name ? b.name + ' · ' : ''}${name}\nэтажи: ${lv.map((l) => l.short).join(' ')} · клик — выше, правый клик — ниже`, e);
    };
    b.hot.addEventListener('mouseenter', (e) => { b.hot.classList.add('hover'); hint(e); });
    b.hot.addEventListener('mousemove', hint);
    b.hot.addEventListener('mouseleave', () => { b.hot.classList.remove('hover'); this.showHint(null); });
    b.hot.addEventListener('mousedown', (e) => { down = [e.clientX, e.clientY]; });
    const step = (e, dir) => {
      e.preventDefault(); e.stopPropagation();
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; // перетаскивание карты
      const lv = this.levelsOf(b);
      const i = Math.max(0, lv.findIndex((l) => l.id === (this.bState.get(b) || '')));
      this.setBuildingLevel(b, lv[(i + dir + lv.length) % lv.length].id);
      hint(e);
    };
    b.hot.addEventListener('click', (e) => step(e, 1));
    b.hot.addEventListener('contextmenu', (e) => step(e, -1));
  }

  showHint(text, e) {
    if (!this.hintEl) {
      if (!text) return;
      this.hintEl = document.createElement('div'); this.hintEl.className = 'map-hint'; this.el.parentElement.appendChild(this.hintEl);
    }
    if (!text) { this.hintEl.classList.add('hidden'); return; }
    const box = this.el.getBoundingClientRect();
    this.hintEl.textContent = text;
    this.hintEl.classList.remove('hidden');
    this.hintEl.style.left = (e.clientX - box.left + 16) + 'px';
    this.hintEl.style.top = (e.clientY - box.top + 16) + 'px';
  }

  resetBuildings() { this.bState.clear(); this.applyBuildingFloors(); }

  setBuildingLevel(b, levelId) {
    if (levelId) this.bState.set(b, levelId); else this.bState.delete(b);
    this.applyBuildingFloors();
  }

  // выбранные этажи — только внутри своих зданий; под ними основа затемняется, сами этажи подсвечены
  applyBuildingFloors() {
    const root = this.svgRoot;
    if (!root) return;
    root.querySelectorAll('clipPath.th-clip').forEach((c) => c.remove());
    this.dimEl.replaceChildren();
    const rootCTM = root.getScreenCTM();
    for (const g of [...root.children].filter((c) => c.classList?.contains('overlay-layer'))) {
      const users = [...this.bState].filter(([, id]) => id === g.id).map(([b]) => b);
      g.removeAttribute('clip-path');
      g.classList.toggle('th-active', users.length > 0);
      if (!users.length) { g.classList.add('hidden-layer'); continue; }
      g.classList.remove('hidden-layer'); // у скрытой группы нет матрицы преобразования — сначала показываем
      // прямоугольники зданий (с запасом) — из координат корня в координаты группы уровня
      const ctm = g.getScreenCTM();
      if (!ctm || !rootCTM) continue;
      const toGroup = ctm.inverse().multiply(rootCTM);
      const cp = document.createElementNS(SVGNS, 'clipPath');
      cp.setAttribute('id', 'th-clip-' + g.id);
      cp.setAttribute('class', 'th-clip');
      cp.setAttribute('clipPathUnits', 'userSpaceOnUse');
      for (const b of users) {
        const { x, y, w, h } = b.rect;
        const wrap = document.createElementNS(SVGNS, 'g');
        wrap.setAttribute('transform', matrixAttr(toGroup));
        const r = document.createElementNS(SVGNS, 'rect');
        r.setAttribute('x', x - w * 0.03); r.setAttribute('y', y - h * 0.03); r.setAttribute('width', w * 1.06); r.setAttribute('height', h * 1.06);
        wrap.appendChild(r);
        cp.appendChild(wrap);
      }
      root.appendChild(cp);
      g.setAttribute('clip-path', `url(#th-clip-${g.id})`);
    }
    for (const [b] of this.bState) this.dimEl.appendChild(this.outlineGroup(b.outline, 'th-dim-shape'));
    for (const b of this.buildings) b.hot.classList.toggle('active', this.bState.has(b));
    this.drawBadges();
    this.applyFloorToMarkers();
  }

  // плашка с этажом на здании
  drawBadges() {
    this.groups.badges.clearLayers();
    for (const [b, id] of this.bState) {
      const cur = this.levelsOf(b).find((l) => l.id === id);
      const c = this.fromSvg(b.rect.x + b.rect.w / 2, b.rect.y + b.rect.h / 2);
      if (!c || !cur) continue;
      const icon = L.divIcon({ className: 'mk', iconSize: [0, 0], html: `<div class="fbadge">${esc(cur.name)}</div>` });
      this.groups.badges.addLayer(L.marker(c, { icon, interactive: false, keyboard: false, zIndexOffset: -500 }));
    }
  }

  // ---------- пересчёт координат игра ↔ SVG ----------
  svgFrame() {
    const root = this.svgRoot || this.svgEl?.querySelector('svg');
    if (!this.map || !this.base?.getBounds || !root) return null;
    const bnd = this.base.getBounds();
    const corners = [bnd.getNorthWest(), bnd.getNorthEast(), bnd.getSouthWest(), bnd.getSouthEast()].map((c) => this.map.project(c, 0));
    return { minX: Math.min(...corners.map((c) => c.x)), maxX: Math.max(...corners.map((c) => c.x)), minY: Math.min(...corners.map((c) => c.y)), maxY: Math.max(...corners.map((c) => c.y)), vb: root.viewBox.baseVal };
  }
  toSvg(p) {
    const f = this.svgFrame();
    if (!f) return null;
    const q = this.map.project(L.latLng(pos(p)), 0);
    return { x: f.vb.x + ((q.x - f.minX) / (f.maxX - f.minX)) * f.vb.width, y: f.vb.y + ((q.y - f.minY) / (f.maxY - f.minY)) * f.vb.height };
  }
  fromSvg(x, y) {
    const f = this.svgFrame();
    if (!f) return null;
    return this.map.unproject(L.point(f.minX + ((x - f.vb.x) / f.vb.width) * (f.maxX - f.minX), f.minY + ((y - f.vb.y) / f.vb.height) * (f.maxY - f.minY)), 0);
  }

  // ---------- этажи кнопками (спутник, Лабиринт, Ледокол) ----------
  floors() { return (this.def?.layers || []).filter((l) => l.tilePath).map((l) => l.name); }

  setFloor(name) {
    this.floor = name;
    if (!this.map) return;
    if (this.floorLayer) { this.floorLayer.remove(); this.floorLayer = null; }
    const layer = (this.def.layers || []).find((l) => l.name === name);
    const baseEl = this.base?._container || this.base?._image;
    baseEl?.classList.remove('off-level');
    if (layer?.tilePath) {
      this.floorLayer = L.tileLayer(layer.tilePath, { tileSize: this.def.tileSize || 256, bounds: getBounds(this.def.bounds), maxZoom: Math.max(7, this.def.maxZoom), maxNativeZoom: this.def.maxZoom, noWrap: true, className: this.def.svgPath ? 'th-sat' : 'th-tiles' }).addTo(this.map);
      if (!layer.show) baseEl?.classList.add('off-level');
    }
    this.applyFloorToMarkers();
  }

  markerVisible(h) {
    for (const [b, id] of this.bState) {
      const s = this.toSvg(h.p);
      const { x, y, w, h: rh } = b.rect;
      if (!s || s.x < x || s.x > x + w || s.y < y || s.y > y + rh) continue;
      const lv = this.levelsOf(b).find((l) => l.id === id);
      if (!lv?.height) return true;
      return h.top >= lv.height[0] && h.bottom < lv.height[1];
    }
    const layer = (this.def.layers || []).find((l) => l.name === this.floor);
    if (!layer || !layer.extents) return true;
    for (const ex of layer.extents) {
      if (h.top >= ex.height[0] && h.bottom < ex.height[1]) {
        if (!ex.bounds) return true;
        for (const b of ex.bounds) {
          const x1 = Math.min(b[0][0], b[1][0]), x2 = Math.max(b[0][0], b[1][0]);
          const z1 = Math.min(b[0][1], b[1][1]), z2 = Math.max(b[0][1], b[1][1]);
          if (h.p.x >= x1 && h.p.x <= x2 && h.p.z >= z1 && h.p.z <= z2) return true;
        }
      }
    }
    return false;
  }

  applyFloorToMarkers() {
    if (!this.map) return;
    this.map.eachLayer((l) => {
      const h = l.options?.height;
      if (!h) return;
      const on = this.markerVisible(h);
      if (l.setOpacity) l.setOpacity(on ? 1 : 0.22);
      else if (l.setStyle) l.setStyle({ opacity: on ? 0.75 : 0.15, fillOpacity: on ? 0.05 : 0.01 });
    });
  }

  setLayer(key, on) {
    this.layersOn[key] = on;
    if (!this.map) return;
    const list = key === 'quests' ? [this.groups.quests, this.groups.questLocks] : [this.groups[key]];
    for (const g of list) { if (!g) continue; if (on) g.addTo(this.map); else g.remove(); }
    if (on) this.applyFloorToMarkers();
  }

  heightOpt(p, top, bottom) { return { top: top ?? p.y, bottom: bottom ?? p.y, p }; }

  // ---------- выходы, переходы, спавны, подписи ----------
  exitTooltip(item, kind) {
    const media = this.exitMedia?.(item, kind) || {};
    const img = media.images?.[0];
    const title = kind === 'transit' ? (item.description || 'Переход') : item.name;
    const sub = kind === 'transit' ? 'Переход на другую карту' : `Выход · ${FACTION[kind] || ''}`;
    const req = [item.switch ? 'нужен рубильник' : '', media.requirements].filter(Boolean).join(' · ');
    return `<div class="xt">${img ? `<img src="${esc(img.thumb)}" alt="">` : ''}<div class="xt-b"><b>${esc(title)}</b><span>${esc(sub)}</span>
      ${req ? `<em>${esc(req)}</em>` : ''}${media.notes ? `<small>${esc(media.notes.slice(0, 160))}</small>` : ''}
      ${media.images?.length ? '<small class="xt-k">клик — фото во весь экран</small>' : ''}</div></div>`;
  }

  drawStatic() {
    const m = this.mapData;
    const def = this.def;
    if (!this.map) return;
    for (const k of ['pmc', 'scav', 'transits', 'locks', 'labels', 'spawnPmc', 'spawnScav']) this.groups[k].clearLayers();
    const tip = { className: 'tt tt-x', direction: 'auto', offset: [14, 0], opacity: 1 };
    if (m) {
      for (const e of m.extracts || []) {
        if (!e.position) continue;
        const kind = e.faction === 'scav' ? 'scav' : e.faction === 'shared' ? 'shared' : 'pmc';
        const make = () => {
          const icon = L.divIcon({ className: 'mk', iconSize: [22, 22], iconAnchor: [11, 11], html: `<div class="mk-x ${kind}">${ICON.exit}</div>` });
          const mk = L.marker(pos(e.position), { icon, height: this.heightOpt(e.position, e.top, e.bottom), riseOnHover: true });
          mk.bindTooltip(() => this.exitTooltip(e, kind), tip);
          mk.on('click', () => this.onExitClick?.(e, kind));
          return mk;
        };
        if (kind !== 'scav') this.groups.pmc.addLayer(make());
        if (kind !== 'pmc') this.groups.scav.addLayer(make());
      }
      for (const t of m.transits || []) {
        if (!t.position) continue;
        const icon = L.divIcon({ className: 'mk', iconSize: [24, 24], iconAnchor: [12, 12], html: `<div class="mk-tr">${ICON.transit}</div>` });
        const mk = L.marker(pos(t.position), { icon, height: this.heightOpt(t.position, t.top, t.bottom), riseOnHover: true });
        mk.bindTooltip(() => this.exitTooltip(t, 'transit'), tip);
        mk.on('click', () => this.onExitClick?.(t, 'transit'));
        this.groups.transits.addLayer(mk);
      }
      for (const s of m.spawns || []) {
        const icon = L.divIcon({ className: 'mk', iconSize: [16, 16], iconAnchor: [8, 8], html: `<div class="mk-sp ${s.side}">${ICON.spawn}</div>` });
        const mk = L.marker(pos(s.position), { icon, height: this.heightOpt(s.position) })
          .bindTooltip(s.side === 'pmc' ? 'Спавн ЧВК' : 'Спавн Диких', { className: 'tt', direction: 'top', offset: [0, -8] });
        (s.side === 'pmc' ? this.groups.spawnPmc : this.groups.spawnScav).addLayer(mk);
      }
    }
    for (const lb of def.labels || []) {
      if (!lb.position) continue;
      const size = lb.size || 60;
      const icon = L.divIcon({ className: 'mk', iconSize: [0, 0],
        html: `<div class="mk-label" data-size="${size}" style="transform: translate(-50%,-50%) rotate(${lb.rotation || 0}deg)">${esc(this.tr(lb.text))}</div>` });
      this.groups.labels.addLayer(L.marker([lb.position[1], lb.position[0]], { icon, interactive: false, keyboard: false }));
    }
    this.scaleLabels();
    this.applyFloorToMarkers();
  }

  drawLocks(locks, keyInfo) {
    if (!this.map) return;
    this.groups.locks.clearLayers();
    this.groups.questLocks.clearLayers();
    for (const l of locks || []) {
      if (!l.position) continue;
      const k = keyInfo(l.key);
      const icon = L.divIcon({ className: 'mk', iconSize: [18, 18], iconAnchor: [9, 9], html: `<div class="mk-lock${k.need ? ' need' : ''}">${ICON.lock}</div>` });
      const tipHtml = `<b>${esc(k.name)}</b>${l.needsPower ? '<br>нужно питание' : ''}${k.need ? '<br>нужен для активного квеста' : ''}`;
      const make = () => L.marker(pos(l.position), { icon, height: this.heightOpt(l.position) }).bindTooltip(tipHtml, { className: 'tt', direction: 'top', offset: [0, -10] });
      this.groups.locks.addLayer(make());
      if (k.need) this.groups.questLocks.addLayer(make());
    }
    this.applyFloorToMarkers();
  }

  scaleLabels() {
    if (!this.map) return;
    const z = this.map.getZoom();
    const base = this.def?.minZoom || 1;
    this.el.querySelectorAll('.mk-label').forEach((n) => {
      const s = Number(n.dataset.size) || 60;
      const px = (s / 10) * Math.pow(1.45, z - base - 1);
      n.style.display = px < 7 ? 'none' : '';
      n.style.fontSize = Math.min(20, px) + 'px';
    });
  }

  // ---------- точки заданий ----------
  questTooltip(p) {
    const imgs = (this.shotsFor?.(p.taskId) || []).slice(0, 3);
    return `<div class="qt"><b>${esc(p.title)}</b><span>${esc(p.text)}</span>
      ${imgs.length ? `<div class="qt-shots">${imgs.map((i) => `<img src="${esc(i.thumb)}" alt="">`).join('')}</div><small>клик — все фото места</small>` : ''}</div>`;
  }

  drawQuests(points) {
    if (!this.map) return;
    this.groups.quests.clearLayers();
    this.groups.avail.clearLayers();
    this.questMarkers.clear();
    this.taskMarkers.clear();
    this.hl = null;
    this.el.classList.remove('hovering');
    for (const p of points) {
      if (!p.position) continue;
      const h = this.heightOpt(p.position, p.top, p.bottom);
      const grp = p.avail ? this.groups.avail : this.groups.quests;
      // зона, где засчитывается условие, — тонкий пунктир почти без заливки
      if (p.outline?.length > 2) {
        grp.addLayer(L.polygon(p.outline.map(pos), { className: 'qzone', color: p.avail ? '#8B5CF6' : p.done ? '#34D399' : '#2DD4EE', weight: 1, opacity: 0.75, dashArray: '4 4', fillOpacity: 0.05, interactive: false, height: h }));
      }
      const state = p.avail ? 'avail' : p.done ? 'done' : p.tracked ? 'tracked' : 'active';
      const isItem = p.kind === 'item';
      const sz = isItem ? 18 : 24;
      const icon = L.divIcon({ className: 'mk', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2], popupAnchor: [0, -12],
        html: `<div class="mq ${state}${isItem ? ' item' : ''}"><b>${esc(p.n ?? '')}</b><i class="mq-t t-${esc(p.type || 'visit')}"></i></div>` });
      const mk = L.marker(pos(p.position), { icon, height: h, riseOnHover: true, zIndexOffset: p.tracked ? 500 : 0 });
      mk.bindTooltip(() => this.questTooltip(p), { className: 'tt tt-q', direction: 'auto', offset: [14, 0], opacity: 1 });
      mk.bindPopup(() => `<div class="pop-title">${esc(p.title)}</div><div class="pop-sub">${esc(p.sub)}</div><div>${esc(p.text)}</div>
        <div class="btnrow">${p.avail ? '<span class="tag st-available">можно взять</span>' : `<button class="btn sm" data-act="toggleObj" data-id="${esc(p.objectiveId)}">${p.done ? 'Снять отметку' : 'Выполнено'}</button>`}
        ${(this.shotsFor?.(p.taskId) || []).length ? `<button class="btn sm" data-act="shots" data-id="${esc(p.taskId)}">Фото места</button>` : ''}
        <button class="btn sm" data-act="openTask" data-id="${esc(p.taskId)}">В досье</button></div>`, { maxWidth: 300 });
      grp.addLayer(mk);
      if (!this.taskMarkers.has(p.taskId)) this.taskMarkers.set(p.taskId, []);
      this.taskMarkers.get(p.taskId).push(mk);
      if (p.avail) continue;
      if (!this.questMarkers.has(p.objectiveId)) this.questMarkers.set(p.objectiveId, []);
      this.questMarkers.get(p.objectiveId).push(mk);
    }
    this.applyFloorToMarkers();
  }

  highlightTask(taskId) {
    if (this.hl === taskId || !this.map) return;
    if (this.hl) for (const m of this.taskMarkers.get(this.hl) || []) { m.getElement()?.querySelector('.mq')?.classList.remove('hl'); m.setZIndexOffset(0); }
    this.hl = taskId && this.taskMarkers.has(taskId) ? taskId : null;
    this.el.classList.toggle('hovering', !!this.hl);
    if (this.hl) for (const m of this.taskMarkers.get(this.hl)) { m.getElement()?.querySelector('.mq')?.classList.add('hl'); m.setZIndexOffset(2000); }
  }

  focusObjective(objectiveId) {
    const list = this.questMarkers.get(objectiveId);
    if (!list?.length || !this.map) return false;
    if (list.length === 1) this.map.flyTo(list[0].getLatLng(), Math.max(this.map.getZoom(), (this.def.maxZoom || 6) - 1), { duration: 0.6 });
    else this.map.flyToBounds(L.latLngBounds(list.map((m) => m.getLatLng())).pad(0.4), { duration: 0.6, maxZoom: this.def.maxZoom });
    setTimeout(() => {
      for (const m of list) m.getElement()?.querySelector('.mq')?.classList.add('focus');
      if (list.length === 1) list[0].openPopup();
    }, 650);
    setTimeout(() => { for (const m of list) m.getElement()?.querySelector('.mq')?.classList.remove('focus'); }, 3000);
    return true;
  }

  focusPoint(p) {
    if (!this.map || !p) return;
    this.map.flyTo(pos(p), Math.max(this.map.getZoom(), (this.def.maxZoom || 6) - 1), { duration: 0.6 });
  }

  fit() { if (this.map && this.def) this.map.flyToBounds(getBounds(this.def.bounds), { duration: 0.5 }); }

  setPlayer(p) {
    this.me = p;
    if (!this.map || !this.groups.me) return;
    this.groups.me.clearLayers();
    if (!p) return;
    let rot = this.def.coordinateRotation || 0;
    if (rot === 90 || rot === 270) rot += 180;
    const deg = (p.yaw ?? 0) + rot;
    const icon = L.divIcon({ className: 'mk', iconSize: [0, 0], html: `<div class="mk-me"><svg class="cone" viewBox="0 0 34 34" style="transform: rotate(${deg}deg)"><path d="M17 17 L9 1 A17 17 0 0 1 25 1 Z" fill="rgba(224,82,82,.45)"/></svg><div class="core"></div></div>` });
    this.groups.me.addLayer(L.marker(pos(p), { icon, zIndexOffset: 1000, interactive: false }));
  }
}
