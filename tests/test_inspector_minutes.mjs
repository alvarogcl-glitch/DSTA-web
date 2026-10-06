import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const script = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').split('<script>')[1].split('</script>')[0];
const views = [];
const context = {
  tasks: [{ id: 1, project_id: 11, title: 'Actual', done: false }, { id: 2, project_id: 12, title: 'Ajena', done: false }, { id: 3, project_id: 11, title: 'Cerrada', done: true }],
  projects: [{ id: 11, title: 'LT1' }], panelSets: {}, window: { metricSubsets: [] },
  descriptionLog: () => '', minuteDate: () => '06-10-2026',
  taskLines: list => list.filter(t => !t.done).map(t => '#' + t.id + ' ' + t.title).join('\n\n'),
  minuteView: (...args) => views.push(args),
};
const section = script.slice(script.indexOf('function taskView('), script.indexOf('function showTask('));
const api = vm.runInNewContext(`${section}\n({projectView,rebuildInspection,inspectorMinute})`, context);
api.inspectorMinute({ title: 'LT1', projectId: '11', items: [context.tasks[1]] });
assert.match(views[0][1], /#1 Actual/);
assert.doesNotMatch(views[0][1], /Ajena|Cerrada/);
context.tasks = context.tasks.filter(t => t.id !== 1);
api.inspectorMinute({ title: 'LT1', projectId: '11', items: [{ id: 1, title: 'Obsoleta' }] });
assert.match(views[1][1], /Sin tareas abiertas/);
assert.match(script, /id="inspector-minute"/, 'el inspector ofrece generar minuta incluso vacío');
context.panelSets.upcoming = [context.tasks[0]];
const savedSection = { title: 'Por vencer', fields: [['Tareas', 99]], items: [{ id: 2 }], scope: { panel: 'upcoming' } };
assert.equal(api.rebuildInspection(savedSection).items[0].id, 2);
context.panelSets.upcoming = [{ id: 8, title: 'Nueva en sección', done: false }, { id: 9, title: 'Finalizada', done: true }];
const rebuilt = api.rebuildInspection(savedSection);
assert.equal(rebuilt.items[0].id, 8, 'volver reconstruye la pertenencia a la sección actual');
assert.equal(rebuilt.fields[0][1], 2, 'el conteo se actualiza');
api.inspectorMinute(savedSection);
assert.match(views.at(-1)[1], /#8 Nueva en sección/);
assert.doesNotMatch(views.at(-1)[1], /Ajena|Finalizada/);
context.window.metricSubsets[1] = [{ id: 10, title: 'KPI actual', done: false }];
api.inspectorMinute({ ...savedSection, scope: { metric: 1 } });
assert.match(views.at(-1)[1], /#10 KPI actual/);
assert.match(script, /scope:\s*\{panel:context\}/);
assert.match(script, /scope:\s*\{metric:index\}/);
console.log('scoped inspector minute checks passed');
