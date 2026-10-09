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

## Acciones en el detalle de una tarea

El copiloto también gestiona la clasificación mediante etiquetas nativas. Puede
listar etiquetas y sus tareas, crear etiquetas, renombrarlas o cambiar su color,
asignarlas o quitarlas de una tarea y eliminarlas del catálogo con respaldo previo.
Quitar una asignación conserva la etiqueta global y las otras clasificaciones de
la tarea. El borrado global protege Carrera tecnológica. Las mismas operaciones
verificadas de la interfaz se usan desde Hermes y desde el respaldo Claude; al
terminar el chat, el puente publica un snapshot fresco antes de confirmar.

Ejemplos: «Agrega Carrera Tecnológica a la tarea #123», «Quita Seguimiento de la
tarea #123», «Crea Prioritario en ámbar y asígnala a la tarea #123», «Renombra
Seguimiento a En revisión». Cambiar la LT/TR usa la operación de mover tarea.
El modo de análisis de minutas solo expone las consultas de etiquetas.

El inspector muestra un visto bueno **✓** junto al estado de una tarea abierta; al
pasar el cursor o enfocarlo con teclado se expande a **Marcar como completada**.
En móvil (hasta 620 px) y pantallas táctiles, la etiqueta siempre está visible y
el control tiene un objetivo táctil de al menos 44 px, sin depender de hover.
Debajo de la descripción, **Agregar registro** abre un formulario discreto con tipo,
fecha y texto. **Guardar** lo cierra al confirmar el registro; **Cancelar** lo oculta
conservando el borrador. La fecha inicial corresponde a Santiago.

**Completar no usa un modelo de IA.** El navegador envía exclusivamente
`{action: "complete", taskId, requestId}` a `/api/task-actions`, con autenticación
Basic, protección de origen y validación estricta. El UUID se guarda antes del POST.
Una cola durable separada del chat conserva ese mismo ID, reclama el trabajo con
una concesión temporal y rechaza confirmaciones de intentos anteriores. El puente
valida la pertenencia actual a una LT/TR activa bajo PMO-DSTA, relee la tarea nativa,
conserva sus campos (incluidos `SOURCE` y `ACTION_KEY`), aplica `done=true` y verifica
el resultado. Si ya está completada, no repite el POST. Después publica un snapshot
fresco; solo al comprobarlo muestra éxito. El chat y los resúmenes se ejecutan en
segundo plano. Las acciones se consultan en un hilo independiente cada 2 segundos,
con un tiempo máximo de 10 segundos por consulta; una petición lenta o fallida de
salud, chat o resúmenes no bloquea su recepción. Se procesan de una en una, usando
la misma concesión e identificación durable. El log `dsta-bridge.log` registra
recepción, verificación en Vikunja, publicación y confirmación, con duraciones y
ID de solicitud sin datos de la tarea ni credenciales. Cambiar este código requiere
reiniciar el puente local; los cambios solo del sondeo no requieren desplegar el Worker.

La confirmación directa vincula el snapshot autenticado al ID y a la concesión
vigente (`actionConfirmation: {id, attempt}`). El Worker comprueba tarea, línea y
estado completado antes de guardar esa prueba; al finalizar exige la misma
concesión y timestamp y que el snapshot vigente siga mostrando la tarea completada.
Así no depende de comparar relojes de la VM y Cloudflare. Se preserva el orden
de snapshots por inicio de observación, la caducidad y el rechazo de concesiones
anteriores. La compatibilidad con puentes anteriores conserva la comprobación
temporal antigua. Este contrato requiere desplegar Worker y reiniciar el puente.
El log solo dice confirmado cuando la respuesta final tiene `status=completed`;
un HTTP 200 con `status=queued` se registra como sin confirmación.

**Agregar registro** conserva la cola del copiloto, con ID explícito y sin historial.
`pmo_append_log` relee la descripción canónica, agrega el registro fechado, conserva
los campos y verifica su persistencia. Un registro de tipo Cierre no cambia el
estado: completar es una acción separada. Las escrituras del puente, del MCP y de
las minutas comparten un bloqueo por tarea entre procesos de la VM, desde la lectura
hasta la verificación. No cubre ediciones realizadas por otros clientes externos:
la API de Vikunja utilizada aquí no ofrece una precondición CAS/ETag verificada.

Los borradores se conservan por tarea durante la sesión, incluso al refrescar o navegar
entre tareas. Las solicitudes pendientes guardan su ID en sessionStorage para retomar
su consulta al recargar sin reenviar escrituras. Los errores conservan el texto.
Los archivos `public/task-actions.js` y `public/task-actions.css` contienen los controles.
Un aviso no bloqueante (`role=status`, `aria-live=polite`) identifica la tarea y
muestra **Completando…** o **Guardando registro…**, incluso si se navega fuera del
inspector. El éxito aparece únicamente tras verificar el snapshot y desaparece
a los 6 segundos. Los errores y resultados inciertos permanecen hasta descartarlos
con **×**; descartar el aviso no cancela ni reenvía la solicitud pendiente.
Si una acción terminó pero no pudo confirmarse en pantalla,
**Actualizar y revisar tarea** realiza una lectura y libera el control solo si esa lectura funciona; no
repite la escritura. Las pérdidas de red mantienen el UUID para consultar o reenviar
únicamente la misma solicitud idempotente. Si sessionStorage no permite conservar
el ID, el navegador no envía el cambio.

Los snapshots incluyen `observationStartedAt`, capturado antes de consultar Vikunja.
El Durable Object no acepta una recolección anterior ni un productor sin esa marca
una vez activado el protocolo. Así, un chat lento o una sincronización atrasada no
puede reemplazar la observación fresca de una acción completada. Los errores
conservan el último snapshot válido.

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
- Cada inspector de LT/TR, sección o KPI ofrece **Generar minuta**, incluso si
  está vacío. Esta acción usa exclusivamente las tareas abiertas del ámbito
  actual, reconstruido desde los datos vivos, sin mezclar selecciones de otros
  paneles. Si no hay pendientes, indica **Sin tareas abiertas en esta sección**.
  Al volver a una sección o KPI se reconstruyen su lista y conteo actualizados.
- El texto generado se puede editar en el panel lateral y copiar al portapapeles;
  **Volver** conserva la navegación al inspector de origen.
- `npm test` incluye regresiones de ámbito de minutas, snapshots, borradores,
  avisos durante navegación, solicitudes duplicadas y contratos CSS móviles.
  Las pruebas simulan la API: no publican trabajos ni modifican datos reales.

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
4. Publicar primero el Worker y comprobar `/api/task-actions` con una solicitud
   inválida autenticada (400, sin crear trabajos). Reiniciar primero
   `DSTA Dashboard Cloud Sync` y después `DSTA Hermes Bridge` para cargar el Python
   nuevo, sin cambiar la configuración de las tareas programadas. Antes de parar el
   puente, comprobar que no hay un subproceso del copiloto en ejecución. Verificar
   un solo proceso de cada servicio y un snapshot con `observationStartedAt`.
   Un productor anterior sin esa marca será rechazado tras la primera publicación
   nueva; esto protege el estado actualizado de sobrescrituras tardías.
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

## Android: PWA instalable

El dashboard incluye un manifiesto, iconos Android normales y adaptativos, y un
service worker. En Chrome para Android, abrir la URL HTTPS del dashboard, iniciar
sesión y pulsar **Instalar DSTA** cuando esté disponible. También se puede usar el
menú de Chrome → **Instalar aplicación** o **Añadir a pantalla de inicio**; el texto
varía según el dispositivo. La app abre en una ventana propia y usa el mismo sitio.

La autenticación Basic se conserva. La instalación puede pedir iniciar sesión
nuevamente: comprobar en un teléfono real después de publicar. Solo son públicos
el manifiesto, los tres iconos, el service worker y la página genérica sin conexión,
mediante una lista exacta de rutas GET/HEAD. El dashboard, sus scripts y todas sus
API siguen protegidos; los POST conservan la validación de origen del mismo sitio.

Solo se guarda la página genérica sin conexión en CacheStorage. No se guardan
datos del dashboard, credenciales, chat ni minutas para uso offline; tampoco se
encolan ni reenvían cambios desde el service worker. Sin red se muestra **Sin
conexión** al abrir la app. Las actualizaciones se obtienen de la web al abrirla.

Validación: `npm test` incluye la lista pública, autenticación y aislamiento del
service worker. Verificar finalmente instalación y reapertura en Chrome Android,
inicio de sesión, navegación, copia de minutas y recuperación después de perder
la conexión; probar acciones de escritura solo con tareas de prueba autorizadas.

### Disponibilidad tardía de minutas Granola

El exportador operativo usa `tools/granola_summary_export.py` (copia instalada en
`pmo-dsta/scripts/granola-summary-export.py`) y el promotor usa
`tools/promote_granola_summaries.py` (instalado como `promote-granola-summaries.py`
en la misma carpeta). Ambos se cargan en cada sincronización; estos cambios no
requieren reiniciar Hermes ni desplegar el Worker. Antes de instalar una actualización,
respaldar los scripts operativos y copiar las fuentes versionadas con esos nombres.

Si Granola lista una reunión antes de generar su resumen y no hay notas disponibles,
el exportador consulta esa reunión una vez por separado. Si sigue vacía, registra
`deferred` en `07_reuniones/.granola-summary-staging/extraction-report.json` y la
reintenta en el siguiente ciclo horario, dentro de la ventana de 30 días. No exporta
ni encola una minuta vacía y conserva contenido válido anterior. El promotor también
excluye archivos vacíos antiguos. Las notas disponibles bastan para importar una reunión.
Cuando aparece el contenido, su nueva huella genera una revisión para el flujo habitual
de reconciliación. `tests/test_granola_summary_export.py` cubre estas transiciones.

### Descartar una minuta completa

El detalle de cada minuta ofrece **No hacer nada · descartar minuta**. Envía una
decisión de reunión completa por la cola existente (`decision: "descartar"`,
`minuteId` y `digest`), que rechaza las propuestas pendientes y conserva las acciones
ya aplicadas. El puente no llama al modelo ni consulta o modifica Vikunja para esta
operación. Al confirmarse, la minuta deja de contar en la campana y aparece solo en
el historial como **Descartada**. La copia Markdown se conserva.

La VM guarda `descartadaEn` por sourceId, cierra la revisión vigente de la cola y
omite nuevas reconciliaciones de esa reunión. El exportador también omite fuentes
descartadas para no volver a encolarlas; el Worker conserva esa decisión ante
republicaciones, incluso con otra huella. Se rechazan decisiones sobre una versión
que cambió o mientras hay otra operación pendiente.

Activación de este cambio: instalar la copia actualizada del exportador operativo,
reiniciar solo la tarea `DSTA Hermes Bridge` y publicar el Worker con los assets.
Requiere la aprobación operativa del proyecto. No se descartan reuniones reales
como parte de las pruebas.

## Etiquetas nativas · versión 1.1.0

Las etiquetas se guardan en Vikunja, con nombre y color. El snapshot incluye el
catálogo `labels: [{id, title, hex_color}]` y los `label_ids` de cada tarea. La
interfaz nunca crea una clasificación paralela en el navegador.

- **Inventario operativo completo:** desplegable con búsqueda y selección múltiple.
  Al elegir varias etiquetas aparecen las tareas con **al menos una** de ellas.
  Este filtro se combina con búsqueda, línea y estado; **Limpiar filtro** muestra
  nuevamente todas las etiquetas. La selección se conserva al actualizar y se
  retiran IDs que ya no existen.
- **Tareas por etiqueta:** muestra las tareas de cada etiqueta, su estado y línea,
  junto a un grupo **Sin etiquetas**. Una tarea con varias etiquetas aparece en
  cada grupo correspondiente. Las tarjetas abren el inspector habitual.
- **Personalizar etiquetas:** abre una ventana para crear, modificar nombre/color
  o eliminar. La modificación es global: cambia la etiqueta en todas las tareas
  de Vikunja que la utilizan. Eliminar quita la etiqueta y sus asignaciones,
  conservando las tareas. **Carrera tecnológica** está protegida de eliminación.
- **Inspector:** las etiquetas y sus controles están en el mismo bloque. El
  desplegable agrega o quita etiquetas; **×** quita una asignación y **✎** modifica
  la etiqueta. **+ Crear etiqueta** toma el texto buscado, abre el editor y asigna
  la nueva etiqueta a la tarea al confirmar.
- **Colores:** diez opciones predeterminadas en `public/label-palette.json`, sin
  selector RGB. Las etiquetas usan el color de relleno y texto con contraste;
  los colores antiguos se muestran tal como están hasta que se modifiquen.

### Contrato de escritura y recuperación

`POST /api/label-actions` acepta solo acciones estructuradas `create`, `update`,
`delete`, `assign`, `unassign` y `reset`, con UUID `requestId`. Se aplica Basic,
JSON, límite de cuerpo y protección de origen. El navegador guarda el UUID antes
de enviar y consulta `GET /api/label-actions?id=…`; recargar retoma el mismo trabajo.
Si no puede guardar el identificador, no escribe. Los resultados inciertos no se
reenvían con otro UUID. Un error terminal ofrece **Actualizar y revisar etiquetas**.

El Durable Object conserva una cola separada de chat y de completado. El puente
consulta `kind=label` en otro hilo cada dos segundos, reclama una concesión de
180 segundos y ejecuta `tools/label_actions.py` sin IA. Las asignaciones validan la
pertenencia actual a una línea activa PMO-DSTA y comparten el bloqueo por tarea con
el resto de las escrituras. Se usan los endpoints específicos de etiquetas: no se
reemplaza el resto de la tarea ni se sobrescriben otras asignaciones.

Crear incluye un marcador `DSTA_REQUEST` en la descripción de la etiqueta para
reconocer reintentos después de una respuesta perdida. Renombrar conserva la
descripción original. Se rechazan nombres duplicados sin distinguir mayúsculas o
acentos, y colores fuera de la paleta. Cada operación se relee antes de publicar.
El snapshot autenticado lleva `labelConfirmation: {id, attempt, result}`; el Worker
verifica su contenido y la concesión vigente antes de confirmar éxito. Un
publicador anterior sin catálogo de etiquetas se rechaza una vez recibido el
primer snapshot del nuevo protocolo, para impedir que borre la clasificación.

### Limpieza inicial solicitada

**Personalizar etiquetas → Eliminar etiquetas anteriores** elimina las etiquetas
existentes excepto **Carrera tecnológica**. La confirmación presenta el número de
etiquetas afectadas. El trabajo captura IDs, nombres y colores al encolarse: no
incluye etiquetas creadas después, y se detiene si una etiqueta cambió o no existe
la etiqueta que se debe conservar. No se dispara automáticamente al cargar la web.

Antes de eliminar, la VM guarda las etiquetas nativas y las asignaciones de todas
las tareas accesibles al token en `hermes/cache/label-backups/<requestId>.json`.
El respaldo se conserva en los reintentos. Restaurar requiere recrear las etiquetas
mediante la API y asignarlas usando los nuevos IDs; Vikunja no garantiza conservar
los IDs eliminados. El respaldo no hace reversible el borrado nativo por sí solo.

### Activación y pruebas

1. Publicar el Worker y los assets de la versión 1.1.0.
2. Actualizar el checkout de la VM, incluidos `tools/label_actions.py` y
   `public/label-palette.json`. Reiniciar **DSTA Dashboard Cloud Sync** y
   **DSTA Hermes Bridge** con el procedimiento operativo ya documentado.
3. Verificar un snapshot con `labels` y `label_ids` y un solo proceso de cada
   servicio. Un token sin permisos para leer etiquetas impide publicar un snapshot
   parcial y conserva los últimos datos válidos.
4. Ejecutar la limpieza inicial desde la ventana de personalización, revisar la
   confirmación y verificar el respaldo y que permanezca Carrera tecnológica.

`npm test` incluye pruebas de etiquetas, seguridad, concesiones, snapshots,
idempotencia, respaldo, alcance y conservación de campos. Las pruebas Granola
simulan su dependencia OAuth de Hermes únicamente durante la importación del test;
el exportador operativo sigue usando el módulo real de Hermes.

La prueba de navegador requiere Playwright, Chromium, `.dev.vars` local y un
Wrangler local **sin datos reales**. En una terminal iniciar `npm run dev`; en otra
usar `npm run test:browser`. Si no está instalado Playwright, preparar la herramienta
con `npm install --no-save --package-lock=false playwright`. Por defecto Chromium
se encuentra en `/usr/bin/chromium`; `CHROMIUM_PATH` permite elegir otra instalación.
`DSTA_BROWSER_BASE` permite cambiar puerto, exclusivamente en localhost. La prueba
publica datos sintéticos y simula el puente contra el Worker local; nunca ejecutarla
contra producción. Cubre selección múltiple, filtros combinados, clasificación,
asignación, creación desde tarea, edición, paleta, limpieza protegida y móvil.
