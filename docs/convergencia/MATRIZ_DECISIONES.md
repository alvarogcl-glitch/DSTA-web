# Diferencias y decisiones de DSTA

Actualización D33 (E15): el usuario eligió recordatorios por cuenta en dashboard + PWA.
Publicación autorizada el 16-10-2026 y ejecutada; prevalece la entrada E15 del registro.
La comparación inicial de la tabla se conserva como evidencia histórica.

Esta matriz cubre funciones, flujos, apariencia y operación que deben revisarse antes de considerar equivalentes los ambientes. El estado inicial de D01 a D72 es **por decidir**. Cada resultado elegido debe definir por separado el piloto, el comportamiento de producción después de la migración y cualquier cambio a producción antes de migrar.

La recomendación orienta la conversación; no autoriza una implementación. Las decisiones y su estado vigente se guardan en [REGISTRO_DECISIONES.md](REGISTRO_DECISIONES.md).

| Recomendación | Significado |
|---|---|
| R | Recuperar una capacidad o regla de producción. |
| P | Conservar una capacidad del piloto. |
| H | Combinar ambos, preservando usabilidad y separación por persona. |
| E | Elegir alcance o aceptar explícitamente una diferencia. |

El usuario puede elegir una opción distinta de la recomendación. Para cada fila se discutirán conservar producción, conservar piloto, combinar, posponer o aceptar diferencia. Si alguna opción elimina una necesidad multiusuario, debe reformularse conservando la separación de datos.

La columna de prueba define el resultado observable que se debe ampliar al acordar el alcance. Los comportamientos actuales proceden de la revisión del 13 de octubre de 2026. Aspecto visual y dispositivos requieren todavía la inspección de las pantallas actuales, además del código.

## Tareas y edición

| ID | Aspecto | Producción actual | Piloto actual | Recomendación | Decisión que falta | Prueba de aceptación |
|---|---|---|---|---|---|---|
| D01 | Crear tareas | Copiloto ejecuta creación. | Formulario directo o propuesta con Aplicar. | H | Elegir la vía principal y si se conserva la alternativa directa. | Crear desde cero con responsable, fecha y dependencia; verificar tarea y respuesta. |
| D02 | Lugar de los controles | No hay botones de estructura en el inspector. | Nueva tarea, Editar, Mover y Nueva línea visibles. | H | Controles discretos, visibles o solo copiloto. | Comparar escritorio y móvil sin saturar el inspector. |
| D03 | Ejecución del copiloto | La solicitud puede ejecutar escrituras mediante MCP. | Modelo sin herramientas; hasta cinco propuestas aplicables. | H | Ejecución autorizada, propuestas siempre o modo según acción. | Solicitud concreta termina según la modalidad elegida y nunca muestra éxito ficticio. |
| D04 | Campos de creación | Responsable, fecha, dependencia y criterio de cierre estructurados. | Formulario con título, descripción libre y fecha. | H | Conservar estructura y decidir qué campos ofrecer en pantalla. | Crear por cada vía; indicadores e inspector muestran los mismos campos. |
| D05 | Representación de fecha | Creación por MCP escribe Fecha objetivo en descripción; edición admite due_date. | Formularios guardan due_date nativo; lectura prioriza fecha nativa. | H | Definir fecha canónica y compatibilidad con descripción histórica. | Crear, cambiar, quitar fecha y cruzar medianoche de Santiago sin fechas contradictorias. |
| D06 | Editar descripción y conservar antecedentes | Edición por copiloto puede modificar el texto; no implica protección absoluta de toda descripción. | Formulario sustituye el texto completo; propuesta puede hacerlo con contexto truncado. | H | Edición completa con revisión, campos separados o cambios parciales. | Cambiar un campo preserva bitácora y metadatos salvo eliminación explícita elegida. |
| D07 | Origen y trazabilidad | Creación MCP incluye SOURCE y ACTION_KEY. | Creación directa no agrega automáticamente esos campos; minutas sí usan el motor estructurado. | R | Igualar trazabilidad en todas las vías o justificar diferencias. | Toda tarea creada permite identificar origen y solicitud sin exponer metadatos en la UI. |
| D08 | Título y edición básica | Cambio de título mediante copiloto. | Formulario y propuesta aplicable. | H | Conservar ambos flujos o privilegiar chat. | Renombrar conserva el ID, asociaciones y campos ajenos al cambio. |
| D09 | Responsable | Se maneja en descripción estructurada. | No hay campo separado ni acción específica. | H | Agregar campo explícito, permitir texto estructurado o ambos. | Una persona responsable aparece en inspector, búsqueda e indicadores. |
| D10 | Dependencia | Herramienta pmo_set_dependency conserva el resto. | Se modifica la descripción completa. | H | Agregar cambio específico y decidir su acceso visual. | Cambiar dependencia no altera descripción restante ni registros. |
| D11 | Criterio de cierre | Disponible por descripción estructurada y copiloto. | Sin campo dedicado en formulario/propuestas. | H | Agregar campo o conservar edición textual guiada. | Criterio coherente en tarea, contexto IA y minuta. |
| D12 | Mover tareas | Copiloto mueve entre líneas activas. | Botón directo o propuesta. | H | Movimiento directo discreto y/o chat ejecutable. | Mover conserva título, fechas, etiquetas, responsables y bitácora. |
| D13 | Completar tareas | Botón sin IA y copiloto ejecutable. | Botón sin IA o propuesta del chat. | H | Mantener botón; decidir ejecución por chat. | Éxito solo después de lectura y snapshot que prueban done=true. |
| D14 | Reabrir tareas | pmo_update_task admite done=false. | Sin acción normal; deshacer minutas puede restaurar estado. | R | Agregar reapertura y definir ubicación/confirmación. | Reabrir una tarea normal y verificar que vuelva a pendientes. |
| D15 | Prioridad nativa | pmo_update_task permite prioridad. | Formularios y propuestas no incluyen prioridad. | E | Exponerla, dejarla solo en chat o declarar que queda fuera. | Si se incluye, prioridad nativa persiste sin confundirse con etiquetas. |
| D16 | Comentarios nativos | Copiloto dispone de pmo_add_comment. | Sin acción expuesta equivalente. | E | Conservar comentarios, usar solo bitácora o ambos. | Distinguir comentario de registro y comprobar dónde queda guardado. |
| D17 | Agregar registro | Formulario llama al copiloto y pmo_append_log. | Formulario usa task.log determinista sin IA. | P | Conservar mejora sin IA y considerar llevarla a producción. | Guardar texto literal y tipo/fecha, sin cambiar estado ni necesitar modelo. |
| D18 | Registro y reintentos | Ruta por IA verifica escritura; no se presume deduplicación completa. | Reejecutar task.log agrega dos veces en simulación. | H | Definir ejecución única por solicitud y recuperación. | Forzar pérdida de confirmación y repetir entrega; un solo registro. |
| D19 | Detección del modo al guardar registro | Modo único Basic. | Detección asíncrona de /api/session; antes de responder puede conservar vía de chat. | H | Resolver modo antes de guardar y definir fallo visible. | Guardar con consulta de sesión lenta o fallida nunca usa la vía incorrecta. |
| D20 | Borrado general de tareas | No expuesto; deshacer creación por minuta puede borrar esa tarea. | Tampoco expuesto; conserva reversión por minuta. | E | Mantener alcance actual o diseñar función aparte. | No confundir archivar, completar y borrar; probar reversión limitada a su origen. |

## Líneas de trabajo

| ID | Aspecto | Producción actual | Piloto actual | Recomendación | Decisión que falta | Prueba de aceptación |
|---|---|---|---|---|---|---|
| D21 | Crear líneas | Copiloto crea bajo la raíz PMO-DSTA. | Botón y propuesta crean bajo raíz del usuario. | H | Chat principal y acceso directo opcional. | Nueva línea queda bajo raíz correcta y visible sin perder el contexto. |
| D22 | Renombrar líneas | Copiloto renombra con validación de unicidad. | Formulario/propuesta renombra directamente. | H | Conservar accesos y aplicar reglas comunes. | Renombrar conserva ID, contenido y preferencias relacionadas. |
| D23 | Descripción de línea | Copiloto puede crearla y editarla. | No expuesta en formularios/propuestas actuales. | R | Recuperar función y elegir ubicación. | Descripción editable sin alterar tareas o configuración de la línea. |
| D24 | Nombres y códigos duplicados | Valida nombres y códigos LT/TR. | Ruta directa no aplica misma validación. | R | Regla común o diferencia expresamente aceptada. | Crear y renombrar a nombre/código ocupado produce resultado decidido sin ambigüedad. |
| D25 | Archivar líneas con contenido | Solo vacías y sin subproyectos. | Puede archivar con tareas; se ocultan del snapshot, no se borran. | R | Igualar restricción o diseñar archivo con revisión y restauración. | Línea con abiertas, completadas o subproyectos no desaparece por una acción imprevista. |
| D26 | Fusionar líneas | Mueve tareas y archiva origen vacío. | No hay operación equivalente. | R | Recuperar fusión o aceptar movimientos individuales. | Verificar todos los traslados, preservar IDs y mostrar fallos parciales. |
| D27 | Restaurar líneas archivadas | Copiloto dispone de restauración. | Sin acción expuesta equivalente. | R | Recuperar restauración y decidir cómo encontrar líneas. | Restaurar mantiene IDs y vuelve a mostrar tareas y etiquetas. |

## Copiloto y contexto

| ID | Aspecto | Producción actual | Piloto actual | Recomendación | Decisión que falta | Prueba de aceptación |
|---|---|---|---|---|---|---|
| D28 | Consultar datos completos | MCP consulta Vikunja. | Contexto prefabricado; descripción hasta 400 caracteres, contexto 30000. | H | Consultas acotadas al usuario, ampliar contexto o aceptar límite visible. | Pregunta sobre un dato al final de una descripción extensa responde con evidencia correcta. |
| D29 | Tareas creadas hoy o ayer | pmo_tasks_created, paginación y fecha America/Santiago. | Sin herramienta ni fecha created en snapshot. | R | Recuperar consulta exacta y política temporal. | Verificar abiertas/completadas, límites de día y páginas posteriores. |
| D30 | Etiquetas desde chat | Consulta y escritura con herramientas nativas. | No hay propuestas de etiquetas ni catálogo equivalente en prompt. | R | Recuperar consulta y edición por chat según D03. | Buscar por etiqueta, asignar/quitar y preservar otras clasificaciones. |
| D31 | Buscar reuniones anteriores | MCP busca y lee minutas disponibles en carpetas. | Prompt incluye 15 minutas recientes con resúmenes de hasta 600 caracteres. | H | Búsqueda propia por usuario o alcance reducido comunicado. | Encontrar acuerdo fuera de las últimas 15 reuniones sin leer otro usuario. |
| D32 | Abrir minuta citada | Respuesta adjunta contenido de minutas citadas para visor. | answer_chat no adjunta mecanismo de contenido completo equivalente. | R | Restaurar visor y enlaces o elegir otra navegación. | Abrir cita muestra minuta correcta y permite volver al chat. |
| D33 | Recordatorios | Hermes expone cronjob; respaldo Claude actual no tiene esa herramienta. | Agente aislado sin cronjob. | E | Diseñar recordatorios por usuario, mantener alcance parcial o excluirlos. | Recordatorio pertenece al dueño y tiene alta, consulta y cancelación si se incluye. |
| D34 | Memoria y conversación | Historial en pestaña y entorno personal Hermes con herramientas configuradas. | Historial en pestaña; sin memoria/configuración personal del CEO; purga de sesiones. | H | Conservar aislamiento; decidir persistencia personal futura. | Nueva sesión limpia contexto de chat y otra cuenta no recibe conversaciones previas. |
| D35 | Modelo principal y respaldo | Hermes y Claude; cooldown de reintento de Codex de 10 minutos. | Hermes aislado y Claude sin herramientas; secuencia por consulta. | H | Igualar mensajes, disponibilidad y política de reintentos. | Forzar fallo de principal; respuesta de respaldo identificada, sin duplicar cambios. |
| D36 | IA propia por usuario | Sin ajuste individual en dashboard. | Perfil llm previsto; solo ceo-hermes operativo. | E | Posponer o diseñar proveedores propios; no presentar como disponible. | Proveedor no soportado produce explicación clara y no usa credenciales por sorpresa. |
| D37 | Propuestas en lote | Agente puede encadenar operaciones. | Hasta cinco propuestas por respuesta; Aplicar individual. | H | Límite, orden, revisión y eventual aplicar conjunto. | Crear línea y tarea dependiente se ejecuta en orden válido con IDs comprobados. |

## Etiquetas y clasificación

| ID | Aspecto | Producción actual | Piloto actual | Recomendación | Decisión que falta | Prueba de aceptación |
|---|---|---|---|---|---|---|
| D38 | Controles directos de etiquetas | Editor directo, filtros y portafolio transversal sin IA. | Misma base con credencial individual. | H | Conservar UI y revisar si cambios nuevos se llevan a ambos. | Crear, colorear, renombrar, asignar, quitar y eliminar sin afectar otras etiquetas. |
| D39 | Catálogo y portafolio por cuenta | Catálogo del espacio productivo. | Catálogo accesible a la cuenta Vikunja propia. | P | Mantener separación; decidir catálogo inicial y etiquetas sugeridas. | A no ve ni puede modificar catálogo/asignaciones privadas de B. |

## Minutas y Granola

| ID | Aspecto | Producción actual | Piloto actual | Recomendación | Decisión que falta | Prueba de aceptación |
|---|---|---|---|---|---|---|
| D40 | Conectar Granola | Conexión administrada en VM/Hermes. | OAuth propio desde configuración, desconexión y refresh implementados. | P | Conservar conexión propia y decidir experiencia del dueño existente. | Conectar, renovar, desconectar y reconectar sin mezclar usuarios. |
| D41 | Alcance e histórico de importación | Exportador y carpetas/cola del entorno PMO-DSTA. | Importación por usuario de últimos 30 días, máximo 500 IDs por consulta. | H | Ventana, carga inicial y archivo histórico. | Importación incluye período elegido sin duplicar versiones ni perder descartes. |
| D42 | Contexto para reconciliar reuniones | Analista con MCP de consulta. | Analista sin herramientas; títulos, responsables, fechas de abiertas más minuta/notas. | H | Consultas aisladas completas o contexto preparado ampliado. | Reunión que depende de bitácora, dependencia o tarea completada genera propuesta correcta. |
| D43 | Acciones automáticas de minutas | Evidente y confianza alta; no mover automáticamente. | Mismas reglas del motor; implementadas, sin acciones auto en muestra revisada. | H | Mantener automatismo, pedir aprobación siempre o configuración por persona. | Ejemplos evidentes/ambiguos, negativos y cambios fuera de alcance dan conducta elegida. |
| D44 | Revisión e instrucciones de propuestas | Aprobar, editar, rechazar e instrucciones. | Conserva flujo; instrucción imposible queda visible como error explicativo. | P | Conservar mejora y decidir aplicarla también a producción. | Instrucción imposible no desaparece; corregirla permite completar la revisión. |
| D45 | Deshacer y descartar minutas | Deshacer cambio concreto y descartar minuta. | Mismo motor por usuario; descarte no revierte automáticamente cambios ya aplicados. | H | Conservar semántica o aclararla en mensajes. | Deshacer restaura solo cambios propios; descartar no se presenta como reversión total. |
| D46 | Publicación después de minutas | Publica snapshot tras decisiones y ciclo de análisis. | Actualiza bandeja; rutas de análisis/decisión no publican tareas inmediatamente. | R | Actualizar ambos estados inmediatamente o comunicar espera elegida. | Aprobación, aplicación auto y deshacer se reflejan sin contradicción entre bandeja y tarea. |
| D47 | Archivos y datos privados de reuniones | Archivos PMO y reportes en entorno de producción. | Bandeja por usuario; notas completas procesadas en VM y por IA, no publicadas al navegador. | P | Conservar separación; decidir archivo y acceso a resumen completo. | Revisar payloads, almacenamiento y contexto del modelo por cuenta; sin notas privadas en UI por accidente. |

## Secciones y resúmenes

| ID | Aspecto | Producción actual | Piloto actual | Recomendación | Decisión que falta | Prueba de aceptación |
|---|---|---|---|---|---|---|
| D48 | Cata 1-1 inicial | Sección fija con coincidencia Cata/Catalina. | No incluida en layout inicial de usuario nuevo. | H | Perfil inicial del dueño con Cata y perfiles genéricos, o sección configurable equivalente. | La selección de Cata coincide con producción cuando ese perfil se activa. |
| D49 | Orden y visibilidad de secciones | Layout fijo. | Ordenar, renombrar y ocultar por usuario. | P | Conservar y decidir si se incorpora a producción con sus valores actuales. | Guardar/reabrir en otro dispositivo; ocultar no borra tareas ni confunde nombre con contenido. |
| D50 | Secciones personalizadas | No disponibles. | Filtros por palabras, campos, responsable, dependencia, líneas, etiquetas y estado. | P | Conservar innovación y definir acceso/editor. | Casos OR de palabras, coincidencia parcial/sin acentos y combinación de filtros. |
| D51 | Selección en secciones personalizadas | Pulsación larga y selección en paneles originales. | Paneles originales iguales; secciones personalizadas sin selección equivalente. | H | Replicar selección o mantener generación de todos con indicación. | Generar minuta contiene exactamente la selección o alcance anunciado. |
| D52 | Resúmenes IA por sección | Principalmente Cata; caché invalidada al cambiar tarea. | Opcionales en secciones propias; se recogen en ciclo periódico y comparten pool de análisis. | H | Conservar y definir activación, frecuencia, pendientes y prioridades. | Resumen corresponde a versión actual; cambios invalidan el viejo y error no bloquea acciones. |
| D53 | Formato de minutas generadas | Plantillas de portafolio, fechas, Cata e inspector con datos vivos. | Las originales se conservan; sección nueva produce títulos y resumen IA opcional más simples. | H | Plantilla común, variantes por sección o formato configurable. | Comparar texto con responsable, fecha, dependencia, orden y selección. |
| D54 | Persistencia de preferencias | Sin preferencias de layout de usuario. | Preferencias guardadas en el espacio propio. | P | Separar preferencias personales de valores compartidos. | Nueva sesión y otro dispositivo recuperan el perfil correcto sin heredar el de otro. |

## Apariencia y navegación

| ID | Aspecto | Producción actual | Piloto actual | Recomendación | Decisión que falta | Prueba de aceptación |
|---|---|---|---|---|---|---|
| D55 | Identidad visual y textos | PMO-DSTA, Cata y términos específicos del dueño. | Base compartida; algunas ayudas genéricas; encabezado aún menciona PMO-DSTA. | H | Base visual común con nombre/títulos por persona y perfil del dueño. | Comparar mismos datos en escritorio y 390x844; no referencias ajenas en cuenta nueva. |
| D56 | Configuración y cuenta | Sin engranaje/cuenta personal en versión actual. | Engranaje para cuenta, Granola y secciones. | H | Conservar discreto y definir qué se muestra en producción futura. | Acceder/cerrar por teclado y móvil sin tapar inspector o chat. |
| D57 | Diálogos de creación y edición | La interacción de estructura ocurre en chat. | Nuevos modales con campos y estado. | H | Adoptar, simplificar o mover controles; validar foco y cancelación. | Foco inicial, Escape, Cancelar, errores, doble clic y tamaños táctiles. |
| D58 | Feedback y resultado incierto | Avisos de completar/registro con recuperación y revisar tarea. | Esos avisos heredados; formularios/propuestas tienen seguimiento propio y límites. | H | Unificar mensajes y revisión sin reenviar cambios. | Corte de red durante envío y confirmación conserva identidad de la solicitud y no duplica. |
| D59 | Primer acceso y espacio vacío | Portafolio existente ya poblado. | Cuenta nueva puede no tener líneas, tareas o Granola. | H | Ayuda inicial y sugerencias discretas sin crear datos automáticos no elegidos. | Una persona entiende cómo comenzar y no ve éxito/errores confusos por snapshot ausente. |

## Sincronización y operación

| ID | Aspecto | Producción actual | Piloto actual | Recomendación | Decisión que falta | Prueba de aceptación |
|---|---|---|---|---|---|---|
| D60 | Actualización externa | Publicador lee Vikunja cada 30 segundos. | Puente publica cada 300 segundos; navegador refresca cada 30. | H | Elegir frecuencia común, por actividad o por ambiente; texto coherente. | Cambio externo llega dentro del tiempo elegido; medir fresco/obsoleto por cuenta. |
| D61 | Actualizar ahora | Lee snapshot y comprueba salud; no fuerza lectura directa de Vikunja. | Misma limitación, más visible con publicación cada cinco minutos. | H | Mantener semántica o solicitar actualización real del usuario. | Editar externamente y pulsar botón cumple el significado del texto. |
| D62 | Recuperación de formularios y propuestas | Completar/registro conservan solicitud pendiente. | Nuevos controles no conservan UUID/consulta como los heredados. | R | Extender recuperación a todos los cambios. | Recargar después de aceptación, antes de confirmación y con POST incierto; una escritura. |
| D63 | Salud por usuario | Vikunja/Granola del entorno del dueño. | Reporta root propia y estado ready de Granola; ready no acredita por sí solo token válido ahora. | H | Medición comparable y mensajes propios por cuenta. | Token vencido, servicio caído y reporte antiguo se distinguen sin revelar datos ajenos. |
| D64 | Colas y tiempos de respuesta | Canales independientes de acciones/etiquetas; sondeos 8s; chat general 12s. | Despacho 10s; dos chats, un pool análisis y otro de decisiones. | H | Prioridades, equidad entre cuentas y límite de espera. | A con cola de minutas no bloquea completar de B; medir percentiles antes de pactar objetivo. |
| D65 | Capacidad y coste | Mismo proveedor Cloudflare y cuota de cuenta compartida. | Staging añade consumo aunque Worker y datos sean distintos. | E | Medir carga total y elegir frecuencia/plan con información vigente al decidir. | Carga representativa y fallos por cuota visibles; validar plan sin asumir precios. |

## Acceso y dispositivos

| ID | Aspecto | Producción actual | Piloto actual | Recomendación | Decisión que falta | Prueba de aceptación |
|---|---|---|---|---|---|---|
| D66 | Invitación, login y logout | Acceso Basic. | Invitación de un uso, contraseña propia, cookie revocable y logout. | P | Conservar necesidad multiusuario y decidir paso del dueño a su cuenta. | Alta, vencimiento, uso repetido, sesión caducada y logout no alteran otras cuentas. |
| D67 | Cambio y recuperación de contraseña | Sin autoservicio propio. | Sin flujo de cambio/recuperación expuesto. | E | Diseñar operación admin inicial o autoservicio posterior. | Método elegido revoca lo necesario y no expone contraseña ni requiere recrear portafolio. |
| D68 | Aislamiento y puente | Espacio del dueño único. | Raíz, token y almacenamiento por usuario; token de puente compartido. | P | Mantener aislamiento; decidir endurecimiento del puente antes de escalar. | Dos usuarios: lecturas, escrituras, chat, etiquetas, minutas, preferencias y baja cruzadas rechazadas. |
| D69 | Experiencia del dueño al migrar | Portafolio, MCP, reuniones y flujo actual del dueño. | Cuenta alvaro usa raíz 403 del laboratorio, no el portafolio productivo. | H | Perfil del dueño conserva datos y capacidades aprobadas; otros tienen sus espacios. | Ensayar copia representativa; dueño ve mismos IDs y datos sin adoptar el laboratorio por error. |
| D70 | PWA e impresión | Instalación, aviso offline genérico e imprimir/PDF. | Misma base; autenticación pasa a cookie de cuenta. | H | Conservar y validar sesiones al instalar/reabrir. | Chrome Android: instalar, reabrir, logout, offline y cambio de cuenta sin datos cacheados. |
| D71 | Pixel Watch | APK preparado para Basic; validación física pendiente. | No adaptado a autenticación de cuentas. | E | Adaptar vinculación/autenticación o posponer manteniendo acceso actual hasta migración. | Reloj prueba lectura y completación con cuenta correcta sin credenciales embebidas. |
| D72 | Base de código y diagnóstico | main 40128b6 incluye corrección de tareas creadas. | feat/multiusuario f721cb4 diverge y no incluye esa capacidad. | H | Converger por cambios elegidos, con mensajes/logs coherentes y release reproducible. | Comparar Git, Worker, assets y Python activos; incorporar regresiones de main sin perder aislamiento. |

## Elementos comunes que también se comprobarán

No requieren una elección para inventar diferencias. Se someten a regresión con el comportamiento final acordado: seis indicadores; inventario y ordenamiento; filtros existentes; inspector y navegación; fechas próximas y vencidas; selección de paneles originales; generación/edición/copia de minutas originales; etiquetas directas; completar sin IA; avisos y borradores heredados; snapshots ordenados; caché offline genérica; impresión. Si la inspección descubre otra diferencia, añadir D73 y siguientes sin renumerar filas existentes.
