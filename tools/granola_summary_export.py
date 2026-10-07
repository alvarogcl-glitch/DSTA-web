"""Export Granola summaries; defer unavailable content until a later sync."""
import asyncio
import hashlib
import json
import os
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tools.mcp_oauth import build_oauth_auth
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL = 'https://mcp.granola.ai/mcp'
ROOT = Path(r'C:\Users\admin\.openclaw\workspace\proyectos\pmo-dsta\07_reuniones')
STAGING = ROOT / '.granola-summary-staging'


def discarded_sources() -> set[str]:
    home = Path(os.environ.get('HERMES_HOME', str(Path.home() / 'AppData' / 'Local' / 'hermes')))
    store = home / 'cache' / 'dsta-minute-inbox.json'
    if not store.exists():
        return set()
    records = json.loads(store.read_text(encoding='utf-8')).get('minutes', {})
    return {mid for mid, record in records.items() if record.get('descartadaEn')}


def result_text(result: Any) -> str:
    return '\n'.join(getattr(x, 'text', '') for x in getattr(result, 'content', []) if getattr(x, 'text', None))


def xml_root(text: str) -> ET.Element:
    for marker in ('<meetings_data', '<meeting'):
        pos = text.find(marker)
        if pos >= 0:
            return ET.fromstring(text[pos:])
    raise ValueError('Granola no devolvió XML de reuniones')


def text_node(parent: ET.Element, tag: str, default: str = '') -> str:
    node = parent.find(tag)
    if node is None:
        return default
    return ''.join(node.itertext()).strip()


def slugify(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r'[^\w\s-]', '', value, flags=re.UNICODE)
    value = re.sub(r'[\s_-]+', '-', value).strip('-')
    return value[:120] or 'reunion-sin-titulo'


def date_key(value: str) -> str:
    m = re.search(r'\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s+(20\d{2})', value or '', re.I)
    if not m:
        return 'unknown-date'
    months = {'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6, 'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12}
    return f'{m.group(3)}-{months[m.group(1)[:3].lower()]:02d}-{int(m.group(2)):02d}'


def detail_dict(meeting: ET.Element) -> dict[str, str]:
    return {
        'id': meeting.attrib.get('id', ''),
        'title': meeting.attrib.get('title', 'Reunión sin título'),
        'date': meeting.attrib.get('date', ''),
        'known_participants': text_node(meeting, 'known_participants', 'not available'),
        'private_notes': text_node(meeting, 'private_notes', 'not available'),
        'summary': text_node(meeting, 'summary', 'not available'),
    }


EMPTY_CONTENT = {'', 'no summary', 'not available', 'no notes', 'none', 'null'}


def has_content(detail: dict[str, str]) -> bool:
    return any(str(detail.get(key) or '').strip().casefold() not in EMPTY_CONTENT
               for key in ('summary', 'private_notes'))


def meeting_nodes(root: ET.Element) -> list[ET.Element]:
    return [root] if root.tag == 'meeting' else root.findall('.//meeting')


def markdown(detail: dict[str, str], extracted_at: str) -> str:
    payload = '\n\n'.join([detail['summary'], detail['private_notes']])
    digest = hashlib.sha256(payload.encode('utf-8')).hexdigest()
    front = {
        'source': 'granola',
        'source_id': detail['id'],
        'meeting_date': detail['date'],
        'extracted_at': extracted_at,
        'content_type': 'granola_summary_and_notes',
        'summary_notes_sha256': digest,
    }
    lines = ['---'] + [f'{k}: {json.dumps(v, ensure_ascii=False)}' for k, v in front.items()] + [
        '---', '', f"# {detail['title']}", '', '## Participantes', '', detail['known_participants'], '',
        '## Resumen generado por Granola', '', detail['summary'], '',
        '## Notas tomadas en Granola', '', detail['private_notes'], '',
        '## Proveniencia', '',
        '- Fuente: Granola MCP oficial.',
        '- Este archivo contiene el resumen generado y las notas privadas disponibles.',
        '- No se solicitó ni se incorporó la transcripción completa.',
        '', f"<!-- source_id={detail['id']}; summary_notes_sha256={digest}; date_key={date_key(detail['date'])} -->", '',
    ]
    return '\n'.join(lines)


async def call(session: ClientSession, name: str, args: dict, attempts: int = 5):
    for attempt in range(attempts):
        try:
            result = await session.call_tool(name, args)
            text = result_text(result)
            if getattr(result, 'isError', False) or text.startswith('Rate limit exceeded'):
                raise RuntimeError(text)
            return result
        except Exception:
            if attempt == attempts - 1:
                raise
            await asyncio.sleep(5 * (attempt + 1))


async def main():
    STAGING.mkdir(parents=True, exist_ok=True)
    extracted_at = datetime.now(timezone.utc).isoformat()
    discarded = discarded_sources()
    auth = build_oauth_auth('granola', URL, {})
    async with streamablehttp_client(URL, auth=auth, timeout=60, sse_read_timeout=600) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            listed = xml_root(result_text(await call(session, 'list_meetings', {'time_range': 'last_30_days'})))
            meetings = [dict(m.attrib) for m in listed.findall('.//meeting')]
            ids = [m['id'] for m in meetings if m.get('id')]
            details = {}
            for start in range(0, len(ids), 10):
                payload = xml_root(result_text(await call(session, 'get_meetings', {'meeting_ids': ids[start:start + 10]})))
                for meeting in meeting_nodes(payload):
                    item = detail_dict(meeting)
                    if item['id']:
                        details[item['id']] = item
            exported, unchanged, deferred, errors = [], [], [], []
            for mid in ids:
                try:
                    if mid in discarded:
                        deferred.append({'id': mid, 'reason': 'discarded_by_user'})
                        continue
                    detail = details.get(mid)
                    if not detail:
                        raise ValueError('Granola no devolvió detalle para la reunión')
                    if not has_content(detail):
                        # A new meeting may be listed before its summary is ready.
                        # Retry alone before deferring it to the next hourly export.
                        payload = xml_root(result_text(await call(session, 'get_meetings', {'meeting_ids': [mid]})))
                        fresh = next((detail_dict(m) for m in meeting_nodes(payload) if m.get('id') == mid), None)
                        if fresh and has_content(fresh):
                            detail = fresh
                        else:
                            deferred.append({'id': mid, 'reason': 'summary_and_notes_not_ready'})
                            continue
                    name = f"{date_key(detail['date'])}-{slugify(detail['title'])}.md"
                    target = STAGING / name
                    content = markdown(detail, extracted_at)
                    digest = re.search(r'summary_notes_sha256: "([^"]+)"', content).group(1)
                    if target.exists() and f'source_id: "{mid}"' in target.read_text(encoding='utf-8', errors='ignore') and digest in target.read_text(encoding='utf-8', errors='ignore'):
                        unchanged.append({'id': mid, 'file': str(target)})
                        continue
                    target.write_text(content, encoding='utf-8')
                    exported.append({'id': mid, 'file': str(target), 'bytes': target.stat().st_size, 'summary_notes_sha256': digest})
                except Exception as exc:
                    errors.append({'id': mid, 'error': repr(exc)})
    report = {'extracted_at': extracted_at, 'listed': len(meetings), 'exported': exported, 'unchanged': unchanged, 'deferred': deferred, 'errors': errors, 'transcript_requested': False}
    (STAGING / 'extraction-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
