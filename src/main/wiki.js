'use strict';
// Скриншоты и короткий гайд к квесту — с открытой вики Escape from Tarkov (escapefromtarkov.fandom.com,
// контент CC BY-SA). Берётся раздел «Guide» страницы квеста: галерея картинок с подписями и текст.
// Ссылка на страницу — из базы tarkov.dev (поле wikiLink), а не из интерфейса.

const fs = require('fs');
const path = require('path');

const API = 'https://escapefromtarkov.fandom.com/api.php';
const TTL = 14 * 24 * 3600 * 1000;
const IMG_HOST = /^https:\/\/static\.wikia\.nocookie\.net\/escapefromtarkov_gamepedia\/images\//;
const UA = 'TarkovHelper/1.2 (personal quest overlay; reads public wiki pages)';

const decode = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const text = (html) => decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

function pageTitle(wikiLink) {
  const m = /\/wiki\/([^?#]+)/.exec(wikiLink || '');
  return m ? decodeURIComponent(m[1]) : null;
}

// раздел Guide: от заголовка до навигационной таблицы внизу страницы
function guideSection(html) {
  const start = html.search(/id="Guide"/);
  if (start < 0) return '';
  let end = html.indexOf('class="navbox', start);
  if (end < 0) end = html.length;
  return html.slice(start, end);
}

function parse(html) {
  const sec = guideSection(html);
  const images = [];
  const seen = new Set();
  const push = (full, thumb, caption) => {
    if (!IMG_HOST.test(full || '') || seen.has(full)) return;
    if (/Icon\.(png|jpg|webp)/i.test(full)) return; // иконки предметов из таблицы — не скриншоты
    seen.add(full);
    images.push({ full, thumb: IMG_HOST.test(thumb || '') ? thumb : full, caption: text(caption || '') });
  };
  for (const m of sec.matchAll(/<li class="gallerybox"[\s\S]*?<\/li>/g)) {
    const box = m[0];
    const full = /<a href="(https:\/\/static\.wikia\.nocookie\.net\/[^"]+)"[^>]*class="mw-file-description/.exec(box)?.[1];
    const thumb = /<img[^>]+src="(https:\/\/static\.wikia\.nocookie\.net\/[^"]+)"/.exec(box)?.[1];
    const cap = /<div class="gallerytext">([\s\S]*?)<\/div>/.exec(box)?.[1] || /title="([^"]*)"/.exec(box)?.[1];
    push(decode(full || ''), decode(thumb || ''), cap);
  }
  for (const m of sec.matchAll(/<figure[\s\S]*?<\/figure>/g)) {
    const fig = m[0];
    const full = /<a href="(https:\/\/static\.wikia\.nocookie\.net\/[^"]+)"/.exec(fig)?.[1];
    const thumb = /<img[^>]+(?:data-src|src)="(https:\/\/static\.wikia\.nocookie\.net\/[^"]+)"/.exec(fig)?.[1];
    const cap = /<figcaption>([\s\S]*?)<\/figcaption>/.exec(fig)?.[1];
    push(decode(full || ''), decode(thumb || ''), cap);
  }
  const paras = [...sec.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => text(m[1])).filter((t) => t.length > 20);
  let guide = paras.join('\n\n');
  if (guide.length > 1400) guide = guide.slice(0, 1400).replace(/\s+\S*$/, '') + '…';
  return { images: images.slice(0, 16), guide };
}

class Wiki {
  constructor(cacheDir) {
    this.dir = path.join(cacheDir, 'wiki');
    this.inflight = new Map();
    this.queue = [];
    this.active = 0;
  }

  file(id) { return path.join(this.dir, id + '.json'); }

  cached(id) {
    try {
      const d = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
      return { ...d, stale: !(Date.now() - d.ts < TTL) };
    } catch { return null; }
  }

  // task: { id, wikiLink }
  get(task) {
    const c = this.cached(task.id);
    if (c && !c.stale) return Promise.resolve(c);
    if (this.inflight.has(task.id)) return this.inflight.get(task.id);
    const p = this.fetch(task).catch((e) => (c ? c : { id: task.id, images: [], guide: '', error: e.message, ts: 0 }))
      .finally(() => this.inflight.delete(task.id));
    this.inflight.set(task.id, p);
    return p;
  }

  async fetch(task) {
    const title = pageTitle(task.wikiLink);
    if (!title) return { id: task.id, images: [], guide: '', ts: Date.now() };
    const url = `${API}?action=parse&page=${encodeURIComponent(title)}&prop=text&redirects=1&format=json&formatversion=2`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const html = j?.parse?.text || '';
      const d = { id: task.id, url: task.wikiLink, ...parse(html), ts: Date.now() };
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file(task.id), JSON.stringify(d));
      return d;
    } finally { clearTimeout(timer); }
  }

  // фоновая подгрузка для видимых квестов: не больше двух запросов одновременно
  prefetch(tasks, onDone) {
    for (const t of tasks) {
      if (this.cached(t.id)?.stale === false || this.inflight.has(t.id) || this.queue.some((q) => q.id === t.id)) continue;
      this.queue.push(t);
    }
    const pump = () => {
      while (this.active < 2 && this.queue.length) {
        const t = this.queue.shift();
        this.active++;
        this.get(t).then((d) => onDone(d)).finally(() => { this.active--; pump(); });
      }
    };
    pump();
  }
}

module.exports = { Wiki, parse, pageTitle };
