import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const selected = new Set(['11', '13']);
const views = [];
const context = {
  selectedProjectIds: selected,
  projects: [{ id: 11, title: 'LT1' }, { id: 12, title: 'LT2' }, { id: 13, title: 'TR1' }],
  tasks: [{ id: 1, title: 'A', project_id: 11, done: false },
    { id: 2, title: 'B', project_id: 12, done: false },
    { id: 3, title: 'C', project_id: 13, done: false },
    { id: 4, title: 'D', project_id: 11, done: true }],
  openTasks: list => list.filter(task => !task.done),
  minuteDate: () => '25-09-2026',
  minuteView: (...args) => views.push(args),
  exitSelectMode: () => {},
};
const section = script.slice(script.indexOf('function portfolioMinute(){'), script.indexOf('const chosenOrAll='));
vm.runInNewContext(`${section}\nportfolioMinute()`, context);
assert.match(views[0][1], /#1 A/);
assert.match(views[0][1], /#3 C/);
assert.doesNotMatch(views[0][1], /#2 B|#4 D|###### #LT2/);
selected.clear();
views.length = 0;
vm.runInNewContext(`${section}\nportfolioMinute()`, context);
assert.equal(views.length, 0, 'no minute generated without selection');
assert.match(script, /setTimeout\(\(\)=>\{[^\n]*?enterSelectMode\(group\);toggleSelection\(group,id\)\},650\)/,
  'long press must activate selection mode, not generate a minute');

// Cata 1-1 y fechas próximas: con selección, solo lo elegido; sin selección, todo.
const minuteSection = script.slice(script.indexOf('const chosenOrAll='), script.indexOf('async function copyMinute(){'));
const cataTasks = [
  { id: 5, title: 'Revisar con Cata', project_id: 11, done: false, date: '2026-10-01', owner: 'Álvaro' },
  { id: 6, title: 'Otro tema Cata', project_id: 11, done: false, date: '2026-09-01', owner: 'Álvaro' },
  { id: 7, title: 'Cerrado Cata', project_id: 11, done: true, date: '', owner: 'Álvaro' },
];
const minuteContext = {
  selections: { portfolio: new Set(), upcoming: new Set(), cata: new Set(['5']) },
  panelSets: { upcoming: [cataTasks[0]], overdue: [cataTasks[1]] },
  tasks: cataTasks,
  cataReason: () => 'Título',
  openTasks: list => list.filter(task => !task.done),
  taskLines: list => list.map(task => `#${task.id} ${task.title}`).join('\n\n'),
  displayDate: value => value,
  minuteDate: () => '28-09-2026',
  exitSelectMode: () => {},
  minuteView: (...args) => views.push(args),
};
const runMinute = name => {
  views.length = 0;
  vm.runInNewContext(`${minuteSection}\n${name}()`, { ...minuteContext });
  return views[0][1];
};
let text = runMinute('cataMinute');
assert.match(text, /#5 Revisar con Cata/);
assert.doesNotMatch(text, /#6|#7/);
minuteContext.selections.cata.clear();
assert.match(runMinute('cataMinute'), /#5 [\s\S]*#6 /, 'without selection the Cata minute keeps every open topic');

minuteContext.selections.upcoming.add('6');
text = runMinute('upcomingMinute');
assert.match(text, /Vencidas[\s\S]*#6 Otro tema Cata/);
assert.doesNotMatch(text, /#5|Por vencer/);
minuteContext.selections.upcoming.clear();
assert.match(runMinute('upcomingMinute'), /Por vencer[\s\S]*#5[\s\S]*Vencidas[\s\S]*#6/);
console.log('minute selection checks passed');
