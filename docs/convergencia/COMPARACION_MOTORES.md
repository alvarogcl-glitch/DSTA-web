# Comparación de motores del copiloto: Codex directo, Claude y Hermes (15-10-2026)

Pedido del CEO (Telegram, 15-10). Pruebas solo de lectura: no se ejecutó nada en Vikunja. Se corrieron 2 vueltas por caso.

- **Datos:** el portafolio real del CEO (7 LT, 144 tareas) y sus minutas.
- **Script y datos crudos:** `evidencia/motores/bench-copiloto-2026-10-15.jsonl`.
- **Motores:**
  - Codex directo: `codex.exe exec`, `gpt-6-luna`, razonamiento `low`, `--ignore-user-config`, solo lectura.
  - Claude Code: `sonnet`.
  - Hermes: el actual, proveedor `openai-codex`, `gpt-6-luna`.

## Modo A: con herramientas (copiloto actual del dueño)

Cada motor lee Vikunja y las minutas mediante los MCP. Para Claude y Codex, Vikunja va en `--read-only`.

| Caso | Codex | Claude | Hermes |
|---|---|---|---|
| Saludo | 5,9 s | 8,8 s | 17,6 s |
| Minutas de hoy | 10,1 s | 8,9 s | 24,7 s |
| Contenido de una minuta | 9,6 s | 10,2 s | 28,2 s |
| Estado de una tarea | 13,0 s | 33,8 s | 37,3 s |
| Vencimientos | 14,4 s | 33,7 s | 38,8 s |
| **Promedio** | **10,6 s** | **19,1 s** | **29,3 s** |

Los tres respondieron correctamente las 10 consultas.

## Modo B: contexto en el prompt (copiloto multiusuario)

Las acciones se piden como propuesta (bloque `acciones`) y se validan con `split_proposals`; nunca se envían.

| Caso | Codex | Claude | Hermes |
|---|---|---|---|
| Saludo | 6,3 s | 7,5 s | 19,7 s |
| Minutas de hoy | 5,9 s | 7,3 s | 21,7 s |
| Contenido de una minuta | 5,4 s | 6,3 s | 22,7 s |
| Estado de una tarea | 6,3 s | 5,9 s | 19,7 s |
| Vencimientos | 6,3 s | 7,5 s | 21,2 s |
| Crear tarea | 5,3 s ✓ | 4,5 s ✓ | 21,7 s ✓ |
| Completar tarea | 5,8 s ✓ | 7,5 s ✓ | 23,2 s (1/2) |
| Mover tarea | 5,3 s ✓ | 7,1 s ✓ | 21,7 s ✓ |
| Modificar tarea / etiquetar / archivar LT | ✗ | ✗ | ✗ |
| **Promedio** | **5,8 s** | **7,0 s** | **21,2 s** |

Los tres motores fallaron en modificar, etiquetar y archivar por la misma causa: el contexto se recorta a 26.000 caracteres (`MAX_CONTEXT_CHARS`). Con el portafolio del CEO, las tareas y líneas pedidas (#143, «DSTA - Transversal») quedaron fuera. Los tres se negaron a inventar IDs, que es lo correcto. Ese límite existía por la línea de comandos de Hermes; con el transporte stdin (E14) ya puede ampliarse.

## Ejecución de una acción ya decidida

Es igual para los tres motores. Medido en 17 acciones reales del 15-10:

- Vikunja: 0,16 s.
- Snapshot: 1,39 s.
- Confirmación: 0,48 s.
- Total: mediana 2,1 s, p90 2,4 s.

A eso se suman hasta 8 s de espera a que la VM recoja la acción.
