"""Deterministic native Vikunja labels. No model calls; task writes share OS locks."""
from contextlib import nullcontext
import json
import os
from pathlib import Path
import unicodedata
from urllib.error import HTTPError
from task_mutation_lock import task_lock

PALETTE = {item['hex'] for item in json.loads(
    (Path(__file__).resolve().parents[1] / 'public' / 'label-palette.json').read_text(encoding='utf-8'))}
PROTECTED = 'carrera tecnologica'


def normalized(title):
    return ' '.join(''.join(c for c in unicodedata.normalize('NFKD', title)
                           if not unicodedata.combining(c)).casefold().split())


def list_all(request, path):
    result = []
    for page in range(1, 101):
        batch = request('GET', f'{path}?page={page}&per_page=50')
        if not isinstance(batch, list):
            raise ValueError('Respuesta inválida de Vikunja')
        result.extend(batch)
        if len(batch) < 50:
            return result
    raise ValueError('No se obtuvo el catálogo completo')


def require_task(request, task_id, project_id):
    task = request('GET', f'/api/v1/tasks/{task_id}')
    root = request('GET', '/api/v1/projects/2')
    project = request('GET', f'/api/v1/projects/{project_id}')
    if (task.get('id') != task_id or task.get('project_id') != project_id or
            root.get('id') != 2 or root.get('is_archived') is not False or
            project.get('id') != project_id or project.get('parent_project_id') != 2 or
            project.get('is_archived') is not False):
        raise ValueError('La tarea ya no pertenece a una línea activa PMO-DSTA')
    return task


def label_or_none(request, label_id):
    try:
        label = request('GET', f'/api/v1/labels/{label_id}')
    except HTTPError as error:
        if error.code == 404:
            return None
        raise
    if label.get('id') != label_id:
        raise ValueError('Vikunja devolvió una etiqueta distinta')
    return label


def execute(job, request, *, server_url, cache_dir):
    """Replays are idempotent; reset targets only the catalog captured at enqueue."""
    action = job['action']
    if action not in {'create', 'update', 'delete', 'assign', 'unassign', 'reset'}:
        raise ValueError('Acción de etiquetas inválida')
    task_id = job.get('taskId')
    if action in {'assign', 'unassign'} and (type(task_id) is not int or task_id <= 0):
        raise ValueError('Tarea inválida')
    # Serialise catalog changes across bridge processes, with a distinct catalog lock.
    with task_lock(server_url + '/labels-catalog', 1), \
            task_lock(server_url, task_id) if task_id else nullcontext():
        if task_id:
            require_task(request, task_id, job['projectId'])
        if action in {'create', 'update'}:
            title = job.get('title', '').strip()
            color = job.get('color')
            if not title or len(title) > 100 or color not in PALETTE:
                raise ValueError('Nombre o color inválido')
            labels = list_all(request, '/api/v1/labels')
            marker = f'DSTA_REQUEST:{job["id"]}'
            replay = next((l for l in labels if marker in (l.get('description') or '')), None)
            if action == 'create' and replay:
                if replay['title'] != title or replay.get('hex_color', '').lower().lstrip('#') != color:
                    raise ValueError('La etiqueta creada cambió antes de confirmar')
                label_id = replay['id']
            else:
                label_id = job.get('labelId')
                if any(normalized(l['title']) == normalized(title) and l['id'] != label_id for l in labels):
                    raise ValueError('Ya existe una etiqueta con ese nombre')
                if action == 'update':
                    current = label_or_none(request, label_id)
                    if not current:
                        raise ValueError('La etiqueta ya no existe')
                    body = {'title': title, 'hex_color': color, 'description': current.get('description') or ''}
                    request('POST', f'/api/v1/labels/{label_id}', payload=body)
                else:
                    created = request('PUT', '/api/v1/labels', payload={
                        'title': title, 'hex_color': color, 'description': marker})
                    label_id = created.get('id')
                    if type(label_id) is not int or label_id <= 0:
                        raise ValueError('No se recibió el ID de la etiqueta')
            verified = label_or_none(request, label_id)
            if not verified or verified['title'] != title or verified.get('hex_color', '').lower().lstrip('#') != color:
                raise ValueError('No se pudo verificar la etiqueta')
            if task_id:
                require_task(request, task_id, job['projectId'])
                if label_id not in {l['id'] for l in list_all(request, f'/api/v1/tasks/{task_id}/labels')}:
                    request('PUT', f'/api/v1/tasks/{task_id}/labels', payload={'label_id': label_id})
                if label_id not in {l['id'] for l in list_all(request, f'/api/v1/tasks/{task_id}/labels')}:
                    raise ValueError('No se pudo verificar la asignación')
            return {'labelId': label_id}
        if action in {'assign', 'unassign'}:
            label_id = job['labelId']
            if action == 'assign' and not label_or_none(request, label_id):
                raise ValueError('La etiqueta ya no existe')
            existing = {l['id'] for l in list_all(request, f'/api/v1/tasks/{task_id}/labels')}
            if action == 'assign' and label_id not in existing:
                request('PUT', f'/api/v1/tasks/{task_id}/labels', payload={'label_id': label_id})
            elif action == 'unassign' and label_id in existing:
                request('DELETE', f'/api/v1/tasks/{task_id}/labels/{label_id}')
            verified = {l['id'] for l in list_all(request, f'/api/v1/tasks/{task_id}/labels')}
            if (label_id in verified) != (action == 'assign'):
                raise ValueError('No se pudo verificar la asignación')
            return {'labelId': label_id}
        targets = job['targets'] if action == 'reset' else [job['target']]
        if action == 'reset':
            protected = label_or_none(request, job['preservedId'])
            if not protected or normalized(protected['title']) != PROTECTED:
                raise ValueError('No se encontró Carrera tecnológica; no se eliminó ninguna etiqueta')
        for target in targets:
            current = label_or_none(request, target['id'])
            if current and (normalized(current['title']) == PROTECTED or
                            current['title'] != target['title'] or
                            str(current.get('hex_color') or 'bac7d5').lstrip('#').lower() != target['hex_color']):
                raise ValueError('Una etiqueta cambió desde la solicitud; revisa el catálogo')
        # Back up native labels and every accessible task association before deleting.
        backup_path = Path(cache_dir) / 'label-backups' / f'{job["id"]}.json'
        backup_path.parent.mkdir(parents=True, exist_ok=True)
        if not backup_path.exists():
            native = [label_or_none(request, target['id']) for target in targets]
            tasks = list_all(request, '/api/v1/tasks')
            target_ids = {target['id'] for target in targets}
            backup = {'requestId': job['id'], 'labels': native, 'associations': [
                {'taskId': t['id'], 'labelIds': [l['id'] for l in t.get('labels') or [] if l['id'] in target_ids]}
                for t in tasks if any(l['id'] in target_ids for l in t.get('labels') or [])]}
            # Catalog OS lock serializes processes; publish the complete backup atomically.
            temporary = backup_path.with_suffix('.tmp')
            with temporary.open('w', encoding='utf-8') as handle:
                json.dump(backup, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, backup_path)
        else:
            stored = json.loads(backup_path.read_text(encoding='utf-8'))
            if stored.get('requestId') != job['id'] or not isinstance(stored.get('associations'), list):
                raise ValueError('No se pudo validar el respaldo anterior; no se eliminan etiquetas')
        for target in targets:
            current = label_or_none(request, target['id'])
            if not current:
                continue
            if normalized(current['title']) == PROTECTED:
                raise ValueError('Carrera tecnológica se conserva')
            if current['title'] != target['title'] or str(current.get('hex_color') or 'bac7d5').lstrip('#').lower() != target['hex_color']:
                raise ValueError('Una etiqueta cambió desde la solicitud; revisa el catálogo')
            request('DELETE', f'/api/v1/labels/{target["id"]}')
            if label_or_none(request, target['id']):
                raise ValueError('No se pudo verificar la eliminación')
        return {'deletedIds': [target['id'] for target in targets]}
