# F6: paso a producción del DSTA multiusuario (runbook)

Antes de usar este runbook, cerrar la equivalencia acordada en
[convergencia/PLAN.md](convergencia/PLAN.md). Sus decisiones pueden cambiar el perfil del dueño,
las herramientas del copiloto y la migración. Revisar todos los pasos contra el resultado final
y ensayar corte/rollback; este archivo no autoriza ejecutarlos.

> **EJECUTADO el 14-10-2026** con autorización del CEO (Telegram 14-10 02:34). Registro, respaldo y rollback vigentes: [convergencia/CORTE_PRODUCCION.md](convergencia/CORTE_PRODUCCION.md).
> Ensayo probado: bloque 16 de `tests/test_multiuser_worker.mjs`. El CEO mapeado a `pmo-dsta` ve sus datos sin migración, y el puente actual funciona sin cambios de código si su URL apunta a `/u/ceo`.

## Antes de decidir
- **Plan Workers Paid (≈ USD 5/mes).** El puente actual ya usa casi todo el cupo gratis de requests/día; agregar el puente multiusuario sin pasar a Paid arriesga dejar el dashboard sin servicio. Hay que verificar el precio vigente.
- Los 2 usuarios piloto y su correo.
- Vikunja: usar el de producción (`:3456`) con una cuenta por persona (`provision_user.py --vikunja-url http://127.0.0.1:3456`). Antes conviene repetir el E2E de laboratorio contra una copia del SQLite de producción.
- Granola real: una cuenta de prueba y confirmar que Granola acepta `https://dsta-web.alvaro-gcl.workers.dev/oauth/granola/callback` como redirect.

## Pasos (en orden, cada uno verificable)
1. **D1 de producción:** `wrangler d1 create dsta-web-accounts`. Se agregan a `wrangler.jsonc` el binding `DB` con su id y `migrations_dir`, y se aplica `migrations/0001_accounts.sql` en remoto.
2. **Cuenta del CEO (sin migrar datos):**
   - Crear una invitación para `ceo` con `provision_user.py`, o insertar la invitación a mano.
   - Al aceptarla, ejecutar `UPDATE users SET do_name='pmo-dsta' WHERE id='ceo'`.
   - Guardar el vault `ceo` con su token actual de Vikunja (desde `hermes/.env`) y `rootProjectId: 2`.
3. **Puente actual del CEO:** en su `.env`, `DSTA_DASHBOARD_URL=https://dsta-web.alvaro-gcl.workers.dev/u/ceo`. Hacer lo mismo con el publicador periódico (`/u/ceo/api/ingest`). No cambia código.
4. **Deploy:** agregar `"vars": {"AUTH_MODE": "accounts"}` a `wrangler.jsonc` y luego push y `wrangler deploy`. Desde ese momento Basic Auth deja de funcionar y se entra con cuenta.
5. **Verificación inmediata:**
   - El CEO entra con su cuenta y ve su portafolio completo.
   - Completar una tarea de prueba funciona.
   - El Copilot del CEO responde por el puente actual, con sus MCP y memoria como hoy: es su propio cajón.
   - El semáforo Vikunja/Granola está en verde.
6. **Puente multiusuario** (otro proceso en la VM) con `DSTA_DASHBOARD_URL=https://dsta-web.alvaro-gcl.workers.dev`. Atiende solo a los usuarios con vault; nunca a `ceo`, porque el CEO no tiene vault multiusuario.
7. **Alta de los 2 pilotos:** con `provision_user.py provision` y la invitación entregada a cada uno. Correr `staging_isolation_check.py` adaptado contra producción, con cuentas QA temporales.
8. **Piloto de 2 semanas.** Criterio de éxito: cero incidentes de aislamiento.

## Rollback (menos de 5 minutos)
1. `wrangler rollback` a la versión anterior al paso 4: vuelve Basic Auth y el cajón único. Los datos del CEO nunca se movieron.
2. Devolver `DSTA_DASHBOARD_URL` del puente del CEO a la URL sin `/u/ceo` y reiniciar la tarea `DSTA Hermes Bridge`.
3. Detener el puente multiusuario. Las cuentas de los pilotos quedan inertes en D1 y sus espacios en Vikunja se conservan.

## Riesgos conocidos
- Si en el paso 4 el puente del CEO aún apunta a la URL sin `/u/ceo`, sus llamadas responden 400 y el dashboard queda desactualizado hasta corregir el paso 3. Por eso el paso 3 va antes del 4. Durante el intervalo entre ambos el puente falla con 404, porque la ruta `/u/` no existe en modo de usuario único; es inofensivo y dura minutos.
- Refresh del token de Granola implementado; si falla se solicita reconexión. Validar renovación real en el alcance de aceptación elegido.
- El Copilot multiusuario actual no tiene herramientas de escritura, pero ya propone acciones confirmables con Aplicar. La ejecución definitiva se elegirá en las decisiones D01/D03 del plan de convergencia.
