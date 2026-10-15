"""Manual minutes (dashboard, typed or handwritten + transcribed) as copilot-readable minutes.

They live in the minutes inbox store on the VM (owner: hermes/cache/dsta-minute-inbox.json; each
user: users/<actor>/minute-inbox.json), not as Granola files. This turns those records into the same
shape the copilot already uses for Granola minutes, with ids «Manual/<id>»."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

PREFIX = "Manual/"
MANUAL_SOURCES = {"Manual-Dashboard"}


def _notes(texto: str) -> tuple[str, dict]:
    """The analysis keeps the minute as a JSON block (title, date, private_notes…) or, in older
    records, as plain text. Return the readable notes and the block's metadata."""
    text = str(texto or "").strip()
    if text.startswith("{"):
        try:
            block = json.loads(text)
        except ValueError:
            return text, {}
        body = next((str(block[key]) for key in ("private_notes", "body", "content", "summary") if block.get(key)), "")
        return body.strip(), block
    return text, {}


def entries(store: Path) -> list[dict[str, Any]]:
    """Every manual minute in an inbox store, newest first. Deleted ones are left out."""
    try:
        data = json.loads(Path(store).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    found = []
    for record in (data.get("minutes") or {}).values():
        if record.get("source") not in MANUAL_SOURCES or record.get("eliminadaEn"):
            continue
        notes, block = _notes(record.get("texto", ""))
        if not notes:
            continue
        title = str(record.get("titulo") or block.get("title") or "Minuta manual")
        date = str(record.get("fecha") or str(block.get("date") or "")[:10])
        source_id = str(record.get("sourceId") or "")
        found.append({"id": PREFIX + str(record["id"]), "titulo": title, "fecha": date,
                      # the dashboard draft: its handwriting (if any) is shown next to the text
                      "borrador": source_id[len("manual-"):] if source_id.startswith("manual-") else "",
                      "origen": "Manual (dashboard)", "contenido": f"# {title}\n\nFecha: {date}\nOrigen: minuta manual del dashboard"
                      + (" (incluye escritura a mano transcrita)" if "[Escrito a mano" in notes else "") + f"\n\n{notes}"})
    found.sort(key=lambda item: (item["fecha"], item["id"]), reverse=True)
    return found


def by_id(store: Path) -> dict[str, dict[str, Any]]:
    return {item["id"]: item for item in entries(store)}
