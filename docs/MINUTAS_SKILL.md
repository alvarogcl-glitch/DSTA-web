# Revisión contextual de minutas

Entrega E14, 15-10-2026. Implementación **local** en `codex/minutas-contexto-skill`, desde E13 `37c5734`, en `C:/Users/admin/Documents/DSTA-multiuser/minutas-manuales-dashboard`. No integrada ni desplegada. La rama `feature/minutas-manuales-dashboard` conserva su commit anterior; no se cambiaron servicios ni datos personales.

## Decisiones del usuario

Se aprobó preparar e implementar localmente una skill común para todos los modelos y mejorar la revisión. El usuario especificó usar título, cuerpo, fecha y demás contexto disponible; relacionar semánticamente con LT, tareas y bitácoras; priorizar actualizaciones y evitar tareas similares; identificar nuevos compromisos en LT existentes y temas que requieren ubicación o posible nueva LT.

Cada propuesta tiene Aprobar, Rechazar y Otra. Otra abre texto que complementa o modifica la propuesta, conservando lo demás. Otros cambios permite indicar asuntos omitidos y muestra los principales puntos tratados. Las decisiones de automatismos anteriores se conservan: Granola puede aplicar lo evidente de confianza alta; Manual-Dashboard siempre requiere aprobación.

## Skill y uso obligatorio

La definición está en [SKILL.md](../tools/skills/dsta-revisar-minutas/SKILL.md). Es un recurso versionado de la aplicación; no depende de instalar una skill en el perfil personal de Codex ni de que el proveedor la descubra.

`tools/minute_analysis.py` carga esas instrucciones y el contrato JSON en cada análisis. Ambas rutas, dueño/Granola y `UserMinuteInbox` (Granola/manuales/otras cuentas), usan el mismo recurso. Las instrucciones de revisión también lo incorporan. Hermes y Claude reciben el prompt construido por el sistema, conservando sus modelos/configuración actuales. Si falta o está vacío el archivo, el análisis falla antes de consultar IA o escribir tareas. Cada reporte nuevo incluye `skillVersion`, huella de las instrucciones.

El análisis recibe las descripciones y bitácoras completas de las tareas abiertas y completadas de las LT activas, además de sus descripciones. La ruta del dueño construye este contexto directamente con sus helpers de lectura; el resto usa el snapshot completo de su propia cuenta. Se retiran los recortes previos de 4000/300 caracteres y 50000 caracteres totales del analista de minutas. El cuerpo íntegro se mantiene localmente en `texto`, excluido del espejo público del Worker.

Se conservan participantes, ubicación, duración y cuerpo adicional cuando el importador los entrega; `source_date` conserva la fecha/hora original del adaptador antiguo de Granola. No se inventan metadatos ausentes. Los hashes de revisiones existentes no cambian por añadir estos campos: no hay reanálisis masivo por instalar la mejora; un cambio exclusivamente de metadatos no dispara por sí solo una revisión con estos adaptadores.

Existe un límite explícito de 500000 caracteres para el contexto de análisis: sobrepasarlo produce un error recuperable antes del modelo, conservando el reporte anterior, sin recortar ni aplicar cambios. El límite de contexto efectivo del modelo sigue dependiendo del proveedor; un rechazo no se presenta como análisis exitoso.

Para consultas Hermes extensas en Windows, `hermes_prompt_transport.py` utiliza el Python de la misma instalación y `hermes_query_stdin.py`, que llama al mismo entrypoint Hermes con las opciones originales y el texto recibido por stdin. Así el límite de línea de comandos no elimina contexto ni fuerza por sí solo el respaldo. Las opciones de aislamiento por usuario se conservan. No se configura otro proveedor ni se instala software. Claude ya recibe el prompt por stdin. Una distribución de Hermes sin el intérprete esperado produce el fallo y respaldo habituales, sin recortar el texto.

## Clasificación y duplicados

El resultado contiene `puntos_tratados`, `acciones` y `antecedentes`. Las tarjetas se agrupan en actualizaciones de tareas existentes, nuevas tareas en LT existentes y temas por ubicar/posibles nuevas LT. Cada acción conserva evidencia y fundamento para su destino.

La comparación semántica depende del modelo y se guía por la skill: propósito, entregable, nombres, vocabulario contextual y bitácoras; una palabra coincidente no basta. Hay además una barrera determinista conservadora: títulos normalizados por acentos, artículos y preposiciones, o al menos tres términos comunes con similitud de conjuntos ≥0,7, dentro de la misma LT. Esta barrera **no equivale a deduplicación semántica perfecta**.

Una creación similar a una única tarea abierta pasa a propuesta `comentar`, sin automatismo ni cambios de título/responsable/fechas/dependencias; conserva el texto de la nota para revisión. Varios candidatos o una tarea completada pasan a tema por revisar. Al ejecutar una creación se releen las tareas y se vuelve a bloquear un posible duplicado aparecido después del análisis. Las coincidencias semánticas con títulos muy diferentes deben comprobarse con IA real.

El nuevo tipo `revisar` conserva temas sin encaje claro. **Aprobar un tema registra su aceptación para revisión y no crea LT ni tareas**; la tarjeta lo explica. Para convertirlo en una tarea se usa Otra indicando una LT existente. La creación de LT desde minutas queda fuera de esta entrega.

## Decisiones y recuperación

- Aprobar envía la propuesta original, aunque se hubiera escrito antes en Otra. Rechazar no aplica cambios. Otra exige texto y usa el motor de instrucciones existente con el contexto de la reunión y su portafolio.
- Otros cambios funciona incluso si no hay propuestas iniciales. Viaja como `actionId: otros`, exclusivamente con decisión `instruccion`. El motor registra una acción propia con un ID ordinario y conserva su resultado o error.
- Un reenvío del mismo trabajo adicional reutiliza la acción; una instrucción guardada para el mismo UUID no se ejecuta otra vez. Se mantienen las marcas de idempotencia de operaciones manuales. No se introduce una garantía de transacción distribuida para la ruta Granola histórica.
- Una instrucción imposible deja un error visible, no un rechazo silencioso. El descarte exige `descartar=true` explícito en el resultado del intérprete. Se guardan los resultados de instrucciones antes de continuar al siguiente elemento.
- La UI envía el digest de la minuta; el Worker rechaza decisiones de una revisión anterior y IDs repetidos. Se admiten hasta 25 decisiones de acciones más una indicación adicional. Se mantienen aislamiento de cuentas, cola, publicación de snapshot y deshacer/descartar existentes.
- Para minutas antiguas sin `puntos_tratados` se muestran antecedentes o resumen en Otros cambios. No se reprocesan ni se alteran sus acciones guardadas.

## Evidencia local

[Resultados](convergencia/evidencia/minutas-skill/resultados.json), pruebas y capturas en `docs/convergencia/evidencia/minutas-skill/`.

- `npm test`: 211 pruebas Python y las 18 suites JavaScript aprobadas.
- Skill validada con `quick_validate.py`.
- E2E Chrome en localhost, viewports 1280×900 y 390×844: Worker/DO, dispatcher y motor Python reales; modelo y Vikunja ficticios. Comprueba la plantilla/copia/borradores anteriores, aprobación/rechazo/Otra/Otros cambios, texto oculto ignorado, una sola nota, destino correcto, publicación posterior y separación A/B.
- Pruebas específicas: instrucciones iguales en ambas rutas, contexto posterior a los antiguos recortes, participantes/importación, fallo sin skill/contexto excesivo sin perder reporte, duplicado convertido en bitácora, tema aceptado sin escritura, otros cambios sin propuesta y reenvío estable; transporte Hermes largo con Unicode y opciones de aislamiento conservadas, sin contactar un modelo.
- Capturas antes/después del mismo fixture y revisión visual de escritorio/móvil; sin overflow horizontal. El navegador usó una respuesta IA simulada: no demuestra calidad semántica real.
- Empaquetado Wrangler 4.147.0 con `--dry-run --config wrangler.staging.jsonc` correcto. No publica Worker ni assets.

## Próximo paso y entrega posterior

Revisión humana del [recorrido móvil](convergencia/evidencia/minutas-skill/review-top-mobile.png) y de [Otra/Otros cambios](convergencia/evidencia/minutas-skill/review-desktop.png). Pendiente ensayo con modelos reales de ambas rutas en QA separado, minutas sin relación/ambiguas y duplicados semánticos, así como móvil/PWA real.

La publicación requiere autorización posterior para integrar E13+E14, contrastar los cambios de main ocurridos desde `1bd8846` y coordinar Worker/assets y ambos puentes Python. Instalar también `minute_analysis.py`, `hermes_prompt_transport.py`, `hermes_query_stdin.py` y el directorio `tools/skills/dsta-revisar-minutas/`; no basta con desplegar el Worker. Respaldar inbox/borradores existentes. No hay nuevas migraciones, secretos ni proveedores. Para volver atrás, restaurar el conjunto anterior de código y assets conservando los datos; los tipos nuevos de reportes deben conservarse y revisarse al volver a una UI anterior.
