// Интерактивная карта (Leaflet). Пересчёт игровых координат — по открытому коду tarkov.dev (MIT):
// transform + coordinateRotation из maps.json. Векторная основа — SVG tarkov.dev, но со своей темой,
// а здания находятся по геометрии этажей и переключаются кликом прямо на карте.
/* global L */

const LOCK_SVG = '<svg viewBox="0 0 24 24"><path d="M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z"/></svg>';
// выход: человек выбегает в дверь
const EXIT_SVG = '<svg viewBox="0 0 24 24"><path d="M13.34,8.17C12.41,8.17 11.65,7.4 11.65,6.47A1.69,1.69 0 0,1 13.34,4.78C14.28,4.78 15.04,5.54 15.04,6.47C15.04,7.4 14.28,8.17 13.34,8.17M10.3,19.93L4.37,18.75L4.71,17.05L8.86,17.9L10.21,11.04L8.69,11.64V14.5H7V10.54L11.4,8.67L12.07,8.59C12.67,8.59 13.17,8.93 13.5,9.44L14.36,10.79C15.04,12 16.39,12.82 18,12.82V14.5C16.14,14.5 14.44,13.67 13.34,12.4L12.84,14.94L14.61,16.63V23H12.92V17.9L11.14,16.21L10.3,19.93M21,23H19V3H6V16.82L4,16.4V1H21V23M6,23H4V19.85L6,20.27V23Z"/></svg>';
// переход между картами
const TRANSIT_SVG = '<svg viewBox="0 0 24 24"><path d="M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z"/></svg>';

// Своя тема векторной карты: геометрия — из SVG, цвета — свои (поверх стилей исходника)
const THEME = `
.land,.Base_Terrain{fill:#0E1A1F!important}
.trees,.wood,.green,.forest{fill:#10262A!important}
.water{fill:#0F2C44!important}
.rock{fill:#263039!important}
.cement,.structure{fill:#222C37!important}
.tarmac{fill:#2B3541!important}
.gravel{fill:#2E2A24!important}
.building{fill:#16202B!important;stroke:#2DD4EE!important;stroke-opacity:.28!important;stroke-width:.6px!important}
.floor{fill:#1E2B38!important;stroke:#2DD4EE!important;stroke-opacity:.55!important;stroke-width:.5px!important}
.locked{fill:#2A1E28!important;stroke:#F87171!important;stroke-opacity:.5!important;stroke-width:.5px!important}
.wall{fill:#7FA3B8!important}
.stairs{fill:#F2B544!important}
.road_tarmac{stroke:#36424F!important}
.road_gravel{stroke:#3D3529!important}
.railroad{stroke:#5A4034!important}
.fence{stroke:#2F4A48!important}
.powerline{stroke:#4A4421!important}
.danger,.danger_small{fill:#F87171!important;fill-opacity:.16!important;stroke:#F87171!important;stroke-opacity:.6!important}
.map_border{stroke:#2DD4EE!important;stroke-opacity:.35!important}
.misc,.chopper,.plane{fill:#2B3541!important}
.shadow{filter:none!important}
.th-hot{fill:transparent;stroke:transparent;pointer-events:all;cursor:pointer}
.th-hot:hover{fill:rgba(45,212,238,.07);stroke:#2DD4EE;stroke-width:1px;stroke-dasharray:3 2;vector-effect:non-scaling-stroke}
.th-hot.active{fill:transparent;stroke:#F2B544;stroke-width:1.5px;stroke-dasharray:none;vector-effect:non-scaling-stroke}
`;

// Названия уровней SVG → по-русски
const LEVEL_NAMES = [
  [/^(underground|basement|bunkers?)/i, 'Подвал', -1],
  [/^(first|ground)_?floor/i, '1 этаж', 1],
  [/^second/i, '2 этаж', 2], [/^third/i, '3 этаж', 3], [/^fourth/i, '4 этаж', 4], [/^fifth/i, '5 этаж', 5],
];
function levelInfo(id, layer) {
  for (const [re, name, order] of LEVEL_NAMES) if (re.test(id)) return { name: id === 'Bunkers' ? 'Бункеры' : name, order };
  return { name: layer?.name || id.replace(/_/g, ' '), order: 9 };
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
  if (def.transform) {
    scaleX = def.transform[0];
    scaleY = def.transform[2] * -1;
    marginX = def.transform[1];
    marginY = def.transform[3];
  }
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

export class TarkovMap {
  constructor(el, api) {
    this.el = el;
    this.api = api;
    this.map = null;
    this.def = null;
    this.style = 'svg';
    this.floor = '';
    this.layersOn = { avail: false, quests: true, pmc: true, scav: false, transits: true, locks: false, labels: true };
    this.groups = {};
    this.base = null;
    this.floorLayer = null;
    this.svgEl = null;
    this.svgReady = Promise.resolve();
    this.questMarkers = new Map(); // objectiveId -> [marker]
    this.taskMarkers = new Map();  // taskId -> [marker]
    this.buildings = [];           // [{ rect:{x,y,w,h}, levels:[{id,name,order,height}] , hot }]
    this.activeBuilding = null;    // { b, levelId }
    this.me = null;
    this.onPopupAction = null;
    this.shotsFor = null;          // taskId -> [{thumb,full,caption}]
    this.exitMedia = null;         // (extract|transit, kind) -> { images, requirements, notes }
    this.onBuildings = null;       // сообщить интерфейсу, что здания найдены (для подсказки)
  }

  destroy() {
    this.closeFloorMenu();
    if (this.map) { this.map.remove(); this.map = null; }
    this.buildings = [];
    this.activeBuilding = null;
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
    for (const k of ['avail', 'quests', 'questLocks', 'pmc', 'scav', 'transits', 'locks', 'labels', 'me']) this.groups[k] = L.layerGroup();
    for (const [k, g] of Object.entries(this.groups)) {
      const on = k === 'me' || (k === 'questLocks' ? this.layersOn.quests : this.layersOn[k]);
      if (on) g.addTo(this.map);
    }
    this.map.on('zoomend', () => this.scaleLabels());
    this.map.on('movestart zoomstart', () => this.closeFloorMenu());
    this.map.on('click', () => this.closeFloorMenu());
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
  // этажи кликом по зданию — только на векторной схеме; на спутнике/плитках — кнопками
  usesBuildings() { return this.style === 'svg' && !!this.svgEl && this.buildings.length > 0; }

  setStyle(style, initial) {
    if (!this.map || !this.def) return;
    if (style === 'svg' && !this.def.svgPath) style = 'tile';
    if (style === 'tile' && !this.def.tilePath) style = 'svg';
    this.style = style;
    this.closeFloorMenu();
    this.activeBuilding = null;
    if (this.base) this.base.remove();
    if (this.floorLayer) { this.floorLayer.remove(); this.floorLayer = null; }
    const bounds = getBounds(this.def.bounds);
    const maxZoom = Math.max(7, this.def.maxZoom || 6);
    const def = this.def;
    this.buildings = [];
    if (style === 'tile') {
      this.base = L.tileLayer(def.tilePath, { tileSize: def.tileSize || 256, bounds, maxZoom, maxNativeZoom: def.maxZoom, noWrap: true });
      this.svgEl = null;
      this.base.addTo(this.map);
      this.onBuildings?.(0);
    } else {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.style.pointerEvents = 'none';
      this.svgEl = svg;
      this.base = L.svgOverlay(svg, def.svgBounds ? getBounds(def.svgBounds) : bounds, { interactive: false });
      this.base.addTo(this.map);
      this.svgReady = this.api.getSvg(def.svgPath).then((txt) => {
        if (this.def !== def || this.svgEl !== svg) return;
        svg.innerHTML = txt;
        const root = svg.children[0];
        if (!root) return;
        svg.setAttribute('viewBox', root.getAttribute('viewBox') || '');
        const st = document.createElementNS('http://www.w3.org/2000/svg', 'style');
        st.textContent = THEME;
        root.appendChild(st);
        for (const g of [...root.children].filter((c) => c.nodeName === 'g' && c.id)) {
          if (g.id === def.svgLayer || g.dataset.keepWithGroup === def.svgLayer) g.classList.add('base-layer');
          else g.classList.add('hidden-layer', 'overlay-layer');
        }
        // здания ищем после того, как SVG попал в документ и получил размеры
        requestAnimationFrame(() => { if (this.svgEl === svg) this.findBuildings(root); });
      }).catch(() => {
        if (this.def !== def) return;
        if (def.tilePath) this.setStyle('tile');
        else this.onError?.('Не удалось загрузить схему карты — проверь интернет. Точки заданий и выходы всё равно показаны.');
      });
    }
    this.base.bringToBack?.();
    if (!initial && this.floor && style === 'tile') this.setFloor(this.floor);
  }

  // ---------- здания и этажи ----------
  // Фигуры каждого уровня (этажа) объединяются в здания по пересечению прямоугольников.
  findBuildings(root) {
    const rootCTM = root.getScreenCTM();
    if (!rootCTM) return;
    const inv = rootCTM.inverse();
    const vb = root.viewBox.baseVal;
    const minArea = (vb.width * vb.height) * 2e-5;
    const levels = [...root.children].filter((g) => g.classList?.contains('overlay-layer'));
    // первый этаж нарисован вместе с улицей (keep-with-group) — тогда базовый уровень и есть «1 этаж»
    this.baseLabel = [...root.children].some((g) => g.classList?.contains('base-layer') && /^(first|ground)_?floor/i.test(g.id)) ? '1 этаж' : 'Снаружи';
    const rects = [];
    for (const g of levels) {
      const layer = (this.def.layers || []).find((l) => l.svgLayer === g.id);
      const info = levelInfo(g.id, layer);
      const height = layer?.extents?.[0]?.height || null;
      g.classList.remove('hidden-layer'); // getBBox у скрытых элементов — нули
      for (const el of g.querySelectorAll('path,rect,polygon,polyline,circle,ellipse')) {
        let bb;
        try { bb = el.getBBox(); } catch { continue; }
        if (!bb.width && !bb.height) continue;
        const m = inv.multiply(el.getScreenCTM());
        const pts = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]
          .map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const r = { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
        if ((r.x2 - r.x1) * (r.y2 - r.y1) < minArea / 20) continue; // мелочь (лестницы, точки) сама по себе — не здание
        rects.push({ ...r, level: { id: g.id, ...info, height } });
      }
      g.classList.add('hidden-layer');
    }
    // объединение пересекающихся прямоугольников (с небольшим запасом)
    const pad = Math.max(vb.width, vb.height) * 0.002;
    const parent = rects.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        if (a.x1 - pad <= b.x2 && b.x1 - pad <= a.x2 && a.y1 - pad <= b.y2 && b.y1 - pad <= a.y2) parent[find(i)] = find(j);
      }
    }
    const groups = new Map();
    rects.forEach((r, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    const hot = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    hot.setAttribute('id', 'th-hotspots');
    this.buildings = [];
    for (const list of groups.values()) {
      const x1 = Math.min(...list.map((r) => r.x1)), y1 = Math.min(...list.map((r) => r.y1));
      const x2 = Math.max(...list.map((r) => r.x2)), y2 = Math.max(...list.map((r) => r.y2));
      if ((x2 - x1) * (y2 - y1) < minArea) continue;
      const lv = new Map();
      for (const r of list) lv.set(r.level.id, r.level);
      const levelsList = [...lv.values()].sort((a, b) => a.order - b.order);
      const b = { rect: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, levels: levelsList };
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', 'th-hot');
      rect.setAttribute('x', x1); rect.setAttribute('y', y1); rect.setAttribute('width', x2 - x1); rect.setAttribute('height', y2 - y1);
      b.hot = rect;
      this.bindBuilding(b);
      hot.appendChild(rect);
      this.buildings.push(b);
    }
    root.appendChild(hot);
    this.svgRoot = root;
    this.onBuildings?.(this.buildings.length);
  }

  bindBuilding(b) {
    let down = null;
    const tipText = () => `${[this.baseLabel || 'Снаружи', ...b.levels.map((l) => l.name)].join(' · ')} — клик: этаж`;
    b.hot.addEventListener('mouseenter', (e) => this.showHint(tipText(), e));
    b.hot.addEventListener('mousemove', (e) => this.showHint(tipText(), e));
    b.hot.addEventListener('mouseleave', () => this.showHint(null));
    b.hot.addEventListener('mousedown', (e) => { down = [e.clientX, e.clientY]; });
    b.hot.addEventListener('click', (e) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; // это было перетаскивание карты
      e.stopPropagation();
      this.showHint(null);
      this.openFloorMenu(b, e);
    });
  }

  showHint(text, e) {
    if (!this.hintEl) { this.hintEl = document.createElement('div'); this.hintEl.className = 'map-hint'; this.el.parentElement.appendChild(this.hintEl); }
    if (!text) { this.hintEl.classList.add('hidden'); return; }
    const box = this.el.getBoundingClientRect();
    this.hintEl.textContent = text;
    this.hintEl.classList.remove('hidden');
    this.hintEl.style.left = (e.clientX - box.left + 14) + 'px';
    this.hintEl.style.top = (e.clientY - box.top + 14) + 'px';
  }

  openFloorMenu(b, e) {
    this.closeFloorMenu();
    const box = this.el.getBoundingClientRect();
    const cur = this.activeBuilding?.b === b ? this.activeBuilding.levelId : null;
    const menu = document.createElement('div');
    menu.className = 'floor-menu';
    const items = [...b.levels.map((l) => ({ id: l.id, name: l.name, order: l.order })), { id: '', name: this.baseLabel || 'Снаружи', order: 0.5 }].sort((x, y) => x.order - y.order);
    menu.innerHTML = `<div class="fm-title">Этаж здания</div>` + items.map((l) => `<button data-lv="${esc(l.id)}" class="${(cur || '') === l.id ? 'on' : ''}">${esc(l.name)}</button>`).join('');
    menu.style.left = Math.min(e.clientX - box.left, box.width - 150) + 'px';
    menu.style.top = Math.min(e.clientY - box.top, box.height - 40 - 30 * (b.levels.length + 1)) + 'px';
    menu.addEventListener('mousedown', (ev) => ev.stopPropagation());
    menu.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const btn = ev.target.closest('[data-lv]');
      if (!btn) return;
      this.setBuildingFloor(b, btn.dataset.lv || null);
      this.closeFloorMenu();
    });
    L.DomEvent.disableScrollPropagation(menu);
    this.el.parentElement.appendChild(menu);
    this.menuEl = menu;
  }

  closeFloorMenu() { this.menuEl?.remove(); this.menuEl = null; }

  // показать один этаж одного здания (остальная карта — как была)
  setBuildingFloor(b, levelId) {
    const root = this.svgRoot;
    if (!root) return;
    for (const g of root.children) {
      if (!g.classList?.contains('overlay-layer')) continue;
      g.classList.add('hidden-layer');
      g.removeAttribute('clip-path');
    }
    root.querySelector('#th-clip')?.remove();
    for (const x of this.buildings) x.hot.classList.remove('active');
    this.activeBuilding = levelId ? { b, levelId } : null;
    if (levelId) {
      const g = [...root.children].find((c) => c.id === levelId);
      if (g) {
        // прямоугольник здания — из координат корня в координаты группы этажа
        const m = g.getScreenCTM().inverse().multiply(root.getScreenCTM());
        const { x, y, w, h } = b.rect;
        const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => [m.a * px + m.c * py + m.e, m.b * px + m.d * py + m.f]);
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const cp = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
        cp.setAttribute('id', 'th-clip');
        cp.setAttribute('clipPathUnits', 'userSpaceOnUse');
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        const padX = (Math.max(...xs) - Math.min(...xs)) * 0.02, padY = (Math.max(...ys) - Math.min(...ys)) * 0.02;
        r.setAttribute('x', Math.min(...xs) - padX); r.setAttribute('y', Math.min(...ys) - padY);
        r.setAttribute('width', Math.max(...xs) - Math.min(...xs) + 2 * padX); r.setAttribute('height', Math.max(...ys) - Math.min(...ys) + 2 * padY);
        cp.appendChild(r);
        root.appendChild(cp);
        g.setAttribute('clip-path', 'url(#th-clip)');
        g.classList.remove('hidden-layer');
      }
      b.hot.classList.add('active');
    }
    this.applyFloorToMarkers();
  }

  // игровая точка → координаты SVG (для проверки «точка внутри здания»)
  toSvg(p) {
    if (!this.map || !this.base?.getBounds || !this.svgRoot) return null;
    const bnd = this.base.getBounds();
    const corners = [bnd.getNorthWest(), bnd.getNorthEast(), bnd.getSouthWest(), bnd.getSouthEast()].map((c) => this.map.project(c, 0));
    const minX = Math.min(...corners.map((c) => c.x)), maxX = Math.max(...corners.map((c) => c.x));
    const minY = Math.min(...corners.map((c) => c.y)), maxY = Math.max(...corners.map((c) => c.y));
    const q = this.map.project(L.latLng(pos(p)), 0);
    const vb = this.svgRoot.viewBox.baseVal;
    return { x: vb.x + ((q.x - minX) / (maxX - minX)) * vb.width, y: vb.y + ((q.y - minY) / (maxY - minY)) * vb.height };
  }

  // ---------- этажи кнопками (спутник и карты без схемы) ----------
  floors() { return (this.def?.layers || []).filter((l) => l.svgLayer || l.tilePath).map((l) => l.name); }

  setFloor(name) {
    this.floor = name;
    if (!this.map) return;
    if (this.floorLayer) { this.floorLayer.remove(); this.floorLayer = null; }
    const layer = (this.def.layers || []).find((l) => l.name === name);
    const baseEl = this.base?._image || this.base?._container;
    baseEl?.classList.remove('off-level');
    if (layer?.tilePath) {
      this.floorLayer = L.tileLayer(layer.tilePath, { tileSize: this.def.tileSize || 256, bounds: getBounds(this.def.bounds), maxZoom: Math.max(7, this.def.maxZoom), maxNativeZoom: this.def.maxZoom, noWrap: true }).addTo(this.map);
      if (!layer.show) baseEl?.classList.add('off-level');
    }
    this.applyFloorToMarkers();
  }

  // Видимость точки по этажу: в выбранном здании — только точки этого этажа, остальные приглушены
  markerVisible(h) {
    if (this.activeBuilding) {
      const s = this.toSvg(h.p);
      const { x, y, w, h: rh } = this.activeBuilding.b.rect;
      if (!s || s.x < x || s.x > x + w || s.y < y || s.y > y + rh) return true;
      const lv = this.activeBuilding.b.levels.find((l) => l.id === this.activeBuilding.levelId);
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
      if (l.setOpacity) l.setOpacity(on ? 1 : 0.25);
      else if (l.setStyle) l.setStyle({ opacity: on ? 0.9 : 0.2, fillOpacity: on ? 0.14 : 0.04 });
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

  // ---------- выходы, переходы, подписи ----------
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
    for (const k of ['pmc', 'scav', 'transits', 'locks', 'labels']) this.groups[k].clearLayers();
    if (m) {
      for (const e of m.extracts || []) {
        if (!e.position) continue;
        const kind = e.faction === 'scav' ? 'scav' : e.faction === 'shared' ? 'shared' : 'pmc';
        const make = () => {
          const icon = L.divIcon({ className: 'mk', iconSize: [22, 22], iconAnchor: [11, 11], html: `<div class="mk-x ${kind}">${EXIT_SVG}</div>` });
          const mk = L.marker(pos(e.position), { icon, height: this.heightOpt(e.position, e.top, e.bottom), riseOnHover: true });
          mk.bindTooltip(() => this.exitTooltip(e, kind), { className: 'tt tt-x', direction: 'auto', offset: [14, 0], opacity: 1 });
          mk.on('click', () => this.onExitClick?.(e, kind));
          return mk;
        };
        if (kind !== 'scav') this.groups.pmc.addLayer(make());
        if (kind !== 'pmc') this.groups.scav.addLayer(make());
      }
      for (const t of m.transits || []) {
        if (!t.position) continue;
        const icon = L.divIcon({ className: 'mk', iconSize: [22, 22], iconAnchor: [11, 11], html: `<div class="mk-x transit">${TRANSIT_SVG}</div>` });
        const mk = L.marker(pos(t.position), { icon, height: this.heightOpt(t.position, t.top, t.bottom), riseOnHover: true });
        mk.bindTooltip(() => this.exitTooltip(t, 'transit'), { className: 'tt tt-x', direction: 'auto', offset: [14, 0], opacity: 1 });
        mk.on('click', () => this.onExitClick?.(t, 'transit'));
        this.groups.transits.addLayer(mk);
      }
    }
    for (const lb of def.labels || []) {
      if (!lb.position) continue;
      const size = lb.size || 60;
      const icon = L.divIcon({ className: 'mk', iconSize: [0, 0],
        html: `<div class="mk-label" data-size="${size}" style="transform: translate(-50%,-50%) rotate(${lb.rotation || 0}deg)">${esc(lb.text)}</div>` });
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
      const icon = L.divIcon({ className: 'mk', iconSize: [18, 18], iconAnchor: [9, 9], html: `<div class="mk-lock${k.need ? ' need' : ''}">${LOCK_SVG}</div>` });
      const tip = `<b>${esc(k.name)}</b>${l.needsPower ? '<br>нужно питание' : ''}${k.need ? '<br>нужен для активного квеста' : ''}`;
      const make = () => L.marker(pos(l.position), { icon, height: this.heightOpt(l.position) }).bindTooltip(tip, { className: 'tt', direction: 'top', offset: [0, -10] });
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
      if (p.outline?.length > 2) {
        grp.addLayer(L.polygon(p.outline.map(pos), { color: p.avail ? '#8B5CF6' : p.done ? '#34D399' : '#2DD4EE', weight: 1.5, opacity: 0.9, fillOpacity: 0.12, interactive: false, height: h }));
      }
      const sz = p.avail ? 16 : 22;
      const icon = L.divIcon({ className: 'mk', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2], popupAnchor: [0, -12],
        html: `<div class="mk-q${p.kind === 'item' ? ' item' : ''}${p.done ? ' done' : ''}${p.avail ? ' avail' : ''}${p.tracked ? ' tracked' : ''}">${esc(p.n ?? '')}</div>` });
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
    if (this.hl) for (const m of this.taskMarkers.get(this.hl) || []) { m.getElement()?.querySelector('.mk-q')?.classList.remove('hl'); m.setZIndexOffset(0); }
    this.hl = taskId && this.taskMarkers.has(taskId) ? taskId : null;
    this.el.classList.toggle('hovering', !!this.hl);
    if (this.hl) for (const m of this.taskMarkers.get(this.hl)) { m.getElement()?.querySelector('.mk-q')?.classList.add('hl'); m.setZIndexOffset(2000); }
  }

  focusObjective(objectiveId) {
    const list = this.questMarkers.get(objectiveId);
    if (!list?.length || !this.map) return false;
    if (list.length === 1) this.map.flyTo(list[0].getLatLng(), Math.max(this.map.getZoom(), (this.def.maxZoom || 6) - 1), { duration: 0.6 });
    else this.map.flyToBounds(L.latLngBounds(list.map((m) => m.getLatLng())).pad(0.4), { duration: 0.6, maxZoom: this.def.maxZoom });
    setTimeout(() => {
      for (const m of list) m.getElement()?.querySelector('.mk-q')?.classList.add('focus');
      if (list.length === 1) list[0].openPopup();
    }, 650);
    setTimeout(() => { for (const m of list) m.getElement()?.querySelector('.mk-q')?.classList.remove('focus'); }, 3000);
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
