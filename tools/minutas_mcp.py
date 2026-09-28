"""Read-only access to the Granola meeting minutes for the DSTA web copilot.

Only Markdown files inside the configured minutes folders can be listed, searched
or read. The server exposes no write, move or delete operation.
"""
from __future__ import annotations

import os
import re
import unicodedata
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP


PMO_ROOT = Path(r"C:\Users\admin\.openclaw\workspace\proyectos\pmo-dsta")
DEFAULT_DIRS = (PMO_ROOT / "Minutas 2026", PMO_ROOT / "07_reuniones")
MAX_READ_CHARS = 60_000
DATE_PREFIX = re.compile(r"^(20\d{2}-\d{2}-\d{2})")
FRONTMATTER = re.compile(r"\A---\n.*?\n---\n", re.DOTALL)
STOPWORDS = {"de", "la", "el", "en", "los", "las", "del", "que", "con", "por", "para", "un", "una", "se", "al", "lo", "y"}

mcp = FastMCP("dsta-minutas")


def minutes_dirs() -> list[Path]:
    configured = os.environ.get("DSTA_MINUTAS_DIRS", "")
    dirs = [Path(item) for item in configured.split(os.pathsep) if item.strip()] or list(DEFAULT_DIRS)
    return [folder.resolve() for folder in dirs if folder.is_dir()]


def fold(text: str) -> str:
    """Lowercase without accents, so 'reunion' finds 'reunión'."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(char for char in decomposed if not unicodedata.combining(char)).casefold()


def minute_files() -> dict[str, Path]:
    """Map a stable ID ('<carpeta>/<ruta>') to each minute; duplicated names keep the first folder."""
    files: dict[str, Path] = {}
    seen_names: set[str] = set()
    for folder in minutes_dirs():
        for path in sorted(folder.rglob("*.md")):
            if path.name in seen_names:
                continue
            seen_names.add(path.name)
            files[f"{folder.name}/{path.relative_to(folder).as_posix()}"] = path
    return files


def read_text(path: Path) -> str:
    text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
    return FRONTMATTER.sub("", text, count=1).strip()


def title_of(text: str, path: Path) -> str:
    heading = next((line[2:].strip() for line in text.splitlines() if line.startswith("# ")), "")
    return heading or path.stem


def summary_item(minute_id: str, path: Path, text: str) -> dict[str, Any]:
    match = DATE_PREFIX.match(path.name)
    return {"id": minute_id, "fecha": match.group(1) if match else "", "titulo": title_of(text, path)}


@mcp.tool()
def minutas_listar(desde: str = "", hasta: str = "", limite: int = 40) -> dict[str, Any]:
    """List meeting minutes, newest first. Optional date range in YYYY-MM-DD format."""
    items = []
    for minute_id, path in minute_files().items():
        item = summary_item(minute_id, path, read_text(path))
        if desde and (not item["fecha"] or item["fecha"] < desde):
            continue
        if hasta and (not item["fecha"] or item["fecha"] > hasta):
            continue
        items.append(item)
    items.sort(key=lambda item: (item["fecha"], item["id"]), reverse=True)
    limite = max(1, min(int(limite), 200))
    return {"total": len(items), "minutas": items[:limite]}


@mcp.tool()
def minutas_buscar(consulta: str, limite: int = 8) -> dict[str, Any]:
    """Search the minutes by words (accent-insensitive). Returns matching minutes with short excerpts."""
    terms = [term for term in fold(consulta).split() if len(term) > 1 and term not in STOPWORDS]
    if not terms:
        return {"ok": False, "error": "Indica al menos una palabra para buscar."}
    results = []
    for minute_id, path in minute_files().items():
        text = read_text(path)
        folded = fold(text)
        matched = [term for term in terms if term in folded]
        if not matched:
            continue
        excerpts = [line.strip() for line in text.splitlines()
                    if line.strip() and any(term in fold(line) for term in matched)][:4]
        item = summary_item(minute_id, path, text)
        item.update({"terminos_encontrados": len(matched), "extractos": [line[:300] for line in excerpts]})
        results.append(item)
    results.sort(key=lambda item: (item["terminos_encontrados"], item["fecha"]), reverse=True)
    limite = max(1, min(int(limite), 30))
    return {"ok": True, "total": len(results), "resultados": results[:limite]}


@mcp.tool()
def minutas_leer(id: str) -> dict[str, Any]:
    """Read one meeting minute by the id returned from minutas_listar or minutas_buscar."""
    path = minute_files().get(id.strip())
    if not path:
        return {"ok": False, "error": "No existe una minuta con ese id; usa minutas_buscar o minutas_listar."}
    text = read_text(path)
    item = summary_item(id.strip(), path, text)
    item.update({"ok": True, "contenido": text[:MAX_READ_CHARS], "truncado": len(text) > MAX_READ_CHARS})
    return item


if __name__ == "__main__":
    mcp.run(transport="stdio")
