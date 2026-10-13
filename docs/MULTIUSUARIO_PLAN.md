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
- [ ] F3.1 Acciones crear/editar/mover/archivar de LT y tarea en la cola de acciones.
- [ ] F3.2 UI para esas acciones.
- [ ] F3.3 E2E con 2 usuarios.

### F4 · Granola por usuario
- [ ] F4.1 OAuth Granola: callback vía Worker, canje y refresh en la VM.
- [ ] F4.2 Bandeja de minutas por usuario.
- [ ] F4.3 Prueba con mock; prueba real pendiente de una cuenta Granola de prueba (decisión del CEO).

### F5 · Copilot por usuario
- [ ] F5.1 Hermes con home dedicado, `--ignore-rules`, sin memoria del CEO y sin fallback Ollama.
- [ ] F5.2 Claude CLI respaldo con config dedicada.
- [ ] F5.3 MCP por job que falla cerrado (nunca el token del CEO para otro usuario).
- [ ] F5.4 `llm_profile` por usuario (preparado para su LLM futuro).
- [ ] F5.5 Pruebas canario: token del CEO y memoria del CEO ausentes; pregunta cruzada → "no encontrado".

### F6 · Paso a producción (REQUIERE APROBACIÓN DEL CEO)
- [ ] F6.1 Mapeo del CEO al DO `pmo-dsta`, su token y la raíz 2, sin migrar datos.
- [ ] F6.2 Plan de rollback (`wrangler rollback`) probado.
- [ ] F6.3 Deploy aprobado y 2 usuarios piloto durante 2 semanas.

## Bitácora
- 2026-10-12 23:15 (Chile): plan creado; worktree y rama creados. Inicio de ejecución autónoma hasta 06:00, con reporte cada hora por Telegram.
- 2026-10-12 23:25: **F0 completa.** Staging desplegado y verificado 25/25. El token del puente de staging vive en `%LOCALAPPDATA%/dsta-staging/bridge-token`, fuera del repo.
- 2026-10-12 23:38: **F1 completa** (F1.5 calculada, medición pendiente) y **F2 completa**. Staging redeployado (versión ef32fbf2), 25/25 contra la URL real. `npm test`: 117 Python OK más 15 suites Node.
