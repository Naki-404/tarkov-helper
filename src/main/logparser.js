'use strict';
// Разбор текстовых логов Escape from Tarkov.
// Модуль работает только со строками, которые уже прочитаны из файлов логов.
// Никакого доступа к процессу игры, её памяти или сетевому трафику здесь нет.

const HEADER_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/;

// Коды сообщений в чате трейдера (message.type в уведомлении new_message)
const MSG_TASK_STARTED = 10;
const MSG_TASK_FAILED = 11;
const MSG_TASK_FINISHED = 12;

function parseTimestamp(s) {
  // "2026-10-18 17:58:37.501" — локальное время
  const [d, t] = s.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, rest] = t.split(':');
  const [se, ms] = rest.split('.');
  return new Date(y, mo - 1, da, Number(h), Number(mi), Number(se), Number(ms)).getTime();
}

// Делит текст на записи: строка-заголовок + строки продолжения (обычно JSON).
// Возвращает { entries, rest }, где rest — хвост, который может быть недописан.
function splitEntries(text, flushAll) {
  const entries = [];
  let cur = null;
  let curStart = 0; // смещение начала последней записи в text (с учётом настоящих \r\n — логи EFT в CRLF)
  const sep = /\r?\n/g;
  let pos = 0;
  for (;;) {
    const m = sep.exec(text);
    const end = m ? m.index : text.length;
    const line = text.slice(pos, end);
    const h = HEADER_RE.exec(line);
    if (h) {
      if (cur) entries.push(cur);
      cur = { ts: parseTimestamp(h[1]), version: h[2], level: h[3], channel: h[4], text: h[5], body: [] };
      curStart = pos;
    } else if (cur) {
      cur.body.push(line);
    }
    if (!m) break;
    pos = m.index + m[0].length;
  }
  if (!cur) return { entries, rest: flushAll ? '' : text };
  if (flushAll) {
    entries.push(cur);
    return { entries, rest: '' };
  }
  // последнюю запись придерживаем: к ней ещё могут дописать JSON
  return { entries, rest: text.slice(curStart) };
}

function parseBodyJson(entry) {
  if (!entry.body.length) return null;
  const raw = entry.body.join('\n').trim();
  if (!raw.startsWith('{')) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Названия файлов-пресетов сцены → id карты (location id игры)
const SCENE_PRESET_MAP = {
  factory_day: 'factory4_day',
  factory_night: 'factory4_night',
  customs: 'bigmap',
  bigmap: 'bigmap',
  rezerv: 'RezervBase',
  rezervbase: 'RezervBase',
  reserve: 'RezervBase',
  city: 'TarkovStreets',
  streets: 'TarkovStreets',
  tarkovstreets: 'TarkovStreets',
  sandbox: 'Sandbox',
  sandbox_high: 'Sandbox_high',
  groundzero: 'Sandbox',
  laboratory: 'laboratory',
  shoreline: 'Shoreline',
  woods: 'Woods',
  interchange: 'Interchange',
  shopping_mall: 'Interchange',
  lighthouse: 'Lighthouse',
  labyrinth: 'Labyrinth',
};

// Превращает запись лога в событие приложения (или null).
// Из записей берутся только нужные поля; токены и IP не сохраняются.
function entryToEvent(entry) {
  const { ts, channel, text } = entry;

  if (channel === 'application') {
    let m;
    if ((m = /^Session mode: (\w+)/.exec(text))) {
      const mode = /pve/i.test(m[1]) ? 'pve' : 'regular';
      return { type: 'mode', ts, mode, raw: m[1] };
    }
    if ((m = /^(?:PrepareSelectedProfileLocally|SelectProfile) ProfileId:(\w+)/.exec(text))) {
      return { type: 'profile', ts, profileId: m[1] };
    }
    if ((m = /^scene preset path:maps\/([\w-]+?)(?:_preset)?\.bundle/i.exec(text))) {
      const key = m[1].toLowerCase();
      return { type: 'mapLoading', ts, location: SCENE_PRESET_MAP[key] || m[1] };
    }
    if ((m = /profileStatus: '.*?Location: ([\w-]+)/.exec(text))) {
      return { type: 'raidCreated', ts, location: m[1] };
    }
    if ((m = /^\[Transit\] Flag:\w+, RaidId:\w+, Count:\d+, Locations:([\w-]+)/.exec(text))) {
      return { type: 'raidCreated', ts, location: m[1] };
    }
    if ((m = /^Transit reconnect status:\w+ raidMode:\w+ location:([\w-]+)/.exec(text))) {
      return { type: 'mapLoading', ts, location: m[1] };
    }
    // перед боем у ЧВК есть отсчёт (GameStarting → GameStarted через ~10 с), у Дикого его почти нет
    if ((m = /^GameStarting:([\d.,]+)/.exec(text))) return { type: 'raidStarting', ts, t: parseFloat(m[1].replace(',', '.')) };
    if ((m = /^GameStarted:([\d.,]+)/.exec(text))) return { type: 'raidStarted', ts, t: parseFloat(m[1].replace(',', '.')) };
    if (/^(Network|Local) game matching (cancelled|aborted)/.test(text)) return { type: 'matchingCancelled', ts };
    if (/^Matching with group id/.test(text)) return { type: 'matchingStarted', ts };
    return null;
  }

  if (channel === 'push-notifications') {
    if (!/^Got notification/.test(text)) return null;
    const json = parseBodyJson(entry);
    if (!json) return null;
    if (json.type === 'new_message' && json.message) {
      const msg = json.message;
      const tpl = typeof msg.templateId === 'string' ? msg.templateId.split(' ')[0] : null;
      if (!tpl) return null;
      const kind = msg.type === MSG_TASK_STARTED ? 'started'
        : msg.type === MSG_TASK_FAILED ? 'failed'
        : msg.type === MSG_TASK_FINISHED ? 'finished' : null;
      if (!kind) return null;
      return { type: 'task', ts, kind, messageId: tpl, traderId: json.dialogId || null };
    }
    if (json.type === 'userMatchOver') {
      return { type: 'raidEnded', ts, location: json.location || null };
    }
    if (json.type === 'groupMatchRaidSettings' && json.raidSettings) {
      return { type: 'mapLoading', ts, location: json.raidSettings.location || null, side: json.raidSettings.side === 'Savage' ? 'scav' : json.raidSettings.side === 'Pmc' ? 'pmc' : null };
    }
    return null;
  }

  return null;
}

module.exports = { splitEntries, entryToEvent, parseTimestamp, HEADER_RE };
