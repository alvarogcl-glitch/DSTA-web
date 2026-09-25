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
};
const section = script.slice(script.indexOf('function portfolioMinute(){'), script.indexOf('function cataMinute(){'));
vm.runInNewContext(`${section}\nportfolioMinute()`, context);
assert.match(views[0][1], /#1 A/);
assert.match(views[0][1], /#3 C/);
assert.doesNotMatch(views[0][1], /#2 B|#4 D|###### #LT2/);
selected.clear();
views.length = 0;
vm.runInNewContext(`${section}\nportfolioMinute()`, context);
assert.equal(views.length, 0, 'no minute generated without selection');
assert.match(script, /setTimeout\(\(\)=>\{[^}]*toggleProjectSelection\(id\)/,
  'long press must select a line, not generate a minute');
console.log('portfolio selection checks passed');
