# Continuidad de agentes para DSTA

## Estado más reciente · E15 recordatorios

16-10: usuario dijo «Revisado» y autorizó publicación autónoma sin más aprobaciones/revisiones.
E15 integrado en main: versión Worker y objeto dueño `recordatorios-2026-10-16-r2`,
corrección final `733ad2a`. Assets desplegados contrastados con Git; VAPID configurado.
Ambos puentes actualizados (PID 15824 dueño, 3328 multiusuario), publicador 3280 preservado.
Tres archivos runtime instalados: hermes_bridge.py, multiuser_bridge.py, reminder_copilot.py.
El merge de hermes_bridge conserva la instrumentación local previa; no resetear ese checkout.

Copia fuente: `C:/Users/admin/Documents/ChatGPT/Dashboard DSTA/work/reminders`,
`feature/recordatorios-dashboard`, base `6aa9ace`. Su origin es el piloto local; publicación
mediante URL explícita GitHub. No hacer push al piloto para publicar ni desplegar staging.
Leer `docs/RECORDATORIOS.md`, E15/A20 y `evidencia/recordatorios/produccion/`.
239 pruebas Python y 23 suites JS; IA real local y ambos puentes productivos con cuentas QA;
push Chrome real con páginas cerradas comprobado. Android físico no disponible/no verificado.

Respaldo privado cifrado en `%LOCALAPPDATA%/hermes/cache/dsta-reminders-release-20261016`:
Worker previo `040aa4af-0d4b-4060-b66d-26dc46ae6843` igual a compilación `6aa9ace`,
runtime previo y patch ajeno. Nunca versionar ese respaldo. Evidencia pública solo sanitizada.
La transición breve del objeto dueño no borró datos ni detuvo publicador/VM. No dejar
`DSTA_OWNER_DRAIN_UNTIL` configurado: se eliminó tras verificar ambas versiones.
Los datos QA se limpian por IDs exactos registrados en estado cifrado; nunca patrones amplios.
No tocar staging/alvaro, cronjob, tareas o minutas personales. Siguiente cambio de producto:
esperar elección del usuario dentro del plan. Las secciones inferiores son historia previa.

## Estado para retomar

Fecha de referencia: 13 de octubre de 2026. Esta entrega prepara documentación de convergencia; no implementa cambios funcionales y no publica nada.

Chat de origen en Codex local: 01a136bc-8875-7c52-9e2b-59ec85b923dc. Título observado: “Revisa el piloto multiusuario”. Leer sus respuestas posteriores si una decisión aún aparece pendiente en este archivo.

El usuario quiere preservar la comodidad de producción, revisar las mejoras multiusuario y decidir paso a paso cómo quedan ambos ambientes. Leer primero [PLAN.md](PLAN.md), luego [MATRIZ_DECISIONES.md](MATRIZ_DECISIONES.md), [REGISTRO_DECISIONES.md](REGISTRO_DECISIONES.md) y [ACEPTACION.md](ACEPTACION.md).

Actualización 13-10 (tarde): el CEO pidió que Claude Code (chat Telegram) lleve el plan. Decisiones del día registradas en REGISTRO_DECISIONES; Entrega E01 corrigió D18/D19 (commit 303708e, staging f7ceee69). Estado (13-10 noche):
- D01 decidida (mix A + B).
- D03 y D04/D07 decididas e implementadas en el piloto: Entrega E02, commit 3d37438, staging 99149651. Falta la prueba del CEO.
- D02, D05 y D06 decididas e implementadas en el piloto: Entrega E03, commit e188492, staging 4903d603. Falta la prueba del CEO.
- D08–D16 decididas (D14 implementada en E04, staging 57ec91a8). D16 requiere un cambio en producción al converger.
- D17–D25 decididas (E01 y E05; staging deec1978).
- D26–D30 decididas e implementadas (E06, staging dd6ee1a2).
- D31–D37 decididas (E07, staging ecdfac8a).
- D38–D42 decididas (E08, puente 18672ef).
- D44–D54 decididas (E09, staging ee18087f).
- D55, D57–D59 decididas (E10, staging bfd8555c).
- D61–D63 y D67 decididas (E11, staging c31e37c2).
- D66–D72 aprobadas para el corte (sin fecha). E12 (numeración propia por usuario) publicada en staging 46396af7.
- **Corte a producción ejecutado el 14-10-2026.** Ver CORTE_PRODUCCION.md: respaldo, registro y vuelta atrás.
- Siguiente: que el CEO fije su contraseña, que entregue el correo de Paula para darla de alta en producción, y monitorear 48 h (cuota de Cloudflare y logs de `%LOCALAPPDATA%/hermes/logs/dsta-bridge.log` y `dsta-multiuser-prod/bridge.log`).
- Las demás decisiones siguen por decidir.

Producción no cambia sin una autorización concreta.

D01 no autoriza por sí sola escrituras automáticas de IA; D03 define ejecución/propuestas. D04/D07 definen información y trazabilidad compartida. Primer incremento después de elegir esas decisiones: recorrido de creación completo con contexto aislado y su UI elegida.

## Directorios y ambientes

| Uso | Ruta o dirección |
|---|---|
| Coordinación y AGENTS de entrada | C:/Users/admin/Documents/ChatGPT/Dashboard DSTA |
| Código piloto canónico | C:/Users/admin/Documents/DSTA-multiuser/dsta-web-mu |
| Rama piloto | feat/multiusuario |
| Documentación vigente | docs/convergencia/PLAN.md y archivos enlazados |
| Código producción | C:/Users/admin/Documents/Codex/2026-09-22/hola/work/DSTA-web |
| Rama producción | main |
| Producción web | https://dsta-web.alvaro-gcl.workers.dev |
| Piloto web | https://dsta-web-staging.alvaro-gcl.workers.dev |
| Vikunja producción | http://127.0.0.1:3456 ; raíz PMO-DSTA 2 |
| Vikunja laboratorio | http://127.0.0.1:14701 ; raíz personal alvaro 403 |
| Config Cloudflare piloto | wrangler.staging.jsonc |
| Config producción | wrangler.jsonc |
| Runtime piloto | %LOCALAPPDATA%/dsta-multiuser |
| Puente piloto | tools/multiuser_bridge.py ; bridge.env local |
| Runtime productivo | %LOCALAPPDATA%/hermes |
| Puente productivo | tools/hermes_bridge.py |
| Publicador productivo | tools/publish_dashboard.py |

Hay otras copias: implementation-20261011 contiene un piloto pequeño de aislamiento; candidate-20261011-175710 es otro candidato histórico. No son la base de este plan. No confundir el Worker dsta-multiuser-pilot-20261012 con dsta-web-staging.

## Antes de trabajar

1. Leer instrucciones aplicables del workspace/repositorio y estos documentos.
2. Consultar git status, branch, log y worktree list. La documentación quedó en un commit local de la rama piloto; no asumir que está publicada en GitHub.
3. Leer la última respuesta humana y REGISTRO_DECISIONES. Respetar elecciones ya tomadas y autorización existente; una recomendación no es aprobación.
4. Comparar estado remoto/servicios si el cambio depende de despliegue. Los hashes y cantidades del baseline son del momento de auditoría, no estado perpetuo.
5. Delimitar un incremento de decisiones tomadas. Si falta elección, presentar opciones concretas mientras se hace trabajo independiente permitido.
6. Preparar fixture separado y verificar scripts de prueba antes de ejecutarlos. Los datos de Álvaro y Granola en staging no son desechables.
7. Elegir ambiente de implementación. Trabajar en feat/multiusuario salvo razón registrada; no cambiar de rama la copia productiva ni hacer merge masivo de main sin revisar contratos.
8. Al cerrar, actualizar registro, aceptación y esta sección de estado; anotar commit y siguiente pregunta.

No escribir a otros chats ni crear agentes solo porque este archivo menciona continuidad. La solicitud actual autoriza que puedan retomar, no enviarles mensajes.

## Mapa técnico para los incrementos

| Área | Archivos principales del piloto |
|---|---|
| Autenticación, acciones, snapshots, layout y cajas por usuario | src/worker.js ; migrations/0001_accounts.sql |
| Interfaz común e inspector | public/index.html |
| Copiloto y Aplicar | public/assistant.js ; tools/user_copilot.py |
| Creación/edición/movimiento/archivo directo | public/structure-actions.js ; tools/structure_actions.py |
| Completar y bitácora | public/task-actions.js ; tools/hermes_bridge.py |
| Etiquetas | public/labels.js ; tools/label_actions.py |
| Configuración, cuenta, layout | public/settings.js ; public/account.js ; public/layout.js |
| Despacho, publicación y pools | tools/multiuser_bridge.py |
| Raíz y credenciales por persona | tools/user_context.py ; tools/user_vault.py ; tools/provision_user.py |
| Conexión/importación Granola | tools/granola_user.py ; tools/granola_client.py |
| Minutas e instrucciones | tools/user_minute_inbox.py ; tools/minute_inbox.py ; public/inbox.js |
| Lectura/campos de tareas | tools/publish_dashboard.py |
| Herramientas de producción que se deben contrastar | tools/vikunja_dashboard_mcp.py ; tools/minutas_mcp.py ; tools/hermes_bridge.py |

La rama piloto no incluye pmo_tasks_created de producción. Incorporar consultas del dueño sin aislar root/token volvería a romper el propósito multiusuario. Toda herramienta nueva se liga al actor autenticado y a su credencial/raíz, nunca a IDs aportados por el modelo sin validación.

## Hallazgos iniciales y cautelas concretas

- Archivar por structure_actions no comprueba línea vacía/subproyectos y permite ocultar tareas del dashboard.
- Crear/renombrar líneas directas no conserva check_unique_title de producción.
- Crear por formulario no añade la descripción estructurada ni SOURCE/ACTION_KEY de pmo_create_task.
- task.log reejecutado agrega el mismo registro otra vez en prueba simulada. No afirmar que se observó duplicación en datos reales.
- El modo de registro se descubre asíncronamente; revisar el recorrido antes de permitir guardar.
- Formulario y Aplicar no guardan su UUID/seguimiento como los controles heredados.
- UserMinuteInbox aplica reglas del motor productivo; analyze_minute/handle_decision no publican de inmediato snapshot de tareas.
- Contexto IA del chat: 400 caracteres de descripción, 30000 del contexto, 15 minutas/600 caracteres. No ofrece equivalente a consulta paginada ni lectura de minuta completa.
- Snapshot no contiene created: no inferir creación desde due_date, bitácora o updated.
- PUBLISH_SECONDS actual 300; documentación anterior hablaba de 120 y de fases no habilitadas. Verificar código y servicio antes de repetir esas afirmaciones.
- Granola está configurado ready y hay 30 minutas importadas; esto no prueba nuevamente refresh real. La muestra no acredita ejecución automática de minutas.
- El runbook F6 histórico tiene afirmaciones de alcance pendientes ya superadas; debe revalidarse contra decisiones finales.

## Evidencia y comandos de referencia

[baseline.json](evidencia/baseline.json) y [functional-probes.json](evidencia/functional-probes.json) guardan resúmenes sin secretos. En el workspace de coordinación, .audit/production-tests.log y .audit/pilot-tests.log conservan salida de suites. .audit/compare_readonly.py y .audit/functional_probes.py permiten comprender la auditoría; sus rutas son locales. La segunda usa FakeVikunja, no datos reales.

Comandos read-only:

```powershell
git -C 'C:/Users/admin/Documents/DSTA-multiuser/dsta-web-mu' status --short
git -C 'C:/Users/admin/Documents/DSTA-multiuser/dsta-web-mu' log -5 --oneline
git -C 'C:/Users/admin/Documents/DSTA-multiuser/dsta-web-mu' worktree list
git -C 'C:/Users/admin/Documents/DSTA-multiuser/dsta-web-mu' diff main..feat/multiusuario --stat
```

Pruebas locales, desde la copia adecuada, leyendo antes sus instrucciones:

```powershell
$env:PYTHONUTF8='1'
npm test
npx wrangler deploy --dry-run --config wrangler.staging.jsonc
```

El segundo comando no publica. No sustituirlo por deploy ni usar wrangler.jsonc para probar staging. Tras cambio Python, desplegar Worker no actualiza el servicio local; tras cambio UI, reiniciar Python no cambia assets. Registrar cada capa por separado.

## Operación y cambios autorizados

No exponer tokens, cookies, contraseñas, hashes de autenticación o links de invitación. Rutas de secretos se documentan, valores no. No apagar/reiniciar VM; no detener servicios ajenos al incremento autorizado.

Para la fuente productiva, las escrituras habituales siguen las reglas del MCP y del puente del proyecto; no usar REST parcial que borra campos. Las acciones deterministas del piloto son mecanismos existentes, no autorización para probar sobre datos personales.

No hacer push a main ni desplegar producción hasta que el usuario autorice una entrega concreta. Los cambios decididos se preparan y verifican antes de pedir la autorización que falte. No volver a solicitar permisos ya concedidos en la sesión. Durante este plan no se autorizó un corte.

Para implementación visible, mostrar el recorrido del incremento y dejar estado verificado pendiente de aceptación humana si todavía falta esa revisión. No cerrar por presupuesto/tiempo ni pasar al siguiente bloque sin actualizar continuidad.

## Mensaje para retomar en otro agente

“Continúa el plan de convergencia DSTA. Lee C:/Users/admin/Documents/DSTA-multiuser/dsta-web-mu/docs/convergencia/PLAN.md y CONTINUIDAD_AGENTES.md, el registro de decisiones y las instrucciones del workspace. Comprueba Git y estado actual. Retoma la primera decisión o entrega pendiente; respeta decisiones previas y conserva producción hasta la autorización correspondiente. Actualiza documentación y evidencia al cerrar cada incremento.”


## Incremento posterior: minutas manuales (Codex, 14-10-2026)

Implementación local E13 en `feature/minutas-manuales-dashboard`, desde origin/main 1bd8846, en `C:/Users/admin/Documents/DSTA-multiuser/minutas-manuales-dashboard`. No confundir con la copia operativa main ni cambiar los servicios que la ejecutan. Leer [MINUTAS_MANUALES.md](../MINUTAS_MANUALES.md), registro E13 y evidencia/resultados.json. El usuario prohibió expresamente merge y despliegues en esta entrega.

El código del dueño usa Hermes Bridge sin vault; su ingestión manual viaja en el poll de chat y conserva `hermes/cache/dsta-minute-inbox.json`. Otras cuentas usan el dispatcher y `UserMinuteInbox`. Ambas rutas comparten motor, esquema y revisión humana. Granola mantiene automatismos; Manual-Dashboard siempre propone. Los borradores están en el DO propio y su recuperación local es ciphertext con clave solo disponible tras autenticar esa cuenta.

Estado: verificado local, pendiente revisión/aceptación humana y ensayo de modelo real en QA separado. Próximo paso autorizado no implica publicar: revisar el commit local de esta rama y los escenarios A18. La publicación posterior requiere coordinar Worker/assets y ambos Python, sin nueva migración/secretos; no ejecutar ese paso automáticamente. Nunca usar staging/alvaro o tareas productivas como fixtures.


## Incremento posterior: skill de minutas y revisión (Codex, 15-10-2026)

E14 implementado/verificado local en `codex/minutas-contexto-skill`, desde E13 `37c5734`, en `C:/Users/admin/Documents/DSTA-multiuser/minutas-manuales-dashboard`. El «ok» del usuario autoriza preparación/implementación/pruebas locales; no integración ni publicación. Skill común obligatoria y contexto completo para dueño/Granola y UserMinuteInbox, Otra y Otros cambios en bandeja. Revisar `docs/MINUTAS_SKILL.md` y evidencia `docs/convergencia/evidencia/minutas-skill/` en esa copia. 211 pruebas Python, 18 suites JS, E2E local desktop/móvil, skill y empaquetado seco aprobados; modelo/Vikunja simulados. Sin cambios de servicios/datos personales.

Próximo: aceptación del recorrido y ensayo con IA real en QA separado. No reprocesar minutas personales para probar. La rama incluye E13; contrastar main actual antes de integrar ambas mejoras. Una entrega futura debe instalar también `minute_analysis.py`, `hermes_prompt_transport.py`, `hermes_query_stdin.py` y `tools/skills/dsta-revisar-minutas/SKILL.md` con ambos puentes. Las minutas manuales siguen siempre como propuestas; Granola conserva su política. Aprobar temas sin LT solo los acepta para revisión. Main/servicios/producción permanecen intactos.
