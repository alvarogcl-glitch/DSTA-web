# DSTA multiusuario: plan y checklist de avance

Fuente de verdad del avance. Se actualiza al cerrar cada tarea. Se marca `[x]` solo si está verificado con una prueba o evidencia, que se anota al lado.

- **Repo / rama:** worktree `C:/Users/admin/Documents/DSTA-multiuser/dsta-web-mu`, rama `feat/multiusuario` (creada desde `main` 73b64be).
- **Diseño:** `C:/Users/admin/Startup Team/reports/dsta-multiusuario-rutas-v2-2026-10-13.md` (ruta 1+).
- **Producción** (`dsta-web`, carpeta `Codex/2026-09-22/hola/work/DSTA-web`): NO se toca hasta F6, y F6 requiere aprobación explícita del CEO.
- **Staging:** Worker `dsta-web-staging` en workers.dev, con D1 y DO propios y solo datos sintéticos (`wrangler.staging.jsonc`).

## Requisitos del CEO (2026-10-13)

1. Cada usuario se registra (por invitación) y luego inicia sesión.
2. Cada usuario define, modifica y desarrolla su propia estructura de LTs y tareas.
3. Cada usuario puede conectar su cuenta Granola para obtener sus minutas.
4. Cada usuario tiene su propio espacio en Vikunja, con sus LTs.
5. Copilot: primario Hermes del CEO, respaldo Claude del CEO. A futuro, cada usuario podrá conectar su LLM. **Sin Ollama.**
6. Decisión registrada: el CEO asume el riesgo de términos de uso de usar sus cuentas en este piloto personal. El aislamiento de memoria y datos se mantiene igual.

## Reglas de ejecución

- TDD: primero la prueba que falla, luego el cambio.
- Nunca secretos, contraseñas, tokens ni cookies en logs, commits o reportes.
- No conectar Vikunja ni Granola reales ni el Hermes del CEO con datos de otros usuarios en staging. Para eso se usa el Vikunja de laboratorio o mocks.
- Commits pequeños en `feat/multiusuario`. Sin merge a `main` ni deploy de `dsta-web` sin el CEO.

## Checklist

### F0 · Cuentas y cajones separados (staging, datos sintéticos)
- [x] F0.1 Auth del piloto (D1: users, sessions, login_limits, invitations) integrada en `worker.js`, reemplazando Basic Auth. Se activa solo con `AUTH_MODE=accounts`; sin esa variable, producción no cambia y su suite completa pasa. Commit 01c949f.
- [x] F0.2 `chatStub` por actor (`u:<actorId>` o `users.do_name`): snapshot, chat, jobs y acciones aislados por usuario. El fallback KV legado queda desactivado en los cajones de usuario.
- [x] F0.3 El puente exige `X-DSTA-Actor` y el cajón se resuelve desde D1. Sin usuario: 400; usuario inexistente: 404; token inválido: 401.
- [x] F0.4 UI: `/login`, `/invite` (token en `#`) y barra de cuenta con logout. Verificado en navegador a 390 px: invitación → login → dashboard propio → logout. Commit aa96eab.
- [x] F0.5 `tests/test_multiuser_worker.mjs` (11 bloques) incluido en `npm test`; además 25/25 con `staging_isolation_check.py` contra wrangler dev.
- [x] F0.6 `dsta-web-staging` desplegado en https://dsta-web-staging.alvaro-gcl.workers.dev (versión bd94c2f1; D1 `dsta-web-staging-db` aa680c9d). 25/25 pruebas contra la URL real. Producción `dsta-web` sin cambios (deployments idénticos).

### F1 · Puente multiusuario
- [x] F1.1 Despachador `/api/bridge/dispatch`: un sondeo para N usuarios. Las escrituras del navegador marcan el tipo de trabajo, y una confirmación nunca borra una marca más nueva que la lectura (test 13 del Worker). El puente también acepta `/u/<actor>/api/bridge/...`.
- [x] F1.2 `tools/multiuser_bridge.py` y `tools/user_vault.py` (DPAPI). Cada trabajo corre con el token, la raíz y el directorio de su usuario; los usuarios sin vault se ignoran (4 tests del puente y 4 del vault).
- [x] F1.3 `tools/user_context.py`: contextvar con default 2. Se usa en el publicador, la completación, las etiquetas y el MCP (`DSTA_ROOT_PROJECT_ID`). La suite de producción sigue pasando.
- [x] F1.4 `tests/e2e_multiuser_lab.py`: 23/23 con Vikunja de laboratorio :14701 y wrangler dev. La acción de A se ejecuta con el token de A, la tarea de B no cambia y el token de A recibe 403 sobre la raíz de B.
- [~] F1.5 Cálculo (no medido en Cloudflare): despacho cada 3 s = 28.800/día, más un snapshot cada 120 s por usuario (720/día). Con 15 usuarios son unas 40.000/día del puente multiusuario, frente a 100.000-120.000/día del puente actual. **Pendiente:** medirlo con datos reales de Cloudflare en F6.

### F2 · Alta de usuarios
- [x] F2.1 `tools/provision_user.py provision`: cuenta Vikunja con contraseña aleatoria, raíz propia, token API acotado a 7 grupos y 365 días, vault DPAPI e invitación de un solo uso (solo hash en D1).
- [x] F2.2 `provision_user.py remove`: revoca el token de Vikunja, borra el cajón del DO (`/api/bridge/wipe`, prohibido para `pmo-dsta`), la cuenta, las sesiones y las invitaciones en D1, y el vault. La cuenta Vikunja se conserva y se desactiva a mano si hace falta.
- [x] F2.3 Incluida en el e2e de laboratorio: tras la baja, el token responde 401, la sesión 401, el login 401 y el vault ya no existe.

### F3 · LTs y tareas desde la UI
- [x] F3.1 `task.create`, `task.update`, `task.move`, `lt.create`, `lt.rename` y `lt.archive` en la cola de acciones. Esquema estricto por acción (`complete` conserva su contrato de 1 KB), alcance limitado al snapshot y un solo cambio pendiente por elemento. Se completan solo con un snapshot posterior que prueba el resultado. En el puente, `tools/structure_actions.py` reenvía objetos completos (Vikunja borra los campos omitidos) y no duplica creaciones en reintentos. Tests: `test_structure_actions.mjs` y 7 en Python.
- [x] F3.2 `public/structure-actions.js`: botón «+ Nueva línea»; en el inspector de una LT, «+ Nueva tarea», «Renombrar» y «Archivar»; en el de una tarea, «Editar» y «Mover». Diálogos accesibles; la vista se refresca solo cuando el Worker confirma.
- [x] F3.3 `tests/e2e_structure_lab.py` y `e2e_structure_ui.mjs`: navegador, puente multiusuario real en bucle, Vikunja de laboratorio y wrangler dev. 7/7: A crea, edita, mueve, renombra y archiva (unos 3 s por acción) y B no ve nada.

### F4 · Granola por usuario
- [x] F4.1 OAuth Granola por usuario. El Worker coordina la URL de autorización y el `state`, y el callback `/oauth/granola/callback` exige la sesión del mismo usuario y un state de un solo uso. El canje PKCE se hace en la VM (`tools/granola_user.py` sobre el cliente vendorizado de Codex, `tools/granola_client.py`), con los tokens cifrados en el vault. **Pendiente:** refresh del token; hoy, al vencer, el usuario debe reconectar.
- [x] F4.2 El puente importa las reuniones del usuario conectado (al conectar y cada hora) en SU bandeja: título, fecha y resumen. Las notas privadas no salen de la VM. Las acciones propuestas llegan con F5.
- [~] F4.3 Probado contra un Granola sintético (`tests/fake_granola.py`): 2 tests de la VM, 3 del puente, el bloque 15 del Worker y el E2E en navegador 7/7 (`e2e_granola_lab.py`). **Pendiente:** la prueba con Granola real, que requiere una cuenta de prueba y que Granola acepte el redirect en workers.dev (decisión del CEO).

### F5 · Copilot por usuario
- [x] F5.1 Hermes con `--ignore-rules --ignore-user-config` y solo el toolset `todo`: sin SOUL ni memoria del CEO, sin MCP (por lo tanto sin su token de Vikunja), sin `fallback_providers` (nunca Ollama) y sin terminal, archivos ni cronjob. La sesión del usuario se purga del historial del CEO después de cada respuesta. Se descartó el home dedicado porque compartir el `auth.json` OAuth entre homes arriesga romper el refresh del token del CEO.
- [x] F5.2 Respaldo Claude con `--tools "" --strict-mcp-config --no-session-persistence` en un directorio vacío por usuario. Verificado en vivo: responde con el contexto del usuario y declara que no tiene herramientas.
- [x] F5.3 Se resolvió más fuerte que lo planeado: el Copilot multiusuario **no usa MCP**. El puente arma un contexto con el snapshot del usuario (leído con SU token y SU raíz) y sus minutas; nada más llega al modelo. Es de solo lectura: propone y la persona aplica los cambios con las acciones F3. **Siguiente incremento (no hecho):** que proponga acciones estructuradas confirmables con un clic.
- [x] F5.4 Perfil `llm` en el vault de cada usuario. Hoy solo existe `ceo-hermes` (por defecto); cualquier otro proveedor responde "aún no disponible" sin usar las cuentas del CEO. Ese es el punto de enchufe para la API key propia del usuario.
- [x] F5.5 Canarios en vivo con Hermes real (`tests/e2e_copilot_lab.py`), 6/6: A recibe su tarea y nada de B, B no obtiene nada de A, el Copilot no conoce al CEO ("NO_SE") y no quedan sesiones de usuarios en el Hermes del CEO. La primera corrida detectó que el `session_id` sale por stderr; se corrigió con una purga por usuario, y las 3 sesiones de prueba que habían quedado se borraron. Además hay 7 tests unitarios y 1 de integración en el puente.

### F6 · Paso a producción (REQUIERE APROBACIÓN DEL CEO)
- [~] F6.1 **Preparado y ensayado, no ejecutado.** `users.do_name='pmo-dsta'`; el bloque 16 del test prueba que el CEO ve sus datos sin migración y que el puente actual funciona sin cambios de código apuntando a `/u/ceo`. El runbook está en `docs/F6_CUTOVER.md`.
- [~] F6.2 Rollback documentado en `docs/F6_CUTOVER.md` (menos de 5 minutos, sin datos que revertir). **No ensayado contra producción**, por regla.
- [ ] F6.3 Pendiente: requiere la aprobación del CEO, Workers Paid, los usuarios piloto y la decisión sobre Granola real.

## Bitácora
- 2026-10-12 23:15 (Chile): plan creado; worktree y rama creados. Inicio de ejecución autónoma hasta 06:00, con reporte cada hora por Telegram.
- 2026-10-12 23:25: **F0 completa.** Staging desplegado y verificado 25/25. El token del puente de staging vive en `%LOCALAPPDATA%/dsta-staging/bridge-token`, fuera del repo.
- 2026-10-12 23:38: **F1 completa** (F1.5 calculada, medición pendiente) y **F2 completa**. Staging redeployado (versión ef32fbf2), 25/25 contra la URL real. `npm test`: 117 Python OK más 15 suites Node.
- 2026-10-12 23:42: **F3 completa.** UI E2E 7/7 con el puente real; `npm test` en verde.
- 2026-10-12 23:50: **F4 completa con Granola sintético.** La prueba real queda pendiente de una cuenta de prueba.
- 2026-10-12 23:59: **F5 completa.** Canarios en vivo 6/6 y respaldo Claude verificado en vivo. **Decisión operativa:** el puente de staging no queda corriendo toda la noche, porque sumaría ~10.000 requests/día a la cuenta donde producción ya usa casi todo el plan gratis de Workers y podría tumbarla.
- 2026-10-13 00:02: F6 preparada: ensayo de cutover en test (bloque 16) y runbook. **No se tocó producción.**
