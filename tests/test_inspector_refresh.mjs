import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const section = script.slice(script.indexOf('function taskView('), script.indexOf('function showTask('));
const task = { id: 42, title: 'Validar tarea', project_id: 3, project: 'LT2 · AER',
  done: false, owner: 'Álvaro', date: '', dependency: '', description: '' };
const context = { projects: [{ id: 3, title: 'LT2 · AER' }], tasks: [task], descriptionLog: () => '' };
const inspect = vm.runInNewContext(`${section}\n({projectView,taskView,rebuildInspection})`, context);
const savedProject = inspect.projectView(context.projects[0]);
const savedTask = inspect.taskView(task);
context.tasks = [{ ...task, title: 'Validación terminada', done: true }];
const updatedProject = inspect.rebuildInspection(savedProject);
const updatedTask = inspect.rebuildInspection(savedTask);
assert.equal(updatedProject.items.length, 0, 'la tarea completada sale de pendientes');
assert.equal(updatedProject.fields.find(([key]) => key === 'Abiertas')[1], 0);
assert.equal(updatedProject.fields.find(([key]) => key === 'Completadas')[1], 1);
assert.equal(updatedTask.fields.find(([key]) => key === 'Estado')[1], 'Completada');
assert.match(updatedTask.title, /Validación terminada/, 'se actualiza también el título');
console.log('inspector snapshot refresh checks passed');
