# Cierre y traspaso E15 · Recordatorios

Registro del 16-10-2026, zona America/Santiago. Entrada común para agentes del proyecto.

## Decisión y estado

El usuario eligió dashboard + PWA, recordatorios manuales independientes o vinculados a tareas,
repeticiones diarias/semanales/hábiles y aviso genérico por defecto. Después de «Revisado»,
autorizó expresamente integrar, configurar, probar y publicar autónomamente sin nuevas revisiones.
El 16-10 pidió documentar todo para trazabilidad y alineación de sus agentes.

Entrega funcional publicada y verificada. Base `6aa9ace`, implementación inicial `497d81c`,
corrección final `733ad2a`, cierre con evidencia `09d5e1d`. Versión lógica
`recordatorios-2026-10-16-r2`. La verificación posterior al cierre fue a las 10:16 de Chile
(13:16 UTC): Worker y objeto dueño con la misma versión, assets contra Git y rutas privadas.
La versión Cloudflare observada fue `f5354511-c95f-4617-824f-59fee2321814` al 100 %.
Estos identificadores son evidencia fechada: comprobar el estado vigente antes de otra entrega.

## Papel de Hermes y de Cloudflare

| Paso | Responsable | Dependencia de IA/VM |
|---|---|---|
| Crear/editar por formulario | Worker y servicio de recordatorios del DO de la cuenta | Ninguna |
| Interpretar un pedido por chat | Puente dueño o multiusuario, prompt común de reminder_copilot.py, perfil copiloto | Requiere puente y motor configurado |
| Validar y guardar lo interpretado | Servicio de recordatorios del DO; confirma el resultado persistido | Sin herramientas del modelo ni escritura directa del modelo |
| Vencer, repetir y enviar Web Push | Alarma durable por cuenta y emisor Web Push en Cloudflare | Sin Hermes, cronjob, IA ni VM |
| Mostrar/abrir el aviso | Service Worker del navegador y cuenta autenticada | Suscripción, permiso, sesión válida, navegador/SO y red |

Los nuevos recordatorios **no usan el cron de Hermes**. Los puentes existentes se reutilizan
para interpretar lenguaje natural; `UserCopilot.ask` usa el orden de motores del perfil
`copiloto`, que puede incluir Codex, Claude o Hermes. La evidencia real de esta entrega usó
Codex gpt-6-luna: no afirmar que el motor de interpretación será siempre Codex ni que todo el
chat evita Hermes. En este modo no se habilitan cronjob ni MCP de Vikunja.

Los cronjob anteriores de Hermes permanecen separados y sin migración. E15 no incorpora
Telegram ni crea recordatorios automáticamente para todas las tareas. Atender un recordatorio
no completa una tarea ni escribe en Vikunja. La recepción depende del dispositivo; no se promete
entrega con el navegador/SO apagado ni exactamente una vez a través de la red.

## Evidencia y límites

[Evidencia productiva](evidencia/recordatorios/produccion/README.md): IA real por ambos puntos
de entrada instalados, guardado y cancelación en QA; Chrome recibió un push real con todas las
páginas cerradas, texto genérico, una ocurrencia y aislamiento entre cuentas. Se comprobó el
retorno por login, apertura del destino, atender sin completar tarea y desactivar suscripción.
239 pruebas Python, 23 suites JavaScript y recorridos Chrome 1280×900/390×844 locales.
Android físico no disponible/no verificado; no convertirlo en prueba realizada.

Cuatro cuentas QA, sesiones, cajones y marcas propias retirados. Dashboard del dueño y Vikunja
coincidieron en IDs: 147 tareas, siete líneas, cinco etiquetas, ningún ID perdido o agregado.
Se observó un cambio de título/descripción en una tarea durante la entrega y se preservó.
No se atribuye su origen a partir de esa comparación; QA no escribió en Vikunja.
Los PIDs registrados son una fotografía, no una garantía permanente de salud.

## Mapa de copias y continuidad

- Fuente entregada: GitHub `alvarogcl-glitch/DSTA-web`, `main`.
- Copia de trabajo E15: `C:/Users/admin/Documents/ChatGPT/Dashboard DSTA/work/reminders`,
  rama `feature/recordatorios-dashboard`. Su `origin` apunta al piloto local; no usarlo para
  publicar. Los pushes productivos se hicieron a la URL explícita de GitHub, sin force.
- Runtime operativo: `C:/Users/admin/Documents/Codex/2026-09-22/hola/work/DSTA-web`,
  rama local `codex/assistant-latency-instrumentation`. Conserva cambios de latencia previos.
  Se instalaron únicamente `hermes_bridge.py`, `multiuser_bridge.py`, `reminder_copilot.py`;
  el primero conserva el merge de instrumentación. Worker/assets salieron de la copia E15.
  No resetear ni cambiar de rama para intentar igualar el checkout a main.
- Piloto: `C:/Users/admin/Documents/DSTA-multiuser/dsta-web-mu`, `feat/multiusuario`.
  Solo documentación/evidencia E15 sincronizadas (primera sincronización `2da87a7`);
  sin despliegue de staging ni modificación de la cuenta alvaro/raíz 403.
- Coordinación: `C:/Users/admin/Documents/ChatGPT/Dashboard DSTA/PROJECT_CONTEXT.md`,
  que apunta al plan, registro E15, aceptación A20 y este cierre.

Los cambios de documentación posteriores a `09d5e1d` no representan otra entrega funcional.
El historial Git registra sus commits sin introducir hashes autorreferenciales en los archivos.
Las secciones antiguas de preparación/no publicación se conservan como historia; prevalecen
la autorización y el estado final E15. No declarar entregados otros incrementos por este cierre.

## Operación y siguiente paso

Secretos VAPID configurados en Cloudflare: se documentan nombres, nunca valores.
Respaldo privado cifrado y runtime anterior en
`%LOCALAPPDATA%/hermes/cache/dsta-reminders-release-20261016`; no subirlo al repo.
La transición acotada del objeto dueño fue necesaria por su código caliente anterior;
`DSTA_OWNER_DRAIN_UNTIL` se eliminó y ambas versiones se comprobaron iguales.
La VM y el publicador no se reiniciaron. El fallo de `redirect:'error'` en Workers se corrigió
con `redirect:'manual'`, sin seguir redirecciones. Runbook/rollback en
[RECORDATORIOS.md](../RECORDATORIOS.md).

La entrega está cerrada; cada usuario habilita avisos en sus dispositivos desde ⏰.
Android físico queda como comprobación de dispositivo pendiente, sin bloquear lo ya publicado.
Para un nuevo cambio, leer PROJECT_CONTEXT, PLAN, REGISTRO_DECISIONES, ACEPTACION y
CONTINUIDAD_AGENTES; comprobar Git/runtime y esperar la elección del usuario para otro flujo.
Este registro alinea a los agentes mediante archivos compartidos; no supone envío de mensajes
a otros chats, programación de automatizaciones ni cambios sobre datos personales.
