# DSTA-web

Dashboard ejecutivo PMO-DSTA. La interfaz es HTML, CSS y JavaScript sin framework ni etapa de compilación. Un Cloudflare Worker protege el sitio, sirve los archivos estáticos y expone la API del dashboard. La VM consulta Vikunja y publica snapshots autenticados que el Worker guarda en un Durable Object.

## Estructura

```text
public/index.html            Dashboard real
src/worker.js                Autenticación, API y entrega de archivos
tools/publish_dashboard.py   Sincronizador Vikunja → Cloudflare
wrangler.jsonc               Worker, Static Assets, Durable Object y Workers KV (heredado)
package.json                 Wrangler y comandos del proyecto
```

No se usa `dist` porque no hay un framework que compilar. Wrangler publica directamente `public/` como Static Assets.

## Generación de minutas

- Mantener presionada durante 650 ms una tarjeta activa el **modo selección** de su
  panel (Portafolio, Tareas con fechas próximas o Cata 1-1) y la marca. Con el modo
  activo, un clic simple suma o quita otras tarjetas del mismo panel sin abrir el
  inspector. Un clic en un espacio vacío, en otra sección o `Esc` sale del modo; la
  selección se conserva. `Mayús+Enter` alterna la selección desde teclado. La
  selección sobrevive a los refrescos y descarta elementos que ya no aparecen.
- **Generar minuta** del portafolio requiere al menos una LT/TR; incluye sus tareas
  abiertas en el orden del portafolio.
- **Generar minuta Cata 1-1** y **Generar minuta** de fechas próximas usan solo lo
  seleccionado; sin selección incluyen todos los pendientes del panel.
- El texto generado se puede editar en el panel lateral y copiar al portapapeles.

## Bandeja de minutas Granola (🔔)

Cada hora el puente ejecuta el exportador de Hermes (`granola-pmo-summary-sync.py`):
copia las minutas nuevas en `pmo-dsta/07_reuniones` y `Minutas 2026` y las deja en la
cola durable `04_reportes/granola-reconciliation-queue.json`. Cada minuta pendiente se
analiza en una sesión de solo lectura (Hermes/Codex con `vikunja-readonly` y
`dsta-minutas`; Claude como respaldo) que devuelve un plan JSON de acciones:
actualizar, registrar nota, completar, crear o mover tareas.

- `tools/minute_inbox.py` aplica automáticamente solo las acciones marcadas como
  evidentes **y** de confianza alta (nunca `mover`), relee cada tarea en Vikunja y
  deja el resto como propuestas. Las notas se agregan a la bitácora de la descripción
  (`Actualización/Nota/Cierre AAAA-MM-DD: … (Fuente: Granola …)`). Las creaciones usan
  `ACTION_KEY granola-<source_id>-<título>` y se rechazan si ya existe una tarea
  abierta con el mismo título en la línea.
- El reporte queda en `04_reportes/granola-reconciliation-reports/` y la cola se
  marca `awaiting_user` (con propuestas) o `processed`, igual que el cron de Hermes.
- El dashboard muestra una campana con el número de minutas nuevas o por revisar.
  En cada minuta se ve lo aplicado automáticamente y las propuestas, que se pueden
  editar, aprobar o rechazar. Las decisiones viajan por el Durable Object junto a la
  consulta que el puente ya hace cada 5 segundos (sin solicitudes adicionales) y el
  puente las aplica y publica un snapshot nuevo.
- El estado de la bandeja vive en la VM (`hermes/cache/dsta-minute-inbox.json`); el
  Worker solo lo refleja. `DSTA_GRANOLA_INTERVAL_SECONDS` cambia la frecuencia
  (0 la desactiva).

## Configuración de Cloudflare

La integración Git debe usar:

- Branch: `main`
- Root directory: `/`
- Build command: ninguno
- Deploy command: `npx wrangler deploy`
- Preview command: `npx wrangler versions upload`

El primer deploy crea automáticamente el namespace KV declarado como `DASHBOARD_DATA`. Después del deploy, en **Workers & Pages → dsta-web → Settings → Variables and Secrets**, crear estos tres secretos cifrados:

- `DASHBOARD_USER`: usuario solicitado por el navegador, por ejemplo `alvaro`.
- `DASHBOARD_PASSWORD`: contraseña del dashboard.
- `INGEST_TOKEN`: token largo y aleatorio usado exclusivamente por la VM.

El Worker falla de forma cerrada con estado 503 mientras falte cualquiera de esos secretos. Ningún secreto debe guardarse en Git.

## Publicación desde la VM

El publicador requiere estas variables locales:

```dotenv
VIKUNJA_URL=http://127.0.0.1:3456
VIKUNJA_API_TOKEN=...
DSTA_DASHBOARD_URL=https://dsta-web.<subdominio>.workers.dev
DSTA_DASHBOARD_INGEST_TOKEN=...
```

`DSTA_DASHBOARD_INGEST_TOKEN` debe ser idéntico al secreto `INGEST_TOKEN` de Cloudflare. Para probar una publicación:

```powershell
python tools/publish_dashboard.py --once --env-file C:\ruta\configuracion-local.env
```

En esta instalación, la URL de producción es
`https://dsta-web.alvaro-gcl.workers.dev`. El token también puede mantenerse en
un archivo local independiente, lo que evita incluirlo en variables o argumentos
de tareas programadas:

```powershell
python tools/publish_dashboard.py `
  --env-file C:\Users\admin\AppData\Local\hermes\.env `
  --dashboard-url https://dsta-web.alvaro-gcl.workers.dev `
  --ingest-token-file C:\Users\admin\AppData\Local\hermes\cache\vikunja-dashboard-ingest-token.txt
```

## Copiloto Hermes

El dashboard no conecta el navegador directamente con Hermes. El puente local
consulta el Worker mediante HTTPS saliente cada cinco segundos, toma las
solicitudes pendientes y ejecuta Hermes en la VM. No requiere publicar puertos
de Hermes ni crear un túnel entrante. Las conversaciones se mantienen en la
pestaña abierta del navegador. La cola y las respuestas recientes del chat se
guardan en un Durable Object de Cloudflare para evitar los retrasos de
propagación de Workers KV; los trabajos terminados se purgan pasado un día.
El snapshot de Vikunja, los resúmenes de Cata y su cola también viven en ese
Durable Object. Hasta el 29-09-2026 estaban en Workers KV, cuyo plan gratuito
admite 1.000 escrituras al día: un resumen que fallaba se reencolaba en cada
snapshot, el cupo se agotaba a media tarde y el dashboard quedaba congelado sin
aviso. KV solo se lee como respaldo del último snapshot y para migrar una vez los
resúmenes existentes. Un resumen fallido espera una hora antes de reintentarse,
salvo que la tarea cambie. Si el snapshot tiene más de 10 minutos, el dashboard
muestra **DESACTUALIZADO** en vez de **EN VIVO**. Bajo `pythonw`, el publicador
registra cada error distinto en `hermes/logs/dsta-publisher.log`.

El botón **Nueva sesión** del copiloto borra la conversación de la pestaña; como
el historial solo viaja desde el navegador, la siguiente consulta parte sin el
contexto anterior. Se deshabilita mientras hay una consulta en curso.

El chat invoca Hermes con los toolsets `vikunja-dashboard`, `dsta-minutas` y
`cronjob`, sin acceso a terminal, archivos generales o navegador. `dsta-minutas`
(`tools/minutas_mcp.py`) solo lista, busca y lee las minutas Markdown exportadas
de Granola en `pmo-dsta/Minutas 2026` y `pmo-dsta/07_reuniones` (configurable con
`DSTA_MINUTAS_DIRS`); no escribe ni lee fuera de esas carpetas. El puente limpia
de la respuesta el panel de razonamiento, etiquetas `<think>` y códigos de terminal
antes de enviarla al chat.

Si Codex no está disponible (error, 402, tiempo agotado o cambio de Hermes al modelo local, detectado por la línea `Fallback activated` en `logs/agent.log`), el puente corta ese intento y responde con **Claude Code headless** (`claude -p`) como respaldo: mismos MCP `vikunja-dashboard` y `dsta-minutas`, `--strict-mcp-config`, sin herramientas integradas (`--tools ""`), sin terminal, archivos ni web, y sin recordatorios. La respuesta termina con «Respondido por Claude (respaldo)». Tras un fallo, Codex se reintenta a los 10 minutos. Usa el plan de Claude de la sesión Windows del usuario; `DSTA_CLAUDE_CLI` y `DSTA_CLAUDE_MODEL` (por defecto `sonnet`) lo configuran. Los resúmenes de Cata usan el mismo respaldo, pero Claude corre sin ninguna herramienta ni MCP (solo recibe el texto de las tareas y devuelve JSON). El MCP `vikunja-dashboard` expone
operaciones acotadas para consultar proyectos/tareas, crear tareas estructuradas
en una línea existente, crear líneas bajo PMO-DSTA, renombrarlas, modificar su
descripción, mover tareas entre líneas, fusionar líneas, archivar líneas vacías
y restaurar líneas archivadas.
También puede editar campos, completar tareas, actualizar su dependencia y
añadir comentarios. Las nuevas tareas incluyen Responsable, Fecha objetivo,
Dependencia, Criterio de cierre, `SOURCE` y `ACTION_KEY`; lo no especificado queda
como `Por confirmar`. Cada creación se relee desde Vikunja antes de confirmar al
usuario. Se rechazan títulos o códigos LT/TR duplicados. La fusión mueve y
verifica cada tarea antes de archivar el proyecto de origen. Ante un fallo
intermedio, el origen sigue activo y la respuesta indica los IDs ya movidos.
El archivo de una línea vacía conserva su información y configuración en
Vikunja; el MCP no expone borrado permanente. La página toma los proyectos
activos directamente bajo PMO-DSTA, sin exigir una cantidad o catálogo fijo.
El publicador actualiza el snapshot cada 30 segundos y la interfaz lo relee
con la misma frecuencia.
Al terminar una solicitud del copiloto, el puente consulta nuevamente Vikunja y
publica un snapshot por el endpoint autenticado `/api/bridge/snapshot` antes de
marcar el chat como completado. El navegador solicita inmediatamente el nuevo
snapshot y espera hasta recibir al menos la marca de tiempo publicada. Esto evita
esperar el siguiente ciclo de 30 segundos para acciones del copiloto (no cubre
ediciones hechas fuera de él). Si Vikunja, la publicación o la propagación de KV
fallan, se informa el problema y se conservan los datos previos; no se simula
una actualización exitosa. El puente requiere `VIKUNJA_API_TOKEN` local.
Puede programar un recordatorio cuando se lo pidas y le indiques cuándo. Los
resúmenes automáticos de Cata usan Hermes en una sesión aislada sin herramientas.
Solo se recalculan para tareas cuyo contenido cambió y se descartan si la tarea
vuelve a cambiar antes de terminar el resumen.

### Verificación de publicación

1. Confirmar que `origin/main` apunta al commit esperado. **Publicar Git no
   prueba que Cloudflare haya desplegado el Worker.**
2. Para desplegar con Wrangler, contrastar el Account ID de `npx wrangler whoami`
   con `account_id` en `wrangler.jsonc`; no intentar desplegar con otra cuenta
   ni cambiar el ID del proyecto para forzar acceso.
   En esta VM, un proceso ya abierto puede conservar un `CLOUDFLARE_API_TOKEN`
   heredado y **distinto** del token actualizado en las variables de usuario de
   Windows. Si Wrangler muestra la cuenta equivocada, leer el valor vigente de
   `HKCU\Environment\CLOUDFLARE_API_TOKEN` solo dentro del proceso de despliegue
   y pasar ese valor como variable de entorno al proceso hijo, junto con
   `CLOUDFLARE_ACCOUNT_ID` igual al `account_id` del proyecto. Validar antes
   con una consulta de solo lectura a la API de despliegues de la cuenta
   correcta (HTTP 200). No imprimir el token, guardarlo en Git ni editar la
   variable global para un despliegue puntual.
3. Verificar por separado que el Worker sirve los assets nuevos y la ruta
   `/api/bridge/snapshot` responde **401 JSON** ante un POST sin token válido
   (la versión anterior responde 401 de autenticación básica en texto plano).
   No publicar snapshots de prueba ni tareas ficticias en producción.
4. Reiniciar la tarea programada `DSTA Hermes Bridge` para que cargue el Python
   nuevo y comprobar que existe un solo proceso `hermes_bridge.py`. La ruta
   `/api/bridge/snapshot` debe estar desplegada antes de probar una acción real;
   de lo contrario el chat conservará su respuesta, pero advertirá que no pudo
   actualizar el portafolio de inmediato.
5. Confirmar por la API de Cloudflare que la versión recién publicada está al
   **100 %** en el último despliegue; un `401` JSON de la ruta nueva confirma
   además su presencia sin escribir datos de producción.

### Activación

1. El MCP `vikunja-dashboard` ya está registrado en esta VM y separado del MCP
   general de Telegram. Si se instala la VM desde cero, regístralo así:

   ```powershell
   hermes mcp add vikunja-dashboard `
     --command C:\Users\admin\AppData\Local\Programs\Python\Python312\python.exe `
     --args C:\Users\admin\Documents\Codex\2026-09-22\hola\work\DSTA-web\tools\vikunja_dashboard_mcp.py
   ```

   El MCP de minutas se registra igual:

   ```powershell
   hermes mcp add dsta-minutas `
     --command C:\Users\admin\AppData\Local\Programs\Python\Python312\python.exe `
     --args C:\Users\admin\Documents\Codex\2026-09-22\hola\work\DSTA-web\tools\minutas_mcp.py
   ```

2. Genera un secreto aleatorio de al menos 32 bytes:

   ```powershell
   python -c "import secrets; print(secrets.token_urlsafe(48))"
   ```

3. Guarda ese mismo valor como secreto cifrado `DSTA_BRIDGE_TOKEN` en **Workers
   & Pages → dsta-web → Settings → Variables and Secrets** y como variable
   `DSTA_BRIDGE_TOKEN` en `C:\Users\admin\AppData\Local\hermes\.env`. No lo
   guardes en el repositorio.

4. La URL del Worker y la ruta de Hermes ya tienen valores
   predeterminados para esta VM. Si cambian, configura estas variables locales:

   ```dotenv
   HERMES_CLI=C:\Users\admin\AppData\Local\Programs\Python\Python312\Scripts\hermes.exe
   DSTA_HERMES_PROVIDER=openai-codex
   DSTA_HERMES_MODEL=gpt-6-luna
   ```

5. Despliega el Worker actualizado desde `main` y ejecuta el puente en la VM:

   ```powershell
   python C:\Users\admin\Documents\Codex\2026-09-22\hola\work\DSTA-web\tools\hermes_bridge.py `
     --env-file C:\Users\admin\AppData\Local\hermes\.env
   ```

   Mantén el proceso activo para recibir consultas y procesar resúmenes. En esta
   VM, la tarea programada `DSTA Hermes Bridge` lo inicia al comenzar sesión
   y lo mantiene activo en segundo plano.

Sin `DSTA_BRIDGE_TOKEN`, el dashboard y la publicación de Vikunja siguen
funcionando; el chat informa que el puente no está configurado y no se generan
resúmenes automáticos.

En operación normal, el script consulta Vikunja cada 30 segundos. Solo publica si cambian los datos o cada cinco minutos como pulso de actividad.

## Seguridad verificada

- El MCP valida la pertenencia a una línea activa PMO-DSTA antes de actualizar,
  completar, cambiar dependencias o agregar comentarios. Crear y mover ya validaban
  el alcance; ahora las demás escrituras no dependen de que el modelo elija bien el ID.
- Los POST del navegador a chat y decisiones requieren JSON y rechazan `Origin`
  distinto del sitio, `Origin: null` y metadatos Fetch de otro sitio. La autenticación
  Basic sigue siendo obligatoria; clientes no navegador sin Origin siguen admitidos.
- La ingestión rechaza fechas inválidas, registros nulos, IDs duplicados, tipos de
  campo incorrectos y referencias a proyectos ausentes antes de reemplazar el snapshot.
- El Worker cuenta los bytes del cuerpo durante su lectura y corta el stream al
  superar el límite, antes de interpretar JSON. También cuenta espacios y UTF-8;
  `Content-Length` no es la única defensa.
- CSP permite los scripts externos del sitio y solo las huellas SHA-256 de los
  scripts inline entregados por Static Assets. No admite JavaScript inline arbitrario,
  `eval`, objetos ni envíos nativos de formularios. Los formularios de la interfaz
  conservan sus manejadores JavaScript y sus solicitudes JSON del mismo origen.
- Wrangler queda fijado en 4.147.0 con lockfile actualizado. La auditoría npm incluye
  las dependencias de desarrollo: no basta `npm audit --omit=dev`.

Pruebas de regresión y seguridad (sin escribir en PMO productivo):

```bash
python -m unittest discover -s tests -v
node tests/test_assistant_worker.mjs
node tests/test_security_worker.mjs
node tests/test_inspector_refresh.mjs
node tests/test_portfolio_selection.mjs
npm audit
npm run check
```

## Desarrollo local

```powershell
npm install
npm run dev
```

Para desarrollo se puede crear `.dev.vars` (ignorado por Git):

```dotenv
DASHBOARD_USER=alvaro
DASHBOARD_PASSWORD=contraseña-local
INGEST_TOKEN=token-local
```

## Despliegue manual opcional

La integración con GitHub despliega automáticamente cada commit en `main`. Si se necesita desplegar manualmente desde una sesión autenticada de Wrangler:

```powershell
npm install
npm run deploy
```
