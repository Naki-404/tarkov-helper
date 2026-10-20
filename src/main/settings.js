'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  logsDir: null,            // null — искать автоматически
  screenshotsEnabled: false, // позиция по именам файлов скриншотов (выключено по умолчанию)
  screenshotsDir: null,
  lang: 'ru',
  gameMode: 'auto',         // auto | pve | regular — для цен и данных
  opacity: 0.96,
  uiScale: 1,               // масштаб интерфейса (удобно поверх игры в 2K/4K)
  notify: false,            // системные уведомления Windows о квестах, когда окно скрыто
  lite: true,               // экономный режим: без видеокарты, меньше процессов и памяти (нужен перезапуск)
  alwaysOnTop: true,
  hotkeys: {
    toggle: 'Alt+X',
    clickThrough: 'Alt+Z',
    map: 'Alt+M',
    quests: 'Alt+Q',
    compact: 'Alt+C',
  },
  window: { width: 1320, height: 820, x: null, y: null },
  compactWindow: { width: 400, height: 760, x: null, y: null },
  compact: false,
  showKappaOnly: false,
  showLightkeeperOnly: false,
};

class Settings {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(DEFAULTS);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...this.data, ...raw, hotkeys: { ...DEFAULTS.hotkeys, ...(raw.hotkeys || {}) },
        window: { ...DEFAULTS.window, ...(raw.window || {}) }, compactWindow: { ...DEFAULTS.compactWindow, ...(raw.compactWindow || {}) } };
    } catch { /* первый запуск */ }
  }
  get(k) { return this.data[k]; }
  set(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS)) continue;
      if (k === 'hotkeys' || k === 'window' || k === 'compactWindow') this.data[k] = { ...this.data[k], ...v };
      else this.data[k] = v;
    }
    this.save();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { Settings, DEFAULTS };
