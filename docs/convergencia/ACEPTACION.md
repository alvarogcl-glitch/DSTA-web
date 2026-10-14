# Aceptación funcional de DSTA

Las pruebas deben acreditar el comportamiento elegido para cada ambiente. Cada decisión de la matriz aporta su propio resultado observable; este archivo reúne los recorridos que impiden declarar equivalencia solo porque pasan pruebas unitarias.

## Datos de prueba y ambientes

- Usar fixtures o cuentas QA y raíces exclusivas de prueba. La cuenta alvaro, raíz 403 de :14701, tiene datos y minutas del usuario; no limpiarla ni usarla para escrituras de prueba.
- :3456 es Vikunja productivo. No completar, crear, mover o deshacer tareas reales para probar sin un alcance específico autorizado.
- A y B son cuentas QA independientes, no los nombres de personas reales ni la cuenta del dueño. Incluir en cada fixture tareas abiertas/completadas, fechas exactas, horizonte textual, sin responsable, dependencia, criterio, bitácora larga y varias etiquetas.
- Reservar casos con más de 50 tareas por línea y más de 15 reuniones para acreditar consultas paginadas y contexto completo. Incluir una línea vacía, una con abiertas/completadas y otra con subproyectos.
- El contenido de Granola debe ser ficticio para escrituras y automatismos. Si se necesita probar OAuth/refresh real, limitarlo a una cuenta autorizada y registrar conexión, renovación y desconexión sin secretos.
- Crear una lista de IDs QA antes de limpiar y comprobar usuario, raíz e instancia. Conservar evidencia de errores y evitar borrados por patrones de nombre.
- La duración de una operación se mide desde la acción del usuario hasta el resultado confirmado en pantalla. Los objetivos de tiempo se pactan en D60–D65 después de medir; no inventar SLA.

## Escenarios de aceptación

| Caso | Recorrido | Decisiones | Resultado exigido |
|---|---|---|---|
| A01 | Crear por chat y por formulario cuando estén habilitados. | D01–D07, D21, D37 | Tarea con todos los campos elegidos, IDs y origen verificables; ruta visual y confirmación acordadas. |
| A02 | Editar título, responsable, fecha, dependencia, criterio y descripción larga. | D05–D16 | Solo cambia lo elegido; bitácora, etiquetas, campos nativos y metadatos se preservan según contrato aprobado. |
| A03 | Completar, reabrir, mover y registrar. | D12–D19 | Resultado en Vikunja y snapshot; tipo Cierre no completa por accidente. |
| A04 | Cortar red antes/después de aceptación; recargar; entregar trabajo repetido. | D18–D19, D58, D62 | UUID consultable; una escritura por solicitud; incertidumbre visible; volver a consultar no crea otra acción. |
| A05 | Crear/renombrar a nombre o código ocupado; archivar con contenido; fusionar/restaurar. | D22–D27 | Reglas decididas, conservación de IDs y errores parciales recuperables. |
| A06 | Preguntar por fecha de creación, etiqueta y texto al final de descripción. | D28–D30 | Respuesta exacta basada en datos del usuario; consultar todas las páginas cuando corresponde. |
| A07 | Buscar acuerdo de reunión antigua, abrir cita, continuar conversación y Nueva sesión. | D31–D34 | Minuta correcta y contexto suficiente; historial y alcance elegidos; cero datos de otra cuenta. |
| A08 | Principal IA falla, respaldo responde; solicitud de recordatorio/proveedor propio. | D33–D37 | Capacidad real coincide con lo que promete la UI; respaldo identificado; no escrituras duplicadas. |
| A09 | Todas las operaciones directas y por chat de etiquetas habilitadas. | D30, D38–D39 | Asociación correcta y otras clasificaciones preservadas; catálogo de la cuenta correcta. |
| A10 | Granola connect, import, actualización de versión, token vencido, disconnect. | D40–D42, D47 | Sin mezcla de identidades, duplicados ni pérdida de descartes; estado real comunicado. |
| A11 | Minuta evidente/ambigua/irrelevante; aprobar, editar, rechazar, instrucción imposible, deshacer y descartar. | D43–D47 | Automatismo elegido, errores explicativos, reversión acotada y bandeja/portafolio sincronizados. |
| A12 | Layout inicial del dueño y persona nueva; guardar en otro dispositivo; filtros, selección, resumen y minuta. | D48–D54 | Mismo conjunto esperado de tareas y texto; preferencias personales; resumen invalidado al cambiar tarea. |
| A13 | Dos usuarios concurrentes con chat, análisis, acciones y una cuenta dada de baja. | D39, D47, D54, D64, D68 | Lecturas/escrituras ajenas rechazadas; carga de A no impide recorrido de B; datos y sesiones aislados. |
| A14 | Cambio externo, actualización manual, falta de puente, servicio caído y reporte antiguo. | D46, D60–D65 | Tiempo/semántica elegidos, último dato válido conservado y mensajes sin éxito falso. |
| A15 | Invitación vencida/usada, login/logout, sesión caducada y soporte de contraseña. | D66–D69 | Acceso propio y recuperación acordada sin recrear portafolio ni afectar otra cuenta. |
| A16 | PWA Android, reapertura, offline y cambio de cuenta; reloj si entra en alcance. | D70–D71 | Autenticación correcta; datos privados no cacheados; completar verificado. |
| A17 | Ensayo de migración del dueño y rollback en copia representativa. | D69, D72 | IDs, datos y flujo elegidos preservados; evidencia de recuperación y versiones reproducibles. |

## Revisión del aspecto

Para D02 y D55–D59 preparar capturas con el mismo fixture y estado en ambos ambientes, a ancho de escritorio y 390 x 844. La cuenta nueva y el perfil del dueño se comparan por separado.

Comprobar ubicación de botones, densidad del inspector, contraste, títulos genéricos/específicos, cuenta activa visible, engranaje, chat, campana, errores, carga y estado vacío. En móvil comprobar objetivos táctiles, scroll, solapamientos, teclado y foco de modales. Por teclado comprobar Tab, Enter, Escape, pulsación de selección y retorno del foco.

Cada cambio visible termina con evidencia antes/después y aceptación del usuario. No registrar revisión visual completa solo por inspección del HTML o por tests de cadenas.

## Regresiones comunes

Preservar: seis indicadores y sus subconjuntos; inventario, filtros y orden; ámbito de inspector y Regresar; selección de minutas original; campos de Responsable/Fecha/Dependencia; detalle y bitácora; etiquetas múltiples; impresión y texto copiable; aviso offline genérico; snapshots ordenados y comprobados después de escritura.

Al incorporar la base multiusuario, comprobar modo legado además de modo cuentas hasta que la retirada de legado sea elegida explícitamente.

## Pruebas y evidencia

Cada entrega pequeña ejecuta las pruebas relevantes. Después de cambios al Worker o contratos del puente, correr la regresión que protege las rutas afectadas. Antes del cierre de un bloque y de la equivalencia final correr npm test en ambas bases que correspondan, sin repetir suites sin motivo durante un mismo incremento.

Las suites Python actuales y JavaScript permiten una base de regresión. Los E2E de laboratorio son herramientas, no autorización para ejecutarlas sobre los datos personales existentes: primero inspeccionar rutas, provisión y cleanup. Pruebas con modelo real deben revisar contexto enviado, IDs y estado final; no aprobar por la sola presencia de una respuesta.

Guardar por entrega: comandos/resultados, fixture y ambiente, capturas, timestamps/versiones, mediciones, respuesta del usuario y limitaciones. No guardar contraseñas, tokens, cookies, links de invitación activos ni notas privadas de reuniones en Git.

## Puerta de paso a producción

- D01–D72 con destino explícito: aceptada, diferencia aceptada o diferimiento compatible con el corte.
- Hallazgos funcionales resueltos o aceptados con recorrido de recuperación probado; no queda un cambio que oculte tareas sin la política elegida.
- Casos de aislamiento y concurrencia con dos cuentas QA, además de pruebas locales.
- Verificación remota del piloto y aceptación visual del usuario.
- Granola real, dispositivos y capacidad confirmados según alcance decidido; elementos pospuestos expresamente separados.
- Ensayo sobre copia representativa, respaldo recuperable, mapeo del dueño y rollback probado.
- Worker, assets, procesos Python, Git y registro de decisiones describen la misma entrega.
- Autorización explícita de publicar el resultado concreto y ejecutar el corte.

La aprobación de un flujo no sustituye la autorización del corte. Cuando exista autorización suficiente de la entrega en la sesión, no volver a pedirla.


## A18 · Minutas manuales (E13, 14-10-2026)

Autorizado para implementar/probar localmente, sin despliegue. Evidencia en `evidencia/minutas-manuales/` y contrato en [MINUTAS_MANUALES.md](../MINUTAS_MANUALES.md).

- Generar la plantilla de la selección original, editar/copiar y conservar su texto para Granola.
- Crear minuta vacía o desde plantilla; editar título/fecha/hora; conservar el contexto; negrita, cursiva, viñetas y numeración en Markdown con vista previa.
- Guardar sin IA, recargar/recuperar, perder red y recuperar cambios locales cifrados. Bloquear sobrescritura de versiones concurrentes y permitir conservar la versión local como copia.
- Enviar dos veces/reintentar resultado incierto: una revisión/una bandeja, publicación confirmada; fallo IA visible sin cambios en Vikunja. Puente caído deja trabajo recuperable.
- Manual→analista existente→propuestas; incluso confianza alta no escribe antes de aprobar. Aprobar desde la bandeja refleja un snapshot nuevo con fuente propia. Escrituras antes de una confirmación perdida no duplican notas/creaciones.
- A/B: separación de drafts, claves, trabajos y propuestas; actor de otra pestaña rechazado; raíz/token propios; cuenta del dueño usa su inbox existente.
- Desktop/móvil revisados localmente. Pendientes: aceptación visual del usuario, IA real, PWA/dispositivo real, verificación remota QA y copia entre dispositivos.

No registrar E13 como verificado en piloto/producción ni como aceptado por el usuario hasta ejecutar esos recorridos autorizados.
