# DSTA multiusuario: arquitectura y operación

Rama `feat/multiusuario`. El plan y el estado están en `MULTIUSUARIO_PLAN.md`; el paso a producción, en `F6_CUTOVER.md`.

## Idea central
El mismo Worker `dsta-web`, con un interruptor: sin `AUTH_MODE` se comporta exactamente como hoy (Basic Auth, un solo cajón `pmo-dsta`); con `AUTH_MODE=accounts` pasa a cuentas por persona y un cajón (Durable Object) por usuario. La VM sigue haciendo **solo conexiones salientes**.

```
Navegador (cuenta A) ──cookie de sesión──▶ Worker ──▶ DO "u:A"  (snapshot, Copilot, acciones, minutas, Granola de A)
Navegador (cuenta B) ──cookie de sesión──▶ Worker ──▶ DO "u:B"
                                             ▲  D1: users, sessions, login_limits, invitations (solo hashes)
                                             │  DO "dispatch": quién tiene trabajo pendiente
VM: multiuser_bridge ── GET /api/bridge/dispatch (1 sondeo para N usuarios)
                     ── /u/<actor>/api/bridge/...  (colas del usuario)
                     ── vault DPAPI por usuario: token y raíz de Vikunja, tokens de Granola, minutas, perfil LLM
                     ── Vikunja (cuenta propia de cada usuario) · Granola OAuth propio · Copilot aislado (Hermes → Claude del CEO)
```

## Componentes
| Pieza | Archivo | Qué hace |
|---|---|---|
| Cuentas | `src/worker.js` (bloque «Accounts mode»), `migrations/0001_accounts.sql` | Login PBKDF2 100k, sesiones revocables (hash), límite por IP, invitaciones de un solo uso, CSRF por `Origin` |
| Cajones | `chatStub(env, box)`, `users.do_name` | Un DO por usuario; el KV legado solo es visible para `pmo-dsta` |
| Puente por usuario | `/u/<actor>/api/bridge/*`, `bridgeBox` | El actor se resuelve desde D1; el puente de usuario único funciona igual con la base `/u/<actor>` |
| Despacho | `/api/bridge/dispatch`, DO `dispatch` | Marcas por tipo (`chat`, `action`, `label`, `health`, `granola`); un ack nunca borra una marca más nueva |
| Estructura (F3) | `ACTION_SCHEMAS` y `actionResultMatches` en el Worker, `tools/structure_actions.py`, `public/structure-actions.js` | Crear, editar, mover y archivar LT y tareas; se verifican con un snapshot posterior |
| Puente multiusuario | `tools/multiuser_bridge.py` | Despacho, barrido cada 5 min, snapshot cada 120 s, Granola cada hora, Copilot en un pool de 2 |
| Vault | `tools/user_vault.py` | DPAPI de la cuenta Windows con entropía de la app; `%LOCALAPPDATA%/dsta-multiuser/vault` |
| Raíz por usuario | `tools/user_context.py` | Contextvar que usan el publicador, la completación, las etiquetas y el MCP |
| Alta y baja | `tools/provision_user.py` | Cuenta Vikunja, raíz, token acotado, vault e invitación; la baja revoca y borra todo |
| Granola (F4) | `tools/granola_client.py` (de Codex), `tools/granola_user.py`, `/oauth/granola/callback` | PKCE; el canje y los tokens quedan solo en la VM; la bandeja recibe título, fecha y resumen |
| Copilot (F5) | `tools/user_copilot.py` | Hermes `--ignore-rules --ignore-user-config -t todo`, purga de sesiones; respaldo Claude sin herramientas |

## Operar staging
- URL: https://dsta-web-staging.alvaro-gcl.workers.dev (D1 `dsta-web-staging-db`). El token del puente está en `%LOCALAPPDATA%/dsta-staging/bridge-token`, fuera del repo.
- Deploy: `npx wrangler deploy --config wrangler.staging.jsonc`, con el token de Cloudflare solo en el proceso hijo.
- Verificación: `DSTA_STAGING_BRIDGE_TOKEN=… python tools/staging_isolation_check.py <URL>` (25 pruebas, cuentas QA temporales).
- Alta de un usuario: `python tools/provision_user.py provision --actor ana --email … --name … --dashboard-url <URL> --vikunja-url http://127.0.0.1:14701`.
- Puente: `python tools/multiuser_bridge.py --env-file <archivo con DSTA_DASHBOARD_URL y DSTA_BRIDGE_TOKEN>`. **No dejarlo corriendo contra staging sin Workers Paid**: comparte el cupo de requests con producción.

## Pruebas
- `npm test`: incluye `test_multiuser_worker.mjs` (16 bloques) y `test_structure_actions.mjs`. Las de Python incluyen vault, puente, aprovisionamiento, estructura, Granola y Copilot.
- E2E de laboratorio (requieren Vikunja de laboratorio `:14701` y `wrangler dev`): `tests/e2e_multiuser_lab.py` (23), `e2e_structure_lab.py` (7, navegador), `e2e_granola_lab.py` (7, navegador y Granola sintético), `e2e_copilot_lab.py` (6, Hermes real).
- En Windows, `PYTHONUTF8=1 npm test`.

## Límites conocidos
- El Copilot multiusuario no escribe por sí mismo: propone acciones (bloque ```acciones```) y la persona las aplica con un clic, por la cola verificada de F3.
- Granola: falta la prueba con el servicio real; el refresh solo está probado contra el Granola sintético.
- La bandeja multiusuario no genera acciones propuestas desde las minutas; eso sí ocurre en el modo del CEO.
- Requests/día calculados, no medidos.
