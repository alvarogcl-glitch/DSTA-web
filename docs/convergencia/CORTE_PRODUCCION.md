# Corte a producción del dashboard multiusuario (14-10-2026)

Autorización: Telegram 14-10-2026 02:34. El CEO pidió ejecutar los pasos 1, 2 y 3 de forma autónoma durante la noche: documentar todo y dejar un respaldo que permita volver atrás como si nada hubiera pasado.

Decisiones: D66, D68, D69, D70, D71 y D72 (REGISTRO_DECISIONES), más todas las entregas E01–E12.

## 0. Respaldo de producción (hecho antes de tocar nada)

Carpeta: `C:\Users\admin\Documents\DSTA-respaldos\2026-10-14-pre-multiusuario\`. Está fuera de Git porque contiene secretos y datos.

| Qué | Archivo | Para qué |
|---|---|---|
| Versión del Worker en producción | `worker-deployments.txt` → **e5b15c54-c9fe-4d98-b51a-62d8f1f6f891** | `wrangler rollback` a esta versión |
| Código de producción | `produccion-repo.bundle` (todas las ramas); tag `pre-multiusuario-2026-10-14` en el repositorio de producción = 40128b6 | volver el código de las tareas de la VM |
| KV `dsta-web-dashboard-data` (8ae3…bd7e) | `kv\` (2 claves: snapshot heredado y resúmenes IA) | reponer valores si hiciera falta |
| Vikunja de producción | `vikunja-produccion.db` (respaldo SQLite consistente, `integrity_check` ok, 168 tareas, 11 proyectos) y `vikunja-files\` | restaurar Vikunja (el corte no lo modifica) |
| Puente del dueño | `hermes.env.respaldo` | volver `DSTA_DASHBOARD_URL` y el token |
| Tareas programadas | `tarea-*.xml` (DSTA Hermes Bridge, DSTA Dashboard Cloud Sync, Vikunja, Hermes Gateway) | `Register-ScheduledTask -Xml` |
| Nombres de secretos del Worker | `worker-secret-names.txt` | referencia (los valores no se exportan) |

Los Durable Objects no se pueden exportar. El corte no borra ni migra sus datos: el cajón `pmo-dsta` sigue siendo el del dueño. El código nuevo solo agrega claves (layout, etc.), y el código anterior las ignora.

## 1. Ensayo en staging (hecho, aprobado)

- **Parte 1, datos.** Cuenta de dueño de ensayo `ceo-ensayo`, con `do_name='pmo-dsta'` y KV con copia del snapshot de producción. Ve 133 tareas y 8 líneas, mismos IDs, sin numeración propia, perfil «Dashboard Gestión DSTA»/PMO-DSTA y Cata 1-1.
- **Parte 2, acciones.** El puente actual del dueño (`hermes_bridge.py` con el código integrado) corrió contra una raíz QA del Vikunja de laboratorio. Desde la interfaz: crear tarea con campos, editar detalle y fecha, registrar en bitácora, completar con ✓, reabrir, mover, crear, describir y archivar línea. Todo verificado por snapshot y sin errores de JavaScript.
- **Rollback.** `wrangler rollback` en staging tardó 6 s, sin interacción. Luego se volvió a desplegar.
- **Hallazgo crítico.** Un Durable Object con tráfico constante (el puente consulta cada 8–12 s) siguió ejecutando el código anterior después del deploy. Su `dashboard()` fallaba con error 1101 porque el código viejo no tenía el binding nuevo. Se arregla así:
  - detener el puente y el publicador antes del deploy;
  - esperar a que `/api/bridge/runtime` informe `ownerBox == worker` (marca `CODE_VERSION`);
  - recién entonces reanudarlos.
- **Limpieza.** Se borraron la cuenta de ensayo, la copia de KV y el cajón de ensayo. En el Vikunja de laboratorio quedan usuarios QA `ensayo-*`, inocuos.

## 2. Pasos del corte (en orden; cada uno se verifica antes del siguiente)

1. **Código (D72).** `feat/multiusuario` ya integra `main` 40128b6. Se adelanta `main` del repositorio de producción a esa rama (fast-forward) y se sube a GitHub. Las tareas de la VM ejecutan ese directorio.
2. **D1 de producción.** Se crea `dsta-web-accounts` y se aplican las migraciones 0001 y 0002. En `wrangler.jsonc` se agregan `DB`, el id explícito del KV y `AUTH_MODE=accounts`.
3. **Ventana sin tráfico.** Se detienen «DSTA Hermes Bridge» y «DSTA Dashboard Cloud Sync».
4. **Deploy** del Worker. Esperar `ownerBox == worker` en `/api/bridge/runtime`.
5. **Token del puente nuevo (D68).** `wrangler secret put DSTA_BRIDGE_TOKEN` y el mismo valor en `hermes/.env`.
6. **Apuntar el puente y el publicador al cajón del dueño.** En `hermes/.env` va `DSTA_DASHBOARD_URL=https://dsta-web.alvaro-gcl.workers.dev/u/ceo`, y en la tarea Cloud Sync `--dashboard-url …/u/ceo`. Se reanudan ambas tareas.
7. **Cuenta del dueño (D66/D69).**
   - Invitación `ceo` (alvaro.gcl@gmail.com), aceptada con una contraseña temporal solo para verificar.
   - `UPDATE users SET do_name='pmo-dsta'`.
   - Verificación por navegador.
   - Al final, enlace de restablecimiento de un solo uso para el CEO, que cierra la sesión temporal.
8. **Reloj (D71).** La credencial Basic actual sigue sirviendo solo para ver y completar en el cajón del dueño. No cambia nada en el reloj.
9. **Puente multiusuario de producción.** Tarea programada propia, con `DSTA_DASHBOARD_URL` de producción. Atiende solo a usuarios con vault; el dueño no tiene vault. Se detiene el puente de staging para ahorrar cuota.

## 3. Verificación posterior

- `/api/bridge/runtime`: `ownerBox == worker`.
- El dueño entra y ve las mismas tareas que lee Vikunja en ese momento: misma cantidad y mismos IDs (comparado con `fetch_dashboard` de solo lectura). Perfil PMO-DSTA y Cata.
- El canal de acciones del dueño responde y el semáforo de Vikunja está en verde.
- Sin Basic Auth en el navegador: `/` redirige a `/login`. PWA: `manifest` y service worker responden.
- Cuota de Cloudflare: el plan sigue siendo gratuito. Se estima un consumo diario menor que el previo, porque se apaga el puente de staging.

## 4. Volver atrás (menos de 5 minutos)

1. `npx wrangler rollback e5b15c54-c9fe-4d98-b51a-62d8f1f6f891 --name dsta-web` (en el repositorio de producción, con token en HKCU). Vuelven Basic Auth y el cajón único. Los datos del dueño nunca se movieron.
2. Copiar `hermes.env.respaldo` sobre `%LOCALAPPDATA%\hermes\.env`. Si el token anterior ya no coincide (los secretos no siempre vuelven con el rollback), dejar el valor de `DSTA_BRIDGE_TOKEN` igual al secreto vigente del Worker. Reiniciar «DSTA Hermes Bridge».
3. Tarea Cloud Sync: volver `--dashboard-url https://dsta-web.alvaro-gcl.workers.dev` con `Register-ScheduledTask -Xml (Get-Content tarea-DSTA_Dashboard_Cloud_Sync.xml -Raw) -TaskName 'DSTA Dashboard Cloud Sync' -Force`.
4. Código de la VM: en el repositorio de producción, `git checkout pre-multiusuario-2026-10-14` (o `git reset --hard pre-multiusuario-2026-10-14` en `main`). Reiniciar las dos tareas.
5. Detener la tarea «DSTA Multiusuario Bridge». D1 queda inerte.

## 5. Registro de ejecución (13-10 23:30 → 14-10 00:10, hora de Chile)

| Hora | Paso | Resultado |
|---|---|---|
| 23:3x | Respaldo completo (sección 0) | OK. Producción en la versión e5b15c54 |
| 23:4x | D72: merge de `main` 40128b6 en `feat/multiusuario` (b4e5747) | Sin conflictos; 194 pruebas OK |
| 23:4x | D71: acceso de dispositivo para el reloj (eca855d) | Pruebas OK |
| 23:5x | Ensayo en staging, partes 1 y 2, y rollback (sección 1) | OK, más el hallazgo del Durable Object con código anterior |
| 23:53 | D1 `dsta-web-accounts` (ccc417d3…) creada y migraciones 0001 y 0002 | OK |
| 23:54 | Repositorio de producción avanzado por fast-forward al código integrado; tareas de la VM detenidas | OK |
| 23:55 | Deploy del Worker en modo cuentas: versión **f6c2bda9-4270-4545-abfc-3218a56416ca** | `/` redirige a `/login`; `ownerBox == worker` de inmediato |
| 23:56 | D68: token del puente rotado (secreto y `hermes/.env`) y `DSTA_DASHBOARD_URL=…/u/ceo` en `.env` y en la tarea Cloud Sync | El primer `secret put` desde PowerShell agregó bytes al valor y el puente recibió 401. Se volvió a subir desde bash con el valor exacto y quedó OK |
| 23:57 | Cuenta `ceo` (alvaro.gcl@gmail.com) con `do_name='pmo-dsta'` | OK |
| 23:58 | Tareas «DSTA Hermes Bridge» y «DSTA Dashboard Cloud Sync» reanudadas | OK |
| 00:00 | Verificación por navegador como dueño | Ver detalle abajo |
| 00:03 | Tarea programada nueva «DSTA Multiusuario Bridge», con vault `%LOCALAPPDATA%\dsta-multiuser-prod\vault` | OK; ignora a `ceo`, que no tiene vault, como corresponde |
| 00:05 | Puente de staging apagado (cuota) y código subido a GitHub (`main` = 14dbcc3) | OK |
| 00:07 | Enlace de restablecimiento de un solo uso (24 h) para el CEO | Entregado solo por Telegram; cerró la sesión temporal |

**Detalle de la verificación por navegador como dueño:**
- 164 tareas y 8 líneas iguales a la lectura directa de Vikunja: mismos IDs y estado.
- Perfil «Dashboard Gestión DSTA» / PMO-DSTA y Cata 1-1.
- Semáforos de Vikunja y Granola en verde.
- Una acción de prueba sin efecto (completar una tarea ya completada) fue procesada y confirmada por el puente.
- Publicador por `/u/ceo`: «publicado: 8 proyectos, 164 tareas».
- PWA: `manifest` y `sw.js` responden 200.
- Sin errores de JavaScript.

**Pendiente para el CEO:**
- Fijar su contraseña con el enlace.
- Reinstalar o volver a entrar en la PWA del teléfono con correo y contraseña.
- El reloj sigue con su clave actual, sin cambios.
- Dar el correo de Paula para darla de alta: `provision_user.py provision --produccion --vikunja-url http://127.0.0.1:3456 …`.

## 6. Después del corte

- 14-10 ~06:15: el CEO confirmó los pasos 1 (contraseña) y 2 (app del teléfono) y entregó el correo de Paula.
- Alta de Paula (`paula`, pschuler@inacap.cl):
  - Espacio propio en el Vikunja de producción (usuario `dsta-paula`, raíz 13), creado con la CLI de Vikunja porque el registro público está cerrado (`registration_enabled=false`). No se abrió el registro ni se reinició Vikunja.
  - Vault en `dsta-multiuser-prod`.
  - Invitación de un solo uso (24 h), entregada al CEO para que la reenvíe.
  - Aislamiento verificado: su token ve solo «Inbox» y «DSTA · Paula» y recibe 403 sobre la raíz 2 (PMO-DSTA).

## 7. Minutas manuales en producción (14-10-2026 09:55)

- Rama `feature/minutas-manuales-dashboard` (37c5734, de otro agente) revisada y validada:
  - 202 pruebas Python y 18 suites JS;
  - E2E de navegador del recorrido completo;
  - empaquetado en seco con la configuración de producción;
  - revisión de seguridad, de impacto sobre Granola y del puente del dueño.

  Autorización del CEO: Telegram 14-10 12:54 UTC, «OK».
- Respaldo previo en `Documents/DSTA-respaldos/2026-10-14-pre-minutas-manuales/`: bandeja del dueño `dsta-minute-inbox.json`, versión anterior **56f2c896-63b7-463f-bc54-4c2d4dae1c0d** y tag `pre-minutas-manuales-2026-10-14` (= e14bd52) en el repositorio de producción.
- Integración por fast-forward en `feat/multiusuario`, más `CODE_VERSION = "minutas-manuales-2026-10-14"` (541e402).
- Procedimiento:
  1. Se detuvieron Hermes Bridge, Cloud Sync y Multiusuario Bridge.
  2. Se avanzó el código de la VM.
  3. Deploy de la versión **94c4320b-f049-467f-99c6-8942da27d757**.
  4. `/api/bridge/runtime`: `ownerBox == worker` de inmediato.
  5. `manual-next` del dueño responde `{"job":null}`.
  6. Se reanudaron los servicios; el puente del dueño quedó sin errores.
- Esperado y conocido: el puente multiusuario registra «snapshot de paula falló (HTTPError)» hasta que Paula acepte su invitación (404 mientras su cuenta no exista en D1).
- Vuelta atrás:
  1. `npx wrangler rollback 56f2c896-63b7-463f-bc54-4c2d4dae1c0d --name dsta-web`.
  2. En el repositorio de producción, `git reset --hard pre-minutas-manuales-2026-10-14`.
  3. Reponer `dsta-minute-inbox.json` desde el respaldo si hiciera falta.
  4. Reiniciar las 3 tareas.

  Los borradores manuales quedan en el DO y no molestan al código anterior.

## 8. Ajustes del 14-10 (mañana) tras la prueba del CEO

- **Todos los «Generar minuta» con el flujo manual** (a007408, versión a2567b99 y siguientes). Antes solo funcionaba la primera minuta de la página, porque el contenedor del panel quedaba marcado. Ahora se usa una marca por campo y hay un E2E por botón (`tests/e2e_manual_minutes_buttons.mjs`).
- **Sin «Vista previa»**, por decisión del CEO (Telegram 14-10 13:28: «es redundante y no aporta»).
- **Granola del dueño.**
  - La exportación horaria de Hermes fallaba con `OAuthNonInteractiveError` (token vencido). `hermes mcp test granola` lo renovó, y una exportación manual trajo 1 minuta nueva.
  - En ⚙, la cuenta del dueño mostraba el flujo OAuth por usuario, que nadie atiende para el dueño, y quedaba «pegado». `/api/session` ahora devuelve `owner`, y para el dueño ⚙ muestra «se administra en la VM (Hermes)» con su estado real (1eaf414).
- **Minuta manual del dueño fallaba con `FileNotFoundError`.**
  - Causa: Hermes solo recibe el prompt como argumento, Windows limita la línea de comandos a 32.767 caracteres (WinError 206) y el prompt medía unos 53.000.
  - Arreglo (3d6ab74): los prompts de más de 30.000 caracteres van a Claude por stdin, sin pausar Hermes. Además se acotaron los contextos (analista: 20.000; copiloto multiusuario: 26.000).
  - Validado con el modelo real sobre una copia de la bandeja: prompt de 22.520 caracteres, Hermes respondió en 15 s.
  - Puentes reiniciados; el Worker no cambió.

## 9. Minutas: opción 1 y ventana nueva (14-10-2026, ~10:55)

- **Opción 1, aprobada por el CEO.** El analista de minutas manuales del dueño ya no recibe el portafolio en el prompt: consulta Vikunja con herramientas de solo lectura (`pmo_open_tasks`, `pmo_list_tasks`). El prompt bajó de unos 53.000 a unos 2.700 caracteres (28e5367).
  - Causa del reclamo del CEO: la versión intermedia, que recortaba a 20.000 caracteres, dejó fuera las LT mencionadas; el analista solo vio LT1 y LT2.
  - Validado con el modelo real: encontró la tarea citada.
- **Ventana «Minutas»** (4e17e50, versión 1684ccdf):
  - el botón se llama «Minutas»;
  - lista todas las minutas guardadas (`/api/minutes?all=1`) junto con los borradores manuales, con etiqueta de origen (Granola, Manual u otro), estado, búsqueda, filtros con contadores (Todas, Granola, Manual, Por revisar) y agrupación por mes;
  - detalle con resumen, antecedentes y acciones, y «Revisar en 🔔», que abre esa minuta en la bandeja;
  - editor integrado y «Volver a procesar» para minutas manuales sin decisiones aplicadas. El Worker lo rechaza si ya hay acciones aplicadas o si la minuta fue descartada.
  - Pantalla completa en móvil.
  - E2E con capturas en `tests/e2e_manual_minutes_buttons.mjs`.
- **Granola del dueño en ⚙:** «✓ Granola conectado · tus minutas llegan solas cada hora a través de la VM; no necesitas hacer nada aquí».
- **Deploy:** el cajón del dueño volvió a quedar con el código anterior por el tráfico. Se pausaron el puente y el publicador, el cajón tomó `CODE_VERSION = minutas-ventana-2026-10-14` en unos 10 s y se reanudaron ambos.

## 10. Minutas: eliminar, actualización inmediata y espaciado (14-10-2026, ~11:20)

- **Eliminar en «Minutas»**, con confirmación en la misma pantalla:
  - un borrador se borra (de la cuenta y del dispositivo);
  - una minuta procesada, de Granola o manual, se oculta de la lista y de la bandeja mediante la decisión `eliminar`.
  - La VM la marca con `eliminadaEn` (además de `descartadaEn`), así que no se reimporta ni se reanaliza. Una nueva subida del puente tampoco la hace reaparecer.
  - Los cambios ya aplicados en Vikunja se mantienen.
- **Actualización inmediata:** al terminar una decisión de la bandeja, el dashboard se refresca en ese momento y no tras 30 s. El puente ya publica el snapshot antes de cerrar la decisión. Esta era la causa de que el CEO no viera la nota aplicada a la tarea #164.
- El botón «Minutas» quedó separado del resto, como los demás botones del encabezado.
- Deploy: versión 4559f255, `CODE_VERSION = minutas-eliminar-2026-10-14`. El cajón del dueño se actualizó con los servicios pausados y luego se reanudaron los 3. Código en 8fa74b1. 206 pruebas Python, más las suites JS y los 2 E2E.

## 11. Texto original de Granola en «Minutas» (14-10-2026, ~16:00)

- **Problema:** el CEO preguntó por qué la minuta de Cata 1-1 se veía distinta a la de Granola. Respuesta: el detalle mostraba `resumen`, que es el análisis del asistente; el texto de Granola solo vivía en la VM («Minutas 2026»).
- **Decisión del CEO:** opción 1, guardar el texto en su espacio del dashboard (Telegram 14-10 18:53 UTC, «1»).
- **Cambios (f4a6c3b, versión 39d6ae28, `CODE_VERSION = minutas-texto-2026-10-14`):**
  - El puente del dueño adjunta el archivo exportado (`minute_original`, hasta 60.000 caracteres) a cada minuta que publica. Al reiniciar republica todas: 27 de 28 con texto.
  - El puente multiusuario adjunta el resumen de Granola del usuario.
  - El Worker lo guarda aparte, en `minute-text:<id>`, para que la lista de la bandeja no crezca. Lo sirve en `GET /api/minutes/text?id=`, lo conserva si una subida posterior no trae texto y lo borra al eliminar la minuta.
  - La ventana muestra «Minuta · texto original (Granola)» separado de «Análisis del asistente».
- 208 pruebas Python, más las suites JS y los 2 E2E. Despliegue con los servicios en pausa hasta que el cajón del dueño tomó la versión nueva.

## 12. E14: skill de minutas y revisión guiada (15-10-2026, ~11:30)

- **Autorización:** el CEO aprobó por Telegram el 15-10 a las 14:31 UTC («Ok»).
- **Qué se desplegó:** la integración `40f600f` (rama `integracion/e14`), versión del Worker `6836e120`, `CODE_VERSION minutas-skill-2026-10-15`. Los dos puentes se reiniciaron con la skill.
- **Volver atrás:**
  1. `wrangler rollback 05dd8bd9-eaa1-4cf7-9c66-f98343256d6e --name dsta-web`.
  2. En el repo de producción, `git reset --hard pre-e14-2026-10-15`.
  3. Reiniciar las 3 tareas.

## 13. Escritura a mano en minutas manuales (15-10-2026, ~15:10)

- **Autorización:** el CEO la dio por Telegram el 15-10 a las 18:05 UTC («llevemos a producción»).
- **Qué se desplegó:** commit `7095be0`, versión del Worker `957d190e`, `CODE_VERSION minutas-lapiz-2026-10-15`.
  - Modos Teclado y Lápiz (`public/ink.js`).
  - La tinta se guarda aparte, en `manual-ink:<id>`.
  - Cola de transcripción `/manual/transcribe`, que la VM atiende con `tools/ink_transcribe.py` (Claude con visión).
- **Volver atrás:**
  1. `wrangler rollback cee2e212-e963-4f56-9fb1-16dbc705b3af --name dsta-web`.
  2. En el repo de producción, `git reset --hard pre-lapiz-2026-10-15`.
  3. Reiniciar las 3 tareas.
- **Pendiente:** primera prueba con iPad y Apple Pencil reales (palma, presión, calidad de la transcripción de letra real).
