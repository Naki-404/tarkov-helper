// Интерактивная карта (Leaflet). Пересчёт игровых координат в координаты карты —
// по открытому коду tarkov.dev (MIT): transform + coordinateRotation из maps.json.
/* global L */

const LOCK_SVG = '<svg viewBox="0 0 24 24"><path d="M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z"/></svg>';

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
    this.taskMarkers = new Map();  // taskId -> [marker] — для подсветки при наведении на карточку
    this.me = null;
    this.onPopupAction = null;
  }

  destroy() {
    if (this.map) { this.map.remove(); this.map = null; }
  }

  // def — описание из mapdefs.json, mapData — карта из данных tarkov.dev
  load(def, mapData) {
    this.destroy();
    this.def = def;
    this.mapData = mapData;
    this.floor = '';
    this.me = null; // позиция с другой карты не переносится
    if (!def) return;
    const maxZoom = Math.max(7, def.maxZoom || 6);
    const bounds = getBounds(def.bounds);
    this.map = L.map(this.el, {
      crs: getCRS(def), attributionControl: false, zoomControl: true, zoomSnap: 0.25, zoomDelta: 0.5,
      // на 2 уровня меньше, чем у tarkov.dev: большие карты (Лес, Берег) целиком влезают в небольшое окно
      wheelPxPerZoomLevel: 90, minZoom: Math.max(0, (def.minZoom || 1) - 2), maxZoom, maxBounds: bounds.pad(0.5), maxBoundsViscosity: 0.6,
      preferCanvas: false,
    });
    this.map.zoomControl.setPosition('topright');
    for (const k of ['avail', 'quests', 'questLocks', 'pmc', 'scav', 'transits', 'locks', 'labels', 'me']) this.groups[k] = L.layerGroup();
    for (const [k, g] of Object.entries(this.groups)) {
      const on = k === 'me' || (k === 'questLocks' ? this.layersOn.quests : this.layersOn[k]);
      if (on) g.addTo(this.map);
    }
    this.map.on('zoomend', () => this.scaleLabels());
    this.setStyle(def.svgPath ? (this.style || 'svg') : 'tile', true);
    this.map.fitBounds(bounds);
    // контейнер мог ещё не получить размер (вкладка только что открылась)
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
    if (this.base) this.base.remove();
    if (this.floorLayer) { this.floorLayer.remove(); this.floorLayer = null; }
    const bounds = getBounds(this.def.bounds);
    const maxZoom = Math.max(7, this.def.maxZoom || 6);
    const def = this.def;
    if (style === 'tile') {
      this.base = L.tileLayer(this.def.tilePath, { tileSize: this.def.tileSize || 256, bounds, maxZoom, maxNativeZoom: this.def.maxZoom, noWrap: true });
      this.svgEl = null;
    } else {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      this.svgEl = svg;
      this.svgReady = this.api.getSvg(this.def.svgPath).then((txt) => {
        svg.innerHTML = txt;
        const root = svg.children[0];
        if (!root) return;
        svg.setAttribute('viewBox', root.getAttribute('viewBox') || '');
        for (const g of [...root.children].filter((c) => c.nodeName === 'g' && c.id)) {
          if (g.id === this.def.svgLayer || g.dataset.keepWithGroup === this.def.svgLayer) g.classList.add('base-layer');
          else g.classList.add('hidden-layer', 'overlay-layer');
        }
      }).catch(() => {
        if (this.def !== def) return; // уже открыта другая карта
        if (def.tilePath) this.setStyle('tile');
        else this.onError?.('Не удалось загрузить схему карты — проверь интернет. Точки заданий и выходы всё равно показаны.');
      });
      this.base = L.svgOverlay(svg, this.def.svgBounds ? getBounds(this.def.svgBounds) : bounds, { interactive: false });
    }
    this.base.addTo(this.map);
    this.base.bringToBack?.();
    if (!initial && this.floor) this.setFloor(this.floor);
  }

  floors() { return (this.def?.layers || []).filter((l) => l.svgLayer || l.tilePath).map((l) => l.name); }

  setFloor(name) {
    this.floor = name;
    if (!this.map) return;
    if (this.floorLayer) { this.floorLayer.remove(); this.floorLayer = null; }
    const layer = (this.def.layers || []).find((l) => l.name === name);
    const baseEl = this.base?._image || this.base?._container;
    baseEl?.classList.remove('off-level');
    if (this.svgEl) {
      this.svgReady.then(() => {
        const root = this.svgEl.children[0];
        if (!root) return;
        for (const g of root.children) {
          if (!g.classList.contains('overlay-layer')) continue;
          g.classList.toggle('hidden-layer', !(layer && g.id === layer.svgLayer));
        }
      });
    }
    if (layer) {
      const useTile = (this.style === 'tile' || !layer.svgLayer) && layer.tilePath;
      if (useTile) {
        this.floorLayer = L.tileLayer(layer.tilePath, { tileSize: this.def.tileSize || 256, bounds: getBounds(this.def.bounds), maxZoom: Math.max(7, this.def.maxZoom), maxNativeZoom: this.def.maxZoom, noWrap: true }).addTo(this.map);
      }
      if (!layer.show) baseEl?.classList.add('off-level');
    }
    this.applyFloorToMarkers();
  }

  // Видимость маркера по высоте (как на tarkov.dev): на выбранном этаже — ярко, остальные — тусклее
  markerOnFloor(top, bottom, p) {
    const layer = (this.def.layers || []).find((l) => l.name === this.floor);
    if (!layer || !layer.extents) return true;
    for (const ex of layer.extents) {
      if (top >= ex.height[0] && bottom < ex.height[1]) {
        if (!ex.bounds) return true;
        for (const b of ex.bounds) {
          const x1 = Math.min(b[0][0], b[1][0]), x2 = Math.max(b[0][0], b[1][0]);
          const z1 = Math.min(b[0][1], b[1][1]), z2 = Math.max(b[0][1], b[1][1]);
          if (p.x >= x1 && p.x <= x2 && p.z >= z1 && p.z <= z2) return true;
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
      const on = this.markerOnFloor(h.top, h.bottom, h.p);
      if (l.setOpacity) l.setOpacity(on ? 1 : 0.28);
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

  heightOpt(p, top, bottom) {
    return { top: top ?? p.y, bottom: bottom ?? p.y, p };
  }

  drawStatic() {
    const m = this.mapData;
    const def = this.def;
    for (const k of ['pmc', 'scav', 'transits', 'locks', 'labels']) this.groups[k].clearLayers();
    if (m) {
      for (const e of m.extracts || []) {
        if (!e.position) continue;
        const kind = e.faction === 'scav' ? 'scav' : e.faction === 'shared' ? 'shared' : 'pmc';
        const grp = kind === 'scav' ? this.groups.scav : this.groups.pmc;
        const icon = L.divIcon({ className: 'mk', html: `<div class="mk-exit ${kind}">${esc(e.name)}</div>`, iconSize: [0, 0] });
        const mk = L.marker(pos(e.position), { icon, height: this.heightOpt(e.position, e.top, e.bottom), riseOnHover: true });
        mk.bindTooltip(`${esc(e.name)} · ${kind === 'scav' ? 'Дикие' : kind === 'shared' ? 'Общий' : 'ЧВК'}${e.switch ? ' · нужен рубильник' : ''}`, { className: 'tt', direction: 'top', offset: [0, -10] });
        grp.addLayer(mk);
        if (kind === 'shared') this.groups.scav.addLayer(L.marker(pos(e.position), { icon, height: mk.options.height }));
      }
      for (const t of m.transits || []) {
        if (!t.position) continue;
        const icon = L.divIcon({ className: 'mk', html: `<div class="mk-exit transit">${esc(t.description || 'Переход')}</div>`, iconSize: [0, 0] });
        this.groups.transits.addLayer(L.marker(pos(t.position), { icon, height: this.heightOpt(t.position, t.top, t.bottom) }));
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
  }

  // ключи: id предмета -> { name, icon, need: bool }
  drawLocks(locks, keyInfo) {
    if (!this.map) return;
    this.groups.locks.clearLayers();
    this.groups.questLocks.clearLayers();
    for (const l of locks || []) {
      if (!l.position) continue;
      const k = keyInfo(l.key);
      const icon = L.divIcon({ className: 'mk', html: `<div class="mk-lock${k.need ? ' need' : ''}">${LOCK_SVG}</div>`, iconSize: [0, 0] });
      const tip = `${esc(k.name)}${l.needsPower ? ' · нужно питание' : ''}${k.need ? ' · нужен для квеста' : ''}`;
      const make = () => L.marker(pos(l.position), { icon, height: this.heightOpt(l.position) })
        .bindTooltip(tip, { className: 'tt', direction: 'top', offset: [0, -8] });
      this.groups.locks.addLayer(make());
      // двери с ключами для активных квестов видны вместе со слоем заданий
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

  // points: [{ id, objectiveId, taskId, kind:'zone'|'item', position, outline, top, bottom, title, sub, text, done, n }]
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
        const poly = L.polygon(p.outline.map(pos), { color: p.avail ? '#8B5CF6' : p.done ? '#22C55E' : '#22D3EE', weight: 1.5, opacity: 0.9, fillOpacity: 0.12, interactive: false, height: h });
        grp.addLayer(poly);
      }
      // ромб с номером задачи; якорь — центр ромба, поэтому точка не «плавает» при масштабировании
      const sz = p.avail ? 16 : 22;
      const icon = L.divIcon({ className: 'mk', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2], popupAnchor: [0, -12],
        html: `<div class="mk-q${p.kind === 'item' ? ' item' : ''}${p.done ? ' done' : ''}${p.avail ? ' avail' : ''}${p.tracked ? ' tracked' : ''}">${esc(p.n ?? '')}</div>` });
      const mk = L.marker(pos(p.position), { icon, height: h, riseOnHover: true, zIndexOffset: p.tracked ? 500 : 0 });
      mk.bindTooltip(`<b>${esc(p.title)}</b><br>${esc(p.text)}`, { className: 'tt', direction: 'top', offset: [0, -12] });
      // содержимое собирается при открытии — чтобы показать уже скачанный скриншот места
      mk.bindPopup(() => {
        const shot = this.shotFor?.(p.taskId);
        return `<div class="pop-title">${esc(p.title)}</div><div class="pop-sub">${esc(p.sub)}</div><div>${esc(p.text)}</div>
        ${shot ? `<img class="pop-shot" src="${esc(shot.thumb)}" alt="" data-act="shots" data-id="${esc(p.taskId)}" title="${esc(shot.caption)}">` : ''}
        <div class="btnrow">${p.avail ? '<span class="tag st-available">можно взять</span>' : `<button class="btn sm" data-act="toggleObj" data-id="${esc(p.objectiveId)}">${p.done ? 'Снять отметку' : 'Выполнено'}</button>`}
        <button class="btn sm" data-act="openTask" data-id="${esc(p.taskId)}">Открыть в досье</button></div>`;
      }, { maxWidth: 300 });
      grp.addLayer(mk);
      if (!this.taskMarkers.has(p.taskId)) this.taskMarkers.set(p.taskId, []);
      this.taskMarkers.get(p.taskId).push(mk);
      if (p.avail) continue;
      if (!this.questMarkers.has(p.objectiveId)) this.questMarkers.set(p.objectiveId, []);
      this.questMarkers.get(p.objectiveId).push(mk);
    }
    this.applyFloorToMarkers();
  }

  // подсветить точки одного квеста, остальные приглушить (null — снять подсветку)
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
