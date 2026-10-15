"""Handwritten manual minutes (iPad pencil): render the dashboard's vector ink to page images and
transcribe them with Claude (vision) on the VM. The text goes back to the draft for the user to
review; the analysis itself keeps working on text."""
from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

PAGE_W, PAGE_H = 1000, 1414
SCALE = 1.2
COLORS = ["#1b1b1b", "#1f4fd1", "#c62828"]
WIDTHS = [2, 3.5, 6]
MAX_PAGES = 20
PROMPT = (
    "Estas imágenes son hojas de notas manuscritas de una reunión de trabajo, escritas a mano en un iPad "
    "(en español). Transcribe fielmente TODO el texto, en orden de lectura, hoja por hoja. Conserva la "
    "estructura: títulos, viñetas (usa «- »), numeraciones, flechas (→) y saltos de línea. Corrige solo "
    "errores de ortografía evidentes sin cambiar el sentido; no resumas, no completes ni interpretes. "
    "Si una palabra es ilegible escribe [ilegible]. Si hay un dibujo o diagrama, descríbelo en una línea "
    "entre corchetes. Responde SOLO con la transcripción, sin comentarios ni encabezados propios."
)


class TranscriptionError(RuntimeError):
    pass


def decode(ink: str) -> list[list[dict]]:
    """Pages of strokes {c, w, pts:[(x, y, p), ...]} from the delta-encoded dashboard format."""
    data = json.loads(ink)
    if data.get("v") != 1:
        raise TranscriptionError("Formato de escritura desconocido.")
    pages = []
    for page in data.get("pages", [])[:MAX_PAGES]:
        strokes = []
        for color, width, deltas in page:
            x = y = 0
            pts = []
            for i in range(0, len(deltas) - 2, 3):
                x += int(deltas[i]); y += int(deltas[i + 1])
                pts.append((x, y, int(deltas[i + 2])))
            if pts:
                strokes.append({"c": int(color), "w": int(width), "pts": pts})
        pages.append(strokes)
    return pages


def render(ink: str) -> list[bytes]:
    """One PNG per page with writing, white background, cropped below the last stroke."""
    images = []
    for strokes in decode(ink):
        if not strokes:
            continue
        bottom = max(p[1] for s in strokes for p in s["pts"])
        height = min(PAGE_H, bottom + 80)
        image = Image.new("RGB", (int(PAGE_W * SCALE), int(height * SCALE)), "white")
        draw = ImageDraw.Draw(image)
        for stroke in strokes:
            color = COLORS[stroke["c"]] if 0 <= stroke["c"] < len(COLORS) else COLORS[0]
            base = WIDTHS[stroke["w"]] if 0 <= stroke["w"] < len(WIDTHS) else WIDTHS[1]
            pts = stroke["pts"]
            for index, (x, y, pressure) in enumerate(pts):
                width = max(1.0, base * SCALE * (0.5 + pressure / 10))
                if index:
                    px, py, _ = pts[index - 1]
                    draw.line([(px * SCALE, py * SCALE), (x * SCALE, y * SCALE)], fill=color, width=round(width))
                r = width / 2
                draw.ellipse([x * SCALE - r, y * SCALE - r, x * SCALE + r, y * SCALE + r], fill=color)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        images.append(buffer.getvalue())
    return images


def transcribe(ink: str, claude_cli: str, model: str = "sonnet", timeout: int = 240) -> str:
    images = render(ink)
    if not images:
        return ""
    if not claude_cli:
        raise TranscriptionError("No hay modelo de visión configurado en la VM.")
    content = [{"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                            "data": base64.b64encode(png).decode("ascii")}} for png in images]
    content.append({"type": "text", "text": PROMPT})
    message = json.dumps({"type": "user", "message": {"role": "user", "content": content}}) + "\n"
    with tempfile.TemporaryDirectory(prefix="dsta-ink-") as work:  # no project files or instructions around
        result = subprocess.run(
            [claude_cli, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
             "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--model", model],
            input=message.encode("utf-8"), capture_output=True, cwd=work, timeout=timeout, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
    final = None
    for line in result.stdout.decode("utf-8", errors="replace").splitlines():
        if line.startswith("{"):
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("type") == "result":
                final = event
    if result.returncode != 0 or not final or final.get("is_error") or not str(final.get("result", "")).strip():
        raise TranscriptionError("La transcripción no respondió.")
    return str(final["result"]).strip()[:60_000]


if __name__ == "__main__":  # manual check: python ink_transcribe.py ink.json
    import sys
    text = Path(sys.argv[1]).read_text(encoding="utf-8")
    for i, png in enumerate(render(text), 1):
        Path(f"hoja-{i}.png").write_bytes(png)
