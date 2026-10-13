# Piloto Cloudflare de aislamiento multiusuario

Proyecto deliberadamente separado del Worker de producción `dsta-web`. El nombre del Worker es `dsta-multiuser-pilot-20261012`; el despliegue previsto es únicamente en `workers.dev`, sin rutas de dominio propio.

## Alcance

- Dos cuentas sintéticas, `cuenta-a@dsta.test` y `cuenta-b@dsta.test`.
- Usuarios, sesiones revocables y registros de prueba almacenados en Cloudflare D1.
- Contraseñas elegidas por cada persona (invitación) o con entrada oculta (seeder), mínimo 14 caracteres; D1 conserva solo salt y hash PBKDF2-SHA256 (100.000 iteraciones, el máximo que acepta el runtime de Workers).
- Cookies `Secure`, `HttpOnly` para sesión, `SameSite`, validación de `Origin` y CSRF para mutaciones; máximo 10 intentos de login por IP/minuto, guardando solo el hash de la IP.
- La API asigna `actor_id` desde la sesión; filtra lecturas y escrituras por actor. El identificador ajeno responde `404`.
- Interfaz permite crear datos sintéticos, intentar una lectura cruzada y cerrar/revocar sesión.
- Sin OAuth, llamadas a Vikunja/Granola/Ollama, datos reales ni integración con producción.

Es una prueba de aislamiento, no un port completo del dashboard FastAPI ni una configuración para datos reales.

## Pruebas

Desde esta carpeta:

```bash
node --experimental-sqlite --test tests/worker.test.mjs
node --check src/index.mjs
node --check public/app.js
```

La suite ejecuta el Worker contra SQLite de Node y aplica la migración D1 real. El modo SQLite de Node es experimental en Node 24; solo se usa en pruebas.

## Ejecutar localmente

`wrangler.jsonc` incluye un UUID local de reserva como `database_id`, no un identificador D1 remoto. No desplegar con ese valor.

```bash
python tools/seed_demo_accounts.py --local
npx wrangler dev --local --port 14904 --persist-to 'C:/Users/admin/AppData/Local/Temp/dsta-multiuser-pilot-local-20261012' --config wrangler.jsonc
```

El script pide en la terminal, con entrada oculta (`getpass`, sin eco), una contraseña sintética para cada cuenta, con confirmación y mínimo de 14 caracteres. Luego aplica la migración e inserta los dos usuarios y dos registros sintéticos. D1 recibe solo salt y hash PBKDF2-SHA256: la contraseña no se imprime, no se registra en logs, no pasa por argumentos, variables de entorno ni salida de Wrangler, y no se escribe en archivos. Sin una terminal interactiva el script se detiene sin tocar D1. Las pruebas del seeder están en `tests/test_seed_demo_accounts.py` (`python -m unittest discover -s tests -p "test_seed_demo_accounts.py"`). Reiniciar el seeder no es idempotente: la inserción duplicada falla, en vez de cambiar credenciales en silencio.

## Cuentas por invitación (método recomendado)

Cada persona crea su propia contraseña en el navegador; nadie más la ve ni la escribe por ella.

- `tools/create_invites.py --remote --base-url <URL real>` genera un link de un solo uso por cuenta (A y B), con vigencia de 24 h (`--ttl-hours`, máximo 72). D1 guarda solo el SHA-256 del token (tabla `invitations`, migración `0003`). El token viaja en el fragmento `#t=…`, que el navegador no envía al servidor, y la página lo borra de la barra de direcciones al cargar. Emitir links nuevos revoca los anteriores sin usar de esas cuentas.
- La página `/invite` envía la contraseña a `POST /api/auth/accept-invite`. Esa ruta exige Origin propio y comparte el límite de intentos por IP del login. Exige además entre 14 y 256 caracteres, y reclama la invitación de forma atómica: solo un uso. Crea la cuenta con salt y hash PBKDF2 y su registro sintético inicial. Si la cuenta ya existe responde `409` y no la sobrescribe. Ante un token vencido, usado o desconocido responde `400`.
- Los links impresos son credenciales temporales: entregarlos solo a su dueño. Si alguien abre un link antes que su dueño, este verá "Invitación inválida, vencida o ya usada"; entonces hay que borrar esa cuenta y emitir otro link.

El seeder interactivo (`seed_demo_accounts.py`) sigue disponible como alternativa cuando quien opera tiene una terminal en la VM.

## Despliegue remoto

Requiere que `CLOUDFLARE_API_TOKEN` tenga permisos de cuenta `D1:Edit`, `Workers Scripts:Edit` y `Workers Assets:Edit`. Trabajar solo desde esta carpeta y con `--config wrangler.jsonc`; no tocar `dsta-web`.

1. Base D1 `dsta-multiuser-pilot-20261012-db` creada el 2026-10-13; su ID ya está en `wrangler.jsonc`.
2. `npx wrangler d1 migrations apply dsta-multiuser-pilot-20261012-db --remote --config wrangler.jsonc`
3. `npx wrangler deploy --config wrangler.jsonc`, y anotar la URL que devuelve.
4. `python tools/remote_isolation_check.py --auto <URL>`. Crea dos cuentas QA temporales por invitación, con contraseñas aleatorias que existen solo en memoria. Prueba login y restauración de sesión, aislamiento de listados, `404` en lecturas ajenas, `actor_id` suplantado, Origin/CSRF, logout independiente y límite de intentos. Al final elimina las cuentas QA, también si algo falla. El log contiene solo nombres de prueba y estados HTTP.
5. `python tools/create_invites.py --remote --base-url <URL>`, y entregar cada link a su dueño.

Sin `--auto`, `remote_isolation_check.py` usa las cuentas A y B y pide sus contraseñas con entrada oculta. Nunca usar contraseñas de cuentas reales.
