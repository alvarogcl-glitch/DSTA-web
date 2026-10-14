"""Common envelope for imported minutes; adapters feed the existing inbox engine."""
import hashlib
import re
from datetime import datetime, timezone


def inbox_record(record: dict) -> dict:
    source_id = str(record['source_id'])
    source = record.get('source') or 'Granola'
    prefix = 'g-' if source == 'Granola' else 'm-' if source == 'Manual-Dashboard' else 's-'
    identity = source_id if prefix != 's-' else source + ':' + source_id
    return {
        'id': prefix + hashlib.sha256(identity.encode()).hexdigest()[:32],
        'source': source, 'sourceId': source_id[:200], 'digest': str(record['version'])[:64],
        'titulo': str(record.get('title') or 'Reunión sin título')[:200],
        'fecha': str(record.get('date') or '')[:10],
        'detectadaEn': datetime.now(timezone.utc).isoformat(),
        'resumen': str(record.get('summary') or '')[:800],
        'acciones': [], 'estado': 'procesada', 'vista': False,
    }


def source_label(record: dict) -> str:
    return str(record.get('source') or 'Granola')


def action_prefix(record: dict) -> str:
    return re.sub(r'[^a-z0-9-]+', '-', source_label(record).lower()).strip('-') or 'minute'
