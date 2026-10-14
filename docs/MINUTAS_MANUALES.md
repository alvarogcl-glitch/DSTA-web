# Minutas manuales desde el dashboard

Entrega local del 14-10-2026, rama `feature/minutas-manuales-dashboard`, base `origin/main` 1bd8846. No publicada, sin merge ni cambios en servicios, secretos, D1 remoto, Cloudflare o datos personales.

## Revisión de arquitectura y decisión

Se revisaron el contexto operativo, el plan y sus acuerdos, el corte multiusuario del 14-10, los contratos del Worker/DO, frontend, publicador, puentes, autenticación, vault, Granola, reconciliación y suites. La revisión identificó dos recorridos vigentes:

| Capa | Implementación existente | Integración de esta entrega |
|---|---|---|
| Frontend | HTML/JS/CSS nativos; selección, inspector y generación de texto en `public/index.html`; bandeja en `public/inbox.js` | Complemento `manual-minutes.js/.css`: título, fecha/hora, contexto, editor amplio, formato, borradores y envío. La generación, selección y copia originales conservan su texto y comportamiento. |
| Autenticación | D1: cuentas, PBKDF2, sesiones revocables, cookie HttpOnly/Secure; validación Origin y JSON; Basic acotado al reloj | Las rutas manuales solo funcionan con cuentas. El actor sale de la sesión; `X-DSTA-Actor` debe coincidir, para impedir envíos desde una pestaña cuya cuenta cambió. |
| Persistencia de borde | Un Durable Object por cuenta, incluido `pmo-dsta` para el dueño; KV conserva compatibilidad de snapshots | Borradores y cola en el mismo DO personal. No hay una nueva base ni migración. La bandeja sigue reflejando el reporte de la VM. |
| Puente multiusuario | Dispatcher, vault DPAPI, raíz/token por cuenta, sesiones de IA aisladas, pools de análisis/decisiones | Nuevo tipo de trabajo `manual` en el dispatcher y en el barrido de recuperación de 300 s. Usa el mismo `UserMinuteInbox`, parser, analista y aprobación. |
| Puente del dueño | Hermes original, sin vault multiusuario; usa su inbox `hermes/cache/dsta-minute-inbox.json` y su proveedor/respaldo de solo lectura | El trabajo manual viaja en su sondeo de chat actual. Reutiliza el mismo motor, archivo y decisiones; no se provisiona ni migra la cuenta del dueño. |
| Granola | Importación propia con OAuth en VM/vault; exportador y cola históricos del dueño | Continúa igual. El sobre común añade `source: Granola`; los IDs, prefijos de acciones y automatismos existentes se conservan. |
| Vikunja | API interna; fuente canónica; raíz por actor; helpers verifican alcance, conservan campos completos y releen; locks cooperativos por tarea | Las minutas manuales generan propuestas siempre. Solo una aprobación/instrucción humana usa las escrituras existentes y publica el snapshot posterior. No hay credenciales ni llamadas a Vikunja en el navegador. |
| Servicios VM | Publicador Cloud Sync, Hermes Bridge y Multiusuario Bridge; se comprobó su estado Running sin intervenirlos | Código preparado para ambos puentes; su instalación/reinicio requerirá una entrega posterior autorizada. No se apagó ni reinició la VM. |

`minute_sources.py` define el sobre `source/source_id/version/title/date/summary/private_notes/context` y construye el registro de bandeja. Un futuro adaptador puede normalizar OneNote, SharePoint o Word a ese sobre y llamar al motor existente. No se implementaron conectores externos. Los orígenes adicionales reciben identidades separadas; solo Granola conserva la política automática anterior.

El texto completo de las minutas manuales se guarda en el DO personal porque debe poder editarse y recuperarse entre dispositivos. Llega a la VM para análisis, y queda como `texto` en su archivo de inbox; el espejo de propuestas elimina ese campo. La UI publica únicamente al actor autenticado sus propios borradores. La API devuelve `Cache-Control: no-store`, y el service worker mantiene su política de no cachear datos privados.

## Uso y recuperación

1. Seleccionar elementos y pulsar **Generar minuta** como antes. El texto generado permanece editable y copiable para Granola. El complemento añade título, fecha/hora local y contexto capturado al generar.
2. Registrar las notas en el cuadro amplio. Negrita, cursiva, viñetas y numeración insertan Markdown; **Vista previa** presenta negrita/cursiva. Se escapa todo HTML antes de representarlo. No se introduce un editor WYSIWYG ni una dependencia externa.
3. Los cambios se protegen localmente y se guardan en la cuenta después de 2,5 s sin escribir. **Guardar borrador** fuerza el guardado sin IA. El mensaje distingue protección local de confirmación en la cuenta.
4. **Minutas manuales**, junto a Actualizar, permite crear una reunión vacía y recuperar los borradores o consultar los enviados. Cada minuta mantiene título, fecha/hora con offset, contenido y referencias de contexto.
5. **Guardar y procesar minuta** confirma primero la versión guardada y después encola esa misma revisión. Se bloquea su edición para que la evidencia revisada coincida con las propuestas. Ante un error del analista, **Reintentar procesamiento** reutiliza la misma revisión.
6. La campana muestra el origen `Manual-Dashboard`. Aprobar, editar, rechazar, instruir, deshacer y descartar usan la bandeja existente. Nada manual se aplica por confianza alta sin aprobación.

La copia local usa AES-GCM con IV aleatorio por escritura. La clave pertenece al DO de la cuenta y se entrega por una ruta autenticada; solo vive en memoria del navegador. `localStorage` contiene ciphertext separado por actor y borrador, sin la clave. Otra cuenta obtiene otra clave y no carga esas entradas. Una sesión vencida necesita autenticarse y conectarse para descifrar los borradores; la reapertura totalmente offline no expone las notas. Borrar los datos del navegador elimina únicamente la recuperación local, no los borradores confirmados en el servidor.

Si falla almacenamiento local, el editor informa la falta de recuperación y permite guardar explícitamente en la cuenta. Si falla la red, conserva la revisión, solicitud y contenido para reintentar. Un aviso de salida protege cambios todavía pendientes. Una copia local dañada no impide recuperar los borradores del servidor.

Las ediciones simultáneas usan revisión optimista: el DO rechaza una versión antigua con 409. La lista permite recuperar la versión de la cuenta conservando los cambios locales como una copia independiente. No se sobrescribe automáticamente una versión más nueva de otra ventana.

## Contratos, idempotencia y fallos

- `GET /api/manual-minutes`: borradores/estados propios y clave de recuperación propia. `POST`: guardar con UUID de borrador, revisión esperada y UUID de operación; replay de la última operación devuelve su confirmación. Un UUID reutilizado con otro contenido se rechaza.
- `POST /api/manual-minutes/submit`: fija la revisión; reenvíos de una versión enviada/procesada no crean otro trabajo. El origen lo fija el servidor, no el navegador.
- `GET /u/<actor>/api/bridge/manual-next` y `POST …/manual-done`: bearer de puente y actor validado mediante D1. Lease de 15 min, UUID de intento y rechazo de resultados vencidos. La confirmación de éxito requiere el reporte de ese origen, identidad y revisión ya publicado en la bandeja.
- La VM serializa análisis por actor/origen y guarda resultados mediante archivo temporal, fsync y reemplazo atómico. Si falla la publicación posterior, el reintento recupera y republica el análisis guardado sin otra llamada de IA. Un puente caído deja el trabajo durable; el barrido recoge marcas ya reconocidas.
- El dueño recibe trabajos en `/api/bridge/next?kind=chat` y señala `manualBusy=1` mientras su pool manual está ocupado. El puente multiusuario usa el dispatcher existente; las decisiones no esperan al análisis manual.
- Las aprobaciones manuales guardan cada resultado y un checkpoint antes de actualizar tareas. Cada acción tiene una marca de fuente propia en su bitácora; una escritura completada antes de un fallo de confirmación se reconoce al reintentar. Las creaciones comprueban `ACTION_KEY` y título normalizado; se usa un lock de proyecto para creaciones manuales concurrentes. Los movimientos al mismo destino se reconocen sin repetir escritura. Granola conserva su política anterior.
- Los helpers siguen validando la raíz y las líneas activas al escribir en Vikunja. Los locks coordinan clientes DSTA cooperativos; no ofrecen transacciones distribuidas frente a escrituras simultáneas desde clientes externos de Vikunja.
- Validación: UUIDs, campos permitidos, fecha ISO válida con zona, título ≤200 caracteres, texto ≤60.000, referencias propias en snapshot, hasta 500 tareas/500 líneas y 20 secciones. Límite conservador: 100 minutas manuales por cuenta, incluyendo enviadas; no se borran automáticamente. La bandeja conserva sus límites de 60 registros/30 visibles.

## Archivos modificados

Frontend: `public/manual-minutes.js`, `public/manual-minutes.css`, `public/index.html`, `public/inbox.js`.

Borde: `src/worker.js`. VM/motor: `tools/minute_sources.py`, `tools/granola_user.py`, `tools/user_minute_inbox.py`, `tools/minute_inbox.py`, `tools/multiuser_bridge.py`, `tools/hermes_bridge.py`.

Pruebas: `tests/test_manual_minutes.py`, `tests/test_manual_minutes_worker.mjs`, `tests/test_multiuser_worker.mjs`, `tests/e2e_manual_minutes.mjs`, `tests/manual_bridge_fixture.py`, `package.json`, `.gitignore` (salida local de empaquetado).

Documentación: este archivo, registro/aceptación/continuidad del plan y evidencia local con datos QA.

## Validación reproducible sin publicar

Desde la copia de trabajo de esta rama, con Python y Node disponibles:

```powershell
$env:PYTHONUTF8='1'
npm test
```

Para Chrome local con el paquete Playwright instalado (el runtime de Codex lo incluye):

```powershell
$env:DSTA_PLAYWRIGHT_MODULE='C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
$env:DSTA_EVIDENCE_DIR='C:/Users/admin/Documents/DSTA-multiuser/minutas-manuales-dashboard/docs/convergencia/evidencia/minutas-manuales'
node tests/e2e_manual_minutes.mjs
```

Se puede ajustar `DSTA_PLAYWRIGHT_MODULE`, `DSTA_PYTHON` y `CHROMIUM_PATH` según el equipo. El E2E inicia y cierra su servidor localhost, Chrome y puente Python de prueba. No usa `.env` operativos, vaults reales, D1 remoto, Granola real ni Vikunja :3456/:14701. Usa sesiones y datos sintéticos, Worker/DO reales en memoria, el dispatcher/puente/parser/decisiones Python reales, respuesta IA determinista y Vikunja simulado en un directorio temporal. Guarda screenshots de escritorio y móvil. El directorio temporal contiene solo fixtures QA y puede conservarse para auditoría.

Empaquetado local (Wrangler instalado):

```powershell
npx wrangler deploy --dry-run --config wrangler.staging.jsonc
```

Este comando no publica. No quitar `--dry-run`. En esta entrega se usó el binario Wrangler 4.147.0 ya instalado, con el mismo contrato.

Resultados y capturas están en `docs/convergencia/evidencia/minutas-manuales/`. La línea base fue 194 pruebas Python más todas las suites JS. Las capturas anteriores usan el HTML original de 1bd8846 con el mismo fixture; las posteriores muestran el complemento. Resultado final: **202 Python y 18 suites JavaScript aprobadas**, E2E Chrome aprobado y empaquetado seco aprobado. La entrega añade cobertura de análisis manual/aprobación, aislamiento, borradores, conflicto de revisión, origen/fecha, idempotencia, lease, fallos de análisis/publicación/disco y recorrido visual completo. Granola y plantillas conservan las regresiones previas.

## Antes de una entrega a producción

1. Revisar esta rama y las capturas; aceptar el recorrido de formato Markdown, borradores y bloqueo posterior al envío. Revisar límites de volumen antes de ampliarlo a uso intensivo.
2. En un entorno QA separado, con cuentas/raíces exclusivas, instalar el Worker/assets y los Python de ambos puentes en la misma entrega autorizada. No probar sobre alvaro ni sobre el portafolio del dueño. La publicación debe garantizar que los nuevos endpoints y los nuevos puentes estén disponibles juntos.
3. Probar con la IA real una minuta evidente, una ambigua, una sin relación y una que mencione IDs ajenos: contrastar contenido/prompt, destino propio, acciones, ausencia de escrituras previas y resultado tras aprobar. Probar tanto el dueño con Hermes/Claude como una cuenta con Copilot aislado. Una respuesta simulada no acredita calidad del modelo real.
4. Cortar la red antes/después del guardado/envío, recargar, recuperar, y repetir la misma aprobación con su resultado incierto. Confirmar una sola creación/nota y ningún cruce A/B, incluyendo cambio de cuenta desde otra pestaña. Comprobar un borrador desde otro dispositivo.
5. Probar móvil real/PWA, teclado y pegar notas extensas. Verificar que solo el texto seleccionado se conserva en la plantilla y que Copiar texto sigue sirviendo para Granola.
6. Solo tras autorización concreta: integrar la rama y desplegar Worker/assets, actualizar ambos puentes Python y reiniciar únicamente los servicios incluidos. No se requieren secretos nuevos, cambios de configuración productiva, migraciones D1 ni integraciones externas. Preparar respaldo de inbox/DO antes de habilitar usuarios y plan de rollback del código; conservar los borradores creados.

Pendiente de esta entrega: aceptación humana, pruebas con modelo real, servicios remotos y dispositivos reales. OneNote/SharePoint/Word, editor WYSIWYG, edición de una revisión enviada y administración de retención quedan fuera de alcance. Para continuar una reunión enviada se puede registrar otra minuta; no se reabre automáticamente su evidencia ni se duplican sus propuestas.
