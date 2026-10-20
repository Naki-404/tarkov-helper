'use strict';
// Позиция игрока по имени файла скриншота.
// Игра сама пишет координаты в имя: 2024-01-15[21-30]_-123.4, 4.5, 78.9_0.0, 0.7, 0.0, 0.7_12.34 (0).png
// Читается только список имён файлов в папке; содержимое файлов не открывается.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const NAME_RE = /_(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)_/;

function defaultScreenshotsDir(documents) {
  return path.join(documents, 'Escape from Tarkov', 'Screenshots');
}

function parseName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [x, y, z, qx, qy, qz, qw] = m.slice(1).map(Number);
  // поворот вокруг вертикальной оси (Unity: Y вверх) из кватерниона
  const yaw = Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qx * qx)) * 180 / Math.PI;
  return { x, y, z, yaw };
}

class ScreenshotWatcher extends EventEmitter {
  constructor() { super(); this.timer = null; this.known = new Set(); this.dir = null; }

  start(dir) {
    this.stop();
    this.dir = dir;
    this.known = new Set(this.list());
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  list() {
    try { return fs.readdirSync(this.dir).filter((f) => /\.(png|jpe?g|bmp)$/i.test(f)); } catch { return []; }
  }

  tick() {
    for (const f of this.list()) {
      if (this.known.has(f)) continue;
      this.known.add(f);
      const pos = parseName(f);
      if (pos) this.emit('position', { ...pos, ts: Date.now() });
    }
  }
}

module.exports = { ScreenshotWatcher, defaultScreenshotsDir, parseName };
