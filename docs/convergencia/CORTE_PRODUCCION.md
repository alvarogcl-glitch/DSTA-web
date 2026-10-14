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
