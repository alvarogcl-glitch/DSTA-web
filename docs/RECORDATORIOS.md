# Recordatorios del dashboard

E15 preparado sobre `6aa9ace`, rama `feature/recordatorios-dashboard`.
El usuario eligió «Lo primero»: dashboard + PWA como canal principal, recordatorios manuales
vinculados o independientes y repeticiones básicas. El 16-10-2026 autorizó integrar, configurar push,
publicar y realizar lo pendiente de forma autónoma, sin nuevas aprobaciones o revisiones.

## Recorrido

- ⏰ abre próximos/pendientes e historial. «Recordarme» en el inspector crea uno vinculado.
- Texto, fecha/hora de Santiago y repetición: una vez, diario, semanal o lunes a viernes.
- Crear, editar, cancelar, atender o posponer 15 minutos, una hora o mañana a las 09:00.
- Atender no completa la tarea ni escribe en Vikunja. Cancelar una serie cancela sus avisos pendientes.
- El chat consulta la misma lista y usa el mismo servicio: pide lo que falte y procesa un cambio
  por consulta. Solo confirma después de validar campos, alcance, intención, revisión y guardado.
- Activación push voluntaria por dispositivo. Aviso genérico por defecto; detalle en pantalla
  bloqueada optativo. Envío aceptado por el servicio push no significa recepción o lectura.
- Sin permiso/conexión, el aviso queda en el dashboard. Activar un dispositivo aplica a avisos
  futuros, sin envío masivo de pendientes anteriores.
- No se migran cronjob de Hermes, activan avisos automáticos de todas las tareas ni agrega Telegram.

## Contrato y archivos

`src/reminders.js`: validación, cálculo temporal, recibos, historial, programación y entrega.
Se carga desde el DO existente por cuenta. `src/web-push.js`: Web Crypto, ECDH P-256,
HKDF SHA-256, aes128gcm (RFC 8291/8188), VAPID ES256 (RFC 8292). Sin dependencia npm nueva.

`/api/reminders/{list,push-config,operation}`: GET.
`/api/reminders/{save,cancel,snooze,attend,subscribe,unsubscribe}`: POST JSON.
Requieren cuenta, origen propio y `x-dsta-actor` igual al actor de la sesión. El servidor resuelve
cajón, sesión e identidad de entrega. La asociación a una tarea valida el snapshot propio.

Cada cambio usa UUID de operación, UUID de recordatorio y revisión. Repetir el mismo cuerpo
devuelve el recibo anterior; cambiarlo con el mismo UUID se rechaza. El navegador conserva solo
identificadores de una operación incierta, sin texto privado; consulta su confirmación al recargar.
No reenvía automáticamente con otro UUID. Si falla setAlarm después de persistir, repetir la
operación rearma la alarma antes de confirmar.

`DashboardChatQueue.alarm()` activa la próxima fecha sin VM/IA. Materializa una ocurrencia durable
antes de enviar. Una etiqueta estable evita apilar notificaciones repetidas; no se promete entrega
exactamente una vez por la red. Tres intentos por dispositivo, separados por un minuto; 404/410
elimina el endpoint. Avisos de más de 24 horas quedan solo en el dashboard.

El contador viaja en `/api/dashboard` existente. La lista se consulta al abrirla, volver a la pestaña
y en los refrescos con el diálogo abierto. No aumenta el sondeo de la VM.

Recurrencias a la hora local, con ancla semanal. Tras una demora se genera una sola ocurrencia
atrasada y se calcula la siguiente futura. Se rechazan horas iniciales inexistentes/ambiguas;
las recurrencias omiten esa fecha si coincide con el cambio de hora (explicado en el formulario).
Posponer cambia el próximo aviso; después se retoma la hora original de la serie.

Límites: 200 recordatorios activos por cuenta, 10 dispositivos, 300 caracteres y fecha inicial
futura hasta 366 días. Eventos, recibos y confirmaciones de chat de más de 90 días se depuran
al ejecutar alarmas. Las fichas canceladas/atendidas se conservan.

## Aislamiento y dispositivos

`public/reminders.js` y `.css`: diálogos e inspector. `public/sw.js`: en IndexedDB solo la huella
de la cuenta activa; no cachea tareas, credenciales ni endpoints. Descarta push de otra cuenta.
Logout cierra avisos visibles y revoca dispositivos de esa sesión. Antes del envío se comprueba
sesión vigente/cuenta habilitada. Cambiar cuenta invalida la suscripción anterior del navegador.
Solo se aceptan endpoints push conocidos de Chrome/Firefox/Apple y no se siguen redirecciones.

La notificación conserva el destino al pasar por login, con cuenta comprobada antes de abrir la
lista. `public/account.js` coordina logout; `public/login.js` admite solo el destino interno validado.

`tools/reminder_copilot.py`: interpretación sin herramientas común a ambos puentes. Usa los motores
existentes del perfil `copiloto`, sin cronjob ni MCP. La ruta Basic mantiene Hermes y sus recordatorios
existentes. El nuevo servicio requiere modo cuentas.

## Procedimiento de publicación autorizado

1. Contrastar con la base productiva vigente y preservar los cambios de latencia ajenos a E15.
2. Generar en privado un par VAPID P-256. No imprimir ni versionar la privada. Configurar
   `WEB_PUSH_PUBLIC_KEY` (punto público sin comprimir de 65 bytes, base64url), `WEB_PUSH_PRIVATE_KEY`
   (escalar privado de 32 bytes, base64url, secreto Cloudflare), `WEB_PUSH_SUBJECT` (contacto mailto/HTTPS).
3. Publicar Worker/assets juntos. Sin migración D1 ni bindings nuevos. Si faltan claves, la UI
   informa que push no está configurado y conserva recordatorios internos.
4. Instalar `reminder_copilot.py` y actualizar ambos puentes; reiniciar solo esos servicios según
   el procedimiento operativo. No reiniciar VM ni tocar el publicador.
5. Comprobar versiones y cuenta QA separada. Probar IA real y Android físico con consentimiento:
   activar, cerrar dashboard, recibir, abrir, posponer, desconectar/reconectar, logout y cambio de cuenta.
6. Rollback: publicar esta versión con `REMINDERS_PAUSED=on`, conservar handler/datos y restaurar
   interfaz/Python previos. El handler pausado elimina las alarmas al despertar sin enviar avisos.
   No retirar ese handler hasta comprobar que no quedan alarmas. Para reactivar, quitar la pausa
   y volver a guardar/rearmar los recordatorios que deban continuar. No borrar cajones ni cronjob.

## Evidencia local

Capturas ficticias y resultados en `convergencia/evidencia/recordatorios/`.
Python: 239 pruebas con runtime 3.12 existente. JavaScript: suites previas y cinco nuevas.
Chrome: 1280×900 y 390×844, Worker/DO reales en memoria, cuentas ficticias. Wrangler staging
en seco correcto. No publicación, configuración de claves reales ni avisos externos.

Pruebas nuevas: alcance, revisiones, recibos, fallos de alarma, recurrencia/DST, cancelación,
reintentos, sesiones revocadas, endpoints expirados, privacidad por defecto, firma VAPID y
descifrado independiente con OpenSSL, ciclo SW y recorrido Chrome. Antes de implementar, la
prueba falló por ausencia del módulo. IA real, Android físico y aceptación humana quedan pendientes.
