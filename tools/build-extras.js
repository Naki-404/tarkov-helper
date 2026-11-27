'use strict';
// Сборка assets/quest-extras.json из tasks_en.json проекта eft_quest_helper (MIT).
// node tools/build-extras.js [путь к tasks_en.json]

const fs = require('fs');
const path = require('path');
const { buildExtras } = require('../src/main/extras');

const DEFAULT = 'C:/Users/Kreis/AppData/Local/Temp/claude/6b3768e74f6205e1/58710859-cd7e-4e31-8f9b-b1addf339677/scratchpad/ext/eft_quest_helper/data/tasks_en.json';
const src = process.argv[2] || DEFAULT;
const out = path.join(__dirname, '..', 'assets', 'quest-extras.json');

const tasks = JSON.parse(fs.readFileSync(src, 'utf8'));
if (!Array.isArray(tasks) || tasks.length <= 300) throw new Error('неожиданный формат: ' + src);
const d = buildExtras(tasks);
// по строке на подсказку и квест: читается в diff и остаётся небольшим
const body = [
  '{',
  `"source": ${JSON.stringify(d.source)},`,
  `"builtAt": ${d.builtAt},`,
  '"hints": {',
  Object.entries(d.hints).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n'),
  '},',
  '"quests": [',
  d.quests.map((q) => JSON.stringify(q)).join(',\n'),
  ']',
  '}',
].join('\n') + '\n';
JSON.parse(body); // проверка
fs.writeFileSync(out + '.tmp', body);
fs.renameSync(out + '.tmp', out);
const cat = d.quests.reduce((a, q) => ({ ...a, [q.category]: (a[q.category] || 0) + 1 }), {});
console.log(`${out}: ${(body.length / 1024).toFixed(1)} КБ, подсказок ${Object.keys(d.hints).length}, квестов ${d.quests.length}`, cat);
