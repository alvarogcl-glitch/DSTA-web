# Decisiones y entregas de DSTA

Este archivo es la fuente del estado vigente de las decisiones D01–D72. La comparación y recomendaciones están en [MATRIZ_DECISIONES.md](MATRIZ_DECISIONES.md); el orden, en [PLAN.md](PLAN.md).

## Estado al iniciar

- Todas las decisiones D01–D72: **por decidir**.
- B01: **en revisión**, sin implementación iniciada.
- D01: el usuario respondió que necesita más antecedentes antes de decidir. Estado: por decidir, en explicación. Leer [REVISION_CREACION.md](REVISION_CREACION.md); ninguna opción fue elegida. No repetir la pregunta sin presentar los recorridos y separar acceso principal de ejecución de IA.
- Las instrucciones generales de conservar comodidad, aislamiento y continuidad están confirmadas por la solicitud del usuario; no son una elección de cada función.
- No se aprobaron cambios a producción ni un corte.

## Decisiones registradas

Añadir una entrada cuando exista respuesta. Las decisiones no enumeradas aquí permanecen por decidir. La entrada más reciente que declara sustituir otra determina el estado; conservar la anterior para trazabilidad.

| ID | Estado | Decisión del usuario | Piloto deseado | Producción futura deseada | Cambio a producción antes del corte | Evidencia y entrega |
|---|---|---|---|---|---|---|
| — | — | Sin decisiones funcionales cerradas al iniciar. | — | — | Ninguno autorizado por este plan. | — |
| D56 | decidido · verificado piloto | Telegram 13-10 17:55: «implementa la ruedita de configuración del piloto en el dashboard dsta en producción… replica esto también en el piloto». | Engranaje ⚙ junto a 🔔/Actualizar/Instalar con Cuenta, Conexión de minutas y Secciones. | Mismo engranaje (sin «Cuenta» en modo Basic; Granola solo como estado). | **Pendiente OK explícito del CEO para desplegar.** Preparado y probado en modo legado local (10/10); no desplegado. | Commits f8efe17, c61caa0, ec6c028. Staging 85d7111e+. |
| D49 · D50 · D54 | decidido · verificado piloto | Mismo mensaje: secciones por defecto (portafolio por LT, fechas próximas, etiquetas, inventario), activar/desactivar, ordenar arrastrando, agregar secciones por palabras clave, dependencias o responsables, nombre editable; «al guardar, se genera el layout». 18:56: «funcionó» (filtro tras corrección). | Layout por usuario guardado en su cajón; filtros combinables con vista previa; marcar todas las LT/etiquetas = todas. | Igual; el dueño conserva sus 5 secciones actuales por defecto. | Igual que D56 (pendiente OK). | test_layout_worker.mjs; E2E navegador legado 10/10 y cuentas 4/4. Coincidencia parcial sin acentos por pedido («no reconoce el filtro»). |
| D52 | decidido · implementado piloto | Telegram 13-10 17:55: «agregar en las secciones customizables la posibilidad de mostrar resúmenes con IA (como es el caso de Cata 1-1)». | Casilla de resumen IA por sección; regeneración solo cuando cambia la tarea. | Igual. | Igual que D56. | DO.summaryTasks + multiuser_bridge.summarize. Resumen real en piloto aún no observado por el usuario. |
| D48 · D55 (parcial) | decidido · verificado piloto | Telegram 13-10 18:25: «sale por defecto la sección de Cata… es un nombre específico de mi dashboard, no debe ir»; 15:36 sobre «Nelson» en ejemplos. | Usuarios nuevos sin Cata; textos genéricos sin nombres del portafolio del dueño. | Perfil del dueño conserva Cata 1-1 tal como hoy (propuesta del agente, sin objeción del CEO; confirmar en B08). | Ninguno. | Commits 6802658, c61caa0. |
| D40 | aceptado usuario (piloto) | 13-10 15:01: «estoy conectado a granola». | Conexión propia por OAuth desde configuración. | Por decidir para el dueño (hoy administrado en VM). | Ninguno. | Adaptador formato real Granola f253e26; 30 minutas importadas. |
| D43 · D44 | decidido · verificado piloto | 13-10 15:21: «implementalo igual que como está el dashboard DSTA» (sugerencias desde minutas); 15:52: instrucción imposible desaparecía, «corrige esto». | Mismo motor y reglas que producción; acciones solo sobre tareas/líneas propias; instrucción imposible queda visible con motivo; decisiones en cola propia. | Igual; la mejora de instrucción imposible se propone también para producción (no autorizada aún). | Ninguno. | Commits 22d5d88, 3525a95, cdec3fd, f338dd5. Minutas ordenadas por fecha de reunión (pedido 15:14). |
| D17 | decidido (piloto) · método por confirmar | 13-10 19:00: «intenté hacer un nuevo registro pero no se guardó». | Registro determinista (task.log) con formato de pmo_append_log; el agente eligió el método porque el copiloto del piloto no tiene herramientas. | Por decidir (producción usa copiloto + pmo_append_log). | Ninguno. | Commit f721cb4. Defectos D18/D19 en corrección (Entrega E01). |
| D60 · D64 · D65 | decidido · verificado producción | 13-10 10:06: «Baja la cantidad de pruebas y request para no consumir todo el tier gratuito de cloudfare». | Despacho 10 s, publicación 300 s, pruebas locales. | Puente productivo 8 s (acciones/etiquetas) y 12 s (bucle). | **Aplicado en producción** por pedido explícito: commit local 069ebf6 en main, tarea DSTA Hermes Bridge reiniciada; medido ~1.700 req/h (~40.700/día) vs ~4.750/h antes. | Analytics Cloudflare 13-10. Plan de la cuenta: gratuito (confirmado por el CEO). |
| D01 | decidido | Telegram 13-10 21:29: «Quiero un mix, A + B» (A: copiloto crea como producción; B: formulario directo). | Copiloto como vía principal para crear tareas + formulario «Nueva tarea» como alternativa. | Igual (producción ya usa A; B se agregaría). | Ninguno. | Pendiente: D03 (si el copiloto ejecuta sin clic, como A, o propone), D04/D07 (mismos campos en ambas vías), D02 (ubicación). |
| D03 | decidido | Telegram 13-10 21:46: «Ok» a la propuesta: crear directo cuando el pedido es explícito («crea…»); «Aplicar» solo para lo que la IA deduce sola. | Copiloto sin herramientas: sus propuestas explícitas se aplican automáticamente por la cola verificada; las deducidas quedan con Aplicar. | Producción ejecuta por MCP (sin cambio). | Ninguno. | Entrega E02. |
| D04 · D07 | decidido | Mismo «Ok»: ambas vías guardan lo mismo; formulario con responsable, fecha objetivo, dependencia y criterio de cierre, más origen. | Formulario y propuestas escriben la descripción estructurada de pmo_create_task (Responsable/Fecha objetivo/Dependencia/Criterio de cierre/SOURCE/ACTION_KEY). | Igual que producción. | Ninguno. | Entrega E02. |
| D69 (parcial) | decidido | 13-10 10:06: «los usuarios pilotos serán yo y Paula». | — | Pilotos del corte: Álvaro y Paula. | Ninguno. | — |
| D02 | decidido | Telegram 13-10 22:05: «D02: A». | Controles discretos en el inspector: una acción principal visible («Editar» o «+ Nueva tarea») y el resto en un menú «⋯», igual en escritorio y móvil. No se pusieron botones en las tarjetas de LT porque la pulsación larga ya las selecciona para la minuta. | Por decidir (producción no tiene estos controles). | Ninguno. | Entrega E03. |
| D05 | decidido | Telegram 13-10 22:06: «Ok», tras pedir más información (ejemplo del 20-10 → 30-10). | La fecha nativa de Vikunja (due_date) manda. La línea «Fecha objetivo» se reescribe con ella en cada cambio, y al quitar la fecha queda «Por confirmar». Las tareas antiguas que solo tienen la línea se siguen leyendo. Se guarda a las 12:00 UTC, así que es el mismo día en Santiago. | Igual al converger. | Ninguno. | Entrega E03. |
| D08 · D09 · D10 · D11 · D12 | decidido (cubiertos) | Telegram 13-10 22:27: «Ok» a marcarlos resueltos por E02/E03. | Título, responsable, dependencia y criterio de cierre tienen campo propio en el formulario y en el copiloto (que ejecuta si el pedido es explícito). Mover está en el menú «⋯» y en el copiloto. Cada cambio conserva ID, etiquetas, fechas y bitácora (pruebas de E02/E03). | Igual al converger. | Ninguno. | Entregas E02 y E03. |
| D13 | decidido (sin cambios) | Telegram 13-10 22:35: «Si» a la propuesta D13–D16. | Botón ✓ sin IA, y el copiloto completa cuando el pedido es explícito (D03). | Igual. | Ninguno. | Ya cubierto por E02. |
| D14 | decidido | Mismo «Si». | «Reabrir tarea» en el menú «⋯» de las tareas completadas, sin confirmación porque es reversible; el copiloto reabre cuando el pedido es explícito. Solo cambia done; los demás campos se conservan. | Igual al converger (hoy, solo copiloto vía pmo_update_task). | Ninguno. | Entrega E04. |
| D15 | decidido (fuera de alcance) | Mismo «Si». Evidencia: 0 de 164 tareas de producción usan prioridad (lectura 13-10). | Prioridad no se expone. | Igual. | Ninguno. | Reabrir si el CEO la empieza a usar. |
| D16 | decidido | Mismo «Si». Evidencia: 4 de 164 tareas tienen comentarios; el dashboard no los muestra. | Solo bitácora (task.log). El copiloto del piloto no tiene comentarios. | Al converger, el copiloto de producción deja de usar pmo_add_comment y registra en la bitácora. Requiere autorización de despliegue a producción. Los comentarios existentes se conservan en Vikunja. | Ninguno. | Pendiente para el corte a producción. |
| D20 | decidido (fuera de alcance) | Telegram 13-10 22:56: «Si ok con todo». | No se expone borrar tareas; basta con archivar y completar. Se conserva la reversión limitada de las minutas. | Igual. | Ninguno. | — |
| D21 · D22 | decidido (cubiertos) | Mismo «Si ok con todo». | Crear y renombrar líneas por copiloto y por botón, con la regla D24. | Igual al converger. | Ninguno. | E02 a E05. |
| D23 | decidido | Mismo. | «Editar descripción» en el menú «⋯» de la LT; el copiloto también puede (`lt.describe`). La descripción se ve en el inspector y la recibe el copiloto como contexto. | Igual al converger. | Ninguno. | Entrega E05. |
| D24 | decidido | Mismo. | No puede haber dos líneas activas con el mismo nombre (sin distinguir mayúsculas, tildes ni espacios). Lo validan el Worker (409), el puente (contra Vikunja, antes de escribir) y el copiloto. Renombrar una línea a su propio nombre con otras mayúsculas está permitido. | Producción además valida códigos LT/TR; se revisará al converger. | Ninguno. | Entrega E05. |
| D25 | decidido | Mismo. | Solo se archiva una línea sin tareas abiertas. Las completadas se archivan con ella y no se borran. El mensaje indica cuántas quedan abiertas. | Producción exige línea vacía; al converger rige la regla del piloto. | Ninguno. | Entrega E05. |
| D26 | decidido | Telegram 13-10 23:12: «D26: dejarlo igual que como es en producción». | Igual que producción: solo por copiloto (`lt.merge`). Mueve todas las tareas, abiertas y completadas, conservando sus campos, y luego archiva el origen vacío. Rechaza si el origen tiene subproyectos. Si falla a mitad, informa cuántas movió y deja el origen activo. Un reintento devuelve el mismo resultado. | Igual. | Ninguno. | Entrega E06. |
| D27 | decidido | Mismo mensaje: «Resto ok». | ⚙ Configuración › «Líneas archivadas» con «Restaurar», y el copiloto (`lt.restore`). Conserva el ID. Se rechaza si una línea activa ya tiene ese nombre (D24). | Igual al converger. | Ninguno. | Entrega E06. |
| D28 | decidido | Mismo. | Copiloto: descripciones completas de las tareas abiertas (hasta 4.000 caracteres cada una) y resumen de las completadas (300). Límite total de 60.000 caracteres. Si algo no cabe, se le avisa al modelo que lo diga en vez de suponer. | Igual al converger. | Ninguno. | Entrega E06. |
| D29 | decidido | Mismo. | El snapshot incluye `created`. El copiloto ve «creada AAAA-MM-DD» en hora de Chile y la fecha de hoy en Chile. | Igual al converger. | Ninguno. | Entrega E06. |
| D30 | decidido | Mismo. | El copiloto conoce el catálogo de etiquetas y las de cada tarea, y propone `label.assign`/`label.unassign` sobre etiquetas existentes. Regla D03: lo pedido se ejecuta por la cola de etiquetas verificada; lo sugerido queda con «Aplicar». Las demás etiquetas no se tocan. | Igual al converger. | Ninguno. | Entrega E06. |
| D31 | decidido | Telegram 13-10 23:26: «Ok a todo menos d37». | La sincronización con Granola mantiene en el vault de cada usuario un archivo de hasta 300 minutas (4.000 caracteres cada una), que sobrevive a la ventana de 30 días. El copiloto recibe las 15 recientes más hasta 5 anteriores que coinciden con la pregunta (palabras, sin tildes). Nunca minutas de otro usuario. | Equivalente al converger. | Ninguno. | Entrega E07. |
| D32 | decidido | Mismo. | El copiloto cita como [título](minuta:id); el puente adjunta el texto de las minutas citadas del usuario y el chat las abre en el visor existente. | Igual. | Ninguno. | Entrega E07. |
| D33 | decidido (fuera de alcance) | Mismo. | Sin recordatorios en el piloto. | Producción mantiene los de Hermes. | Ninguno. | Reabrir si hay demanda. |
| D34 | decidido (sin cambios) | Mismo. | Conversación solo en la pestaña, sin memoria entre usuarios y con sesiones purgadas. | Igual. | Ninguno. | — |
| D35 | decidido | Mismo. | Si Hermes falla, el copiloto usa Claude directo durante 10 minutos, como producción; las respuestas de respaldo van marcadas. | Igual. | Ninguno. | Entrega E07. |
| D36 | decidido (pospuesto) | Mismo. | Solo el perfil ceo-hermes. Cualquier otro proveedor muestra un mensaje claro y no usa credenciales. | Igual. | Ninguno. | — |
| D37 | decidido | Telegram 13-10 23:27: «Ok», tras el ejemplo. | Máximo 5 cambios por respuesta, en el orden propuesto. Lo pedido explícitamente se ejecuta solo. Las sugerencias tienen «Aplicar todas», que aplica en orden y se detiene en el primer fallo. Lo que depende de algo recién creado se hace en dos mensajes. | Igual al converger. | Ninguno. | Entrega E07. |
| D38 | decidido (sin cambios) | Telegram 14-10 00:08: «Si» a D38/D39/D41/D42. | Botones directos de etiquetas iguales en ambos ambientes; cualquier mejora futura va a los dos. | Igual. | Ninguno. | — |
| D39 | decidido | Mismo. | Catálogo propio por usuario. Un usuario nuevo parte sin etiquetas y sin lista sugerida. | Igual. | Ninguno. | — |
| D41 | decidido | Mismo. | La primera sincronización trae 90 días (rango `custom` de Granola; el plan gratuito entrega solo lo que guarda). Lo anterior a 30 días va solo al archivo de búsqueda (D31), no a la bandeja ni al análisis por IA. Después rige la ventana normal de 30 días. | Equivalente al converger. | Ninguno. | Entrega E08. |
| D42 | decidido | Mismo «Si», tras el ejemplo del contrato con Legal y Finanzas. | El analista de minutas recibe el mismo contexto que el copiloto: descripción completa de las abiertas (dependencia, criterio, bitácora), descripción de la línea y las completadas en resumen, con aviso si se recorta (límite de 50.000 caracteres). | Equivalente al MCP de producción. | Ninguno. | Entrega E08. |
| D45 | decidido | Telegram 14-10 00:14: «Si» a D45/D46/D47/D51/D53. | Se mantiene la semántica: descartar no revierte lo aplicado automáticamente. El texto lo dice y explica deshacerlo con «Modificar» en cada cambio. | Igual. | Ninguno. | Entrega E09. |
| D46 | decidido | Mismo. | El puente publica el snapshot del usuario apenas una decisión o una aplicación automática de minuta cambia sus tareas (antes esperaba el ciclo de 5 minutos). | Igual. | Ninguno. | Entrega E09. |
| D47 | decidido (sin cambios) | Mismo. | Las notas privadas solo se procesan en la VM y por la IA; nunca llegan al navegador. | Igual. | Ninguno. | — |
| D51 | decidido | Mismo. | Las secciones personalizadas permiten seleccionar con pulsación larga, con el mismo aviso y botón «Quitar selección». Sin selección se incluyen todas. | Igual al converger. | Ninguno. | Entrega E09. |
| D53 | decidido | Mismo. | Un solo formato de línea para todas las minutas generadas: #id título · Responsable · Fecha · Dependencia · Estado (Abierta/Vencida/Completada), más el resumen IA si la sección lo tiene. Los campos desconocidos se omiten. Cata conserva su cierre «Otros temas tratados». | Igual al converger. | Ninguno. | Entrega E09. |
| D55 | decidido | Telegram 14-10 01:09: «D55 si pero que cada usuario puede definir el título». | Cada usuario define el título en ⚙ › Secciones › «Título del dashboard» (máximo 80 caracteres; también cambia el título de la pestaña). Sin título se muestra «Dashboard de <nombre>». La marca PMO-DSTA (encabezado, copiloto y minutas) solo aparece en el perfil del dueño (caja legada), que conserva «Dashboard Gestión DSTA». | Igual. | Ninguno. | Entrega E10. |
| D57 | decidido | Mismo mensaje: «D57 ok». | Diálogos: el foco parte en el primer campo y archivar enfoca «Cancelar». Escape cierra solo el diálogo; antes cerraba también el inspector, error encontrado por la prueba. Enter guarda y un doble clic no duplica (envío deshabilitado). | Igual. | Ninguno. | Entrega E10. |
| D58 | decidido | «D58 ok pero luego de unos segundos se desvanece hasta desaparecer». | Un solo aviso para todo cambio. El éxito («✓ Tarea creada», «✓ Configuración guardada»…) se desvanece a los 6 s. Errores y resultados inciertos quedan hasta cerrarlos y nunca se reenvían solos, según la regla previa de seguridad. | Igual. | Ninguno. | Entrega E10. |
| D59 | decidido | «d59 ol». | Una cuenta sin líneas ve una tarjeta con 3 pasos (crear línea, conectar Granola, preguntar al copiloto). No se crea nada automático y la tarjeta desaparece al haber líneas. | Igual. | Ninguno. | Entrega E10. |
| D06 | decidido | Telegram 13-10 22:05: «D06: A». | Campos separados. Se edita solo el «Detalle»; los metadatos tienen su propio campo y la bitácora solo admite agregar registros. Ni el formulario ni el copiloto pueden reemplazar la descripción completa (`task.update` ya no acepta `description`). | Igual al converger. | Ninguno. | Entrega E03. |

## Entregas

### Entrega E01 · Defectos D18 y D19 del registro de bitácora

- Decisiones incluidas: D18, D19 (defectos de D17, que el CEO ya pidió que funcione: «intenté hacer un nuevo registro pero no se guardó»). Autorización: Telegram 13-10 21:18, «Si avanza con 1 y 2».
- Alcance aprobado; estado que pasa a: D18 y D19 → verificado local + publicado en piloto (pendiente prueba del CEO).
- Directorio y rama: C:/Users/admin/Documents/DSTA-multiuser/dsta-web-mu · feat/multiusuario.
- Commit base y resultado: b9d29f4 → 303708e.
- Archivos: tools/structure_actions.py, public/task-actions.js, tests/test_structure_actions_bridge.py, tests/test_task_actions.mjs.
- Datos QA: fixtures en memoria (FakeVikunja y harness vm); no se tocaron datos de alvaro.
- Pruebas: `PYTHONUTF8=1 npm test` → 155 Python OK más todas las suites JS. Nuevos casos: repetición de la misma solicitud = un registro; caída entre escritura y registro (marca pendiente) = un registro; nueva solicitud con el mismo texto = se escribe; modo cuentas guardando al instante = task.log; fallo de /api/session = no se envía, mensaje visible, borrador conservado; segundo clic mientras se resuelve el modo = ignorado. Modo legado (404) conserva la vía del copiloto.
- Prueba visual: sin cambios visuales salvo el mensaje de error nuevo; no se hizo revisión de navegador.
- Versiones: Worker staging f7ceee69-0464-4df9-b881-13d4216773e6; puente multiusuario reiniciado con el commit 303708e.
- Rollback: revertir 303708e y redeploy de staging; reiniciar el puente.
- Pendiente: que el CEO pruebe un registro en el piloto. D24/D25 (líneas duplicadas o archivar con tareas) siguen por decidir.

### Entrega E02 · D03 y D04/D07: el copiloto ejecuta lo pedido; mismos campos en ambas vías

- Decisiones incluidas: D03, D04, D07. Autorización: Telegram 13-10 21:46, «Ok».
- Alcance aprobado; estado que pasa a: D03, D04 y D07 → verificado local + publicado en piloto (pendiente prueba del CEO).
- Directorio y rama: C:/Users/admin/Documents/DSTA-multiuser/dsta-web-mu · feat/multiusuario.
- Commit base y resultado: c388b17 → 3d37438.
- Comportamiento:
  - Formulario «+ Nueva tarea» y «Editar tarea» con Responsable, Fecha objetivo, Dependencia y Criterio de cierre (≤300 caracteres). Al crear se escribe la descripción con el formato de pmo_create_task: campos vacíos = «Por confirmar», más `SOURCE: DSTA Dashboard Formulario|Copilot` y `ACTION_KEY: DSTA-FORM|COPILOT-<id>`. Al editar se cambian solo las líneas de metadatos enviadas y la bitácora se conserva.
  - El copiloto puede proponer los mismos campos. Cuando la persona pide algo explícitamente, la propuesta llega marcada `"ejecutar": true`. El Worker la encola en la misma cola verificada de los botones, con un requestId derivado del chat para que no se duplique, y el puente la aplica al instante. El chat muestra «Ejecutando… → ✓ Aplicado», o el error con «Reintentar». Lo que la IA sugiere por su cuenta sigue con «Aplicar». El origen de la creación lo fija el Worker, nunca el modelo.
- Archivos: src/worker.js, public/structure-actions.js, public/assistant.js, tools/structure_actions.py, tools/user_copilot.py, tools/multiuser_bridge.py y sus pruebas.
- Datos QA: fixtures en memoria (FakeVikunja, harness del Worker, puente simulado); no se tocaron datos de alvaro.
- Pruebas: `PYTHONUTF8=1 npm test` → 159 Python OK más todas las suites JS. Casos nuevos:
  - descripción idéntica al formato de producción;
  - la edición conserva la bitácora;
  - el esquema rechaza un responsable de más de 300 caracteres o un origen inválido;
  - lo explícito se encola y lo sugerido no;
  - una propuesta inválida informa el error sin encolarse;
  - el puente aplica la acción sin esperar al siguiente despacho.
  
  Modo de un solo usuario sin cambios: las propuestas siguen deshabilitadas.
- Prueba visual: sin revisión en navegador; queda la prueba del CEO.
- Versiones: Worker staging 99149651-5972-4db8-93de-125705045d55; puente multiusuario reiniciado con 3d37438.
- Rollback: revertir 3d37438, redeploy de staging y reiniciar el puente.
- Verificación del CEO (Telegram 13-10 22:02: «1 check / 2 check»): formulario con campos nuevos y creación sin clic desde el copiloto OK. D03, D04, D07 → **verificado piloto**.
- Prueba que se le pidió al CEO, en dos pasos:
  1. Crear desde el formulario con los campos nuevos.
  2. Pedir al copiloto «crea la tarea X en la LT Y» y confirmar que se crea sin clic.
  
  Siguientes decisiones del plan: D02 (ubicación) y D05/D06.

### Entrega E03 · D02, D05 y D06: controles discretos, fecha única y bitácora protegida

- Decisiones incluidas: D02 (A), D05, D06 (A). Autorización: Telegram 13-10 22:05 («D02: A … D06: A») y 22:06 («Ok» a D05).
- Estado: D02, D05 y D06 → verificado en local y en navegador, y publicado en el piloto. Falta la prueba del CEO.
- Directorio y rama: C:/Users/admin/Documents/DSTA-multiuser/dsta-web-mu · feat/multiusuario.
- Commit base y resultado: 6a5819f → e188492.
- Comportamiento:
  - El inspector muestra «Editar» o «+ Nueva tarea» y un menú «⋯» con Mover, Renombrar y Archivar.
  - El diálogo de edición muestra Título, Responsable, Fecha objetivo, Dependencia, Criterio de cierre y Detalle, con un aviso de cuántos registros tiene la bitácora. Solo envía lo que cambió.
  - El puente divide la descripción en metadatos, detalle y bitácora (`split_description`; misma lógica en el Worker y en el navegador) y reemplaza solo el detalle.
  - Cambiar o quitar la fecha reescribe «Fecha objetivo».
  - La verificación del Worker comprueba el detalle y la línea de fecha.
- Archivos: src/worker.js, public/structure-actions.js, tools/structure_actions.py, tools/user_copilot.py, tests (bridge, worker, copilot, e2e_structure_ui.mjs).
- Datos QA: fixtures en memoria y laboratorio local (wrangler dev + Vikunja de laboratorio) con dos usuarios sintéticos `ui-*`, que se crearon y eliminaron. No se tocaron datos de alvaro.
- Pruebas:
  - `PYTHONUTF8=1 npm test`: 161 Python OK, más todas las suites JS.
  - Navegador (`tests/e2e_structure_lab.py`): 9 de 9 OK.
    - El formulario muestra solo el detalle.
    - Editar el título conserva la descripción estructurada.
    - Cambiar detalle, fecha y responsable actualiza la línea de fecha y conserva los metadatos.
    - El menú «⋯» cabe completo en un móvil de 390 px.
    - Mover, renombrar y archivar funcionan.
    - B no ve nada de A.
    - Sin errores de JavaScript.
- Prueba visual: capturas en escritorio y en móvil, revisadas.
- Versiones: Worker staging 4903d603-d00c-4f19-bead-d43248421be4; puente multiusuario reiniciado con e188492.
- Rollback: revertir e188492, redeploy de staging y reiniciar el puente.
- Pendiente: prueba del CEO, que consiste en editar una tarea con bitácora y cambiarle la fecha.

### Entrega E04 · D14: reabrir tareas completadas

- Decisión: D14. Autorización: Telegram 13-10 22:35, «Si».
- Estado: verificado en local y en navegador, y publicado en el piloto. Falta la prueba del CEO.
- Commit base y resultado: b71dcf3 → e892a3c (rama feat/multiusuario).
- Cambios:
  - Nueva acción `task.reopen` con esquema propio en el Worker. La verificación exige done=false en el snapshot.
  - El puente hace un POST completo con done=false y conserva todos los campos.
  - El copiloto solo propone reabrir tareas que estén completadas.
  - La interfaz muestra «Reabrir tarea» en el menú «⋯» con el estado en línea, sin diálogo.
- Pruebas:
  - `npm test`: 163 Python OK, más todas las suites JS.
  - Navegador en laboratorio local con usuarios sintéticos: 10 de 10. Incluye completar con ✓ y luego reabrir, conservando el responsable.
- Versiones: Worker staging 57ec91a8-272a-431d-9bf8-ec07d381edbf; puente reiniciado con e892a3c.
- Rollback: revertir e892a3c, redeploy de staging y reiniciar el puente.

### Entrega E05 · D23, D24 y D25: reglas de líneas de trabajo

- Decisiones: D23, D24, D25 (más D20 a D22 registradas). Autorización: Telegram 13-10 22:56, «Si ok con todo».
- Estado: verificado en local y en navegador, y publicado en el piloto. Falta la prueba del CEO.
- Commit base y resultado: a967ca8 → aba5565 (rama feat/multiusuario).
- Cambios:
  - Nueva acción `lt.describe`. Su verificación compara la descripción de la LT en el snapshot; para eso `publish_dashboard` ahora incluye `description` por proyecto.
  - `line_key` normaliza los nombres, con la misma lógica en Python y JS.
  - El chequeo de duplicados en `lt.create` está dentro del paso idempotente, así que reintentar la misma solicitud no se ve como duplicado.
  - `lt.archive` cuenta las tareas abiertas en Vikunja antes de escribir.
- Pruebas:
  - `npm test`: 167 Python OK, más todas las suites JS.
  - Navegador con usuarios sintéticos: 12 de 12. Incluye archivar con tarea abierta (rechazado con mensaje), renombrar a un nombre ocupado (rechazado) y editar la descripción, que luego se ve en el inspector.
- Versiones: Worker staging deec1978-3ab2-452f-8992-bf0d4b34e9ac; puente reiniciado con aba5565.
- Rollback: revertir aba5565, redeploy de staging y reiniciar el puente.

### Entrega E06 · D26 a D30: fusionar y restaurar líneas, contexto del copiloto, fecha de creación, etiquetas por chat

- Autorización: Telegram 13-10 23:12, «D26: dejarlo igual que como es en producción / Resto ok».
- Estado: verificado en local y publicado en el piloto. El navegador cubre D27; D26 y D30 desde el chat se cubren con pruebas unitarias, del Worker y del puente, porque en el laboratorio no hay modelo. Falta la prueba del CEO.
- Commit base y resultado: 2303649 → 98e48f4 (rama feat/multiusuario).
- Cambios:
  - `publish_dashboard`: agrega `archivedProjects` y `created` por tarea.
  - Worker: nuevas acciones `lt.restore` y `lt.merge` con su alcance y verificación; las propuestas `label.*` pasan por `validLabelAction` y se ejecutan por /labels/create.
  - Puente: acciones `lt.restore` y `lt.merge`; después del chat drena la cola de etiquetas si corresponde.
  - Copiloto: contexto priorizado y nuevas propuestas.
  - Interfaz: sección «Líneas archivadas» en ⚙ y textos de las propuestas nuevas.
- Pruebas:
  - `npm test`: 172 Python OK, más todas las suites JS.
  - Navegador con usuarios sintéticos: 13 de 13. Incluye archivar y luego restaurar desde ⚙.
- Versiones: Worker staging dd6ee1a2-8c15-4412-9fef-2369defb8b1c; puente reiniciado con 98e48f4.
- Rollback: revertir 98e48f4, redeploy de staging y reiniciar el puente.

### Entrega E07 · D31, D32, D35 y D37: minutas, respaldo y aplicar todas

- Autorización: Telegram 13-10 23:26 («Ok a todo menos d37») y 23:27 («Ok» a D37).
- Estado: verificado en local y publicado en el piloto. El archivo de minutas se llena en la próxima sincronización horaria con Granola. Falta la prueba del CEO.
- Commit base y resultado: e591570 → 2e0e6d2 (rama feat/multiusuario).
- Cambios:
  - `granola_user.sync`: agrega `id` a las minutas y mantiene `minuteArchive`.
  - `user_copilot`: nuevas funciones `minutes_for(user, query)` y `cited_minutes`, más el enfriamiento de Hermes.
  - Puente: pasa la pregunta a la búsqueda de minutas y adjunta las citadas.
  - `assistant.js`: botón «Aplicar todas».
- Pruebas:
  - `npm test`: 175 Python OK, más todas las suites JS.
  - Navegador: 14 de 14. «Aplicar todas» aplica dos sugerencias por la cola y el puente reales; solo se simuló la respuesta del modelo.
- Versiones: Worker staging ecdfac8a-11c9-4b98-9949-6e9497b9b348; puente reiniciado con 2e0e6d2.
- Rollback: revertir 2e0e6d2, redeploy de staging y reiniciar el puente.

### Entrega E08 · D41 y D42: historial de Granola y contexto del analista de minutas

- Autorización: Telegram 14-10 00:08, «Si».
- Estado: verificado en local y activo en el puente del piloto. La carga de 90 días ocurre en la próxima sincronización horaria de cada usuario conectado. Falta la prueba del CEO.
- Commit base y resultado: b21644b → 18672ef (rama feat/multiusuario). Sin cambios en el Worker, así que no hubo redeploy de staging.
- Pruebas:
  - `npm test`: 177 Python OK, más todas las suites JS.
  - Casos nuevos: la primera sincronización pide el rango `custom` de 90 días; solo lo de los últimos 30 días llega a la bandeja; ambas reuniones quedan en el archivo; la siguiente sincronización usa `last_30_days`.
  - El analista ve dependencia, bitácora y tareas completadas.
- Rollback: revertir 18672ef y reiniciar el puente.

### Entrega E09 · D45, D46, D51 y D53: minutas más claras e inmediatas; selección y formato común

- Autorización: Telegram 14-10 00:14, «Si».
- Estado: verificado en local y en navegador, y publicado en el piloto. Falta la prueba del CEO.
- Commit base y resultado: 8d5eabc → 92e43b2 (rama feat/multiusuario).
- Pruebas:
  - `npm test`: 177 Python OK, más todas las suites JS. La prueba de selección ahora verifica el formato común.
  - Navegador: 15 de 15. Incluye una sección personalizada con pulsación larga, «Generar minuta (1 seleccionada)» y el texto con «Estado: Abierta».
- Versiones: Worker staging ee18087f-14fd-43e9-9b21-0f7f4e15a538; puente reiniciado con 92e43b2.
- Rollback: revertir 92e43b2, redeploy de staging y reiniciar el puente.

### Entrega E10 · D55, D57, D58 y D59: identidad, diálogos, avisos y primer ingreso

- Autorización: Telegram 14-10 01:09.
- Estado: verificado en local y en navegador, y publicado en el piloto. Falta la prueba del CEO.
- Commit base y resultado: f9e44d9 → 6c6d1aa (rama feat/multiusuario).
- Pruebas:
  - `npm test`: 177 Python OK, más todas las suites JS, incluido el layout con título y marca.
  - Navegador: 18 de 18. Casos nuevos:
    - título por defecto «Dashboard de UI A» sin PMO-DSTA, título propio guardado y aviso que se desvanece;
    - tarjeta de bienvenida;
    - foco y Escape;
    - aviso «✓ Tarea creada».
- Versiones: Worker staging bfd8555c-17c3-496a-bc88-c337f2665924; puente reiniciado con 6c6d1aa.
- Rollback: revertir 6c6d1aa, redeploy de staging y reiniciar el puente.

## Plantilla de una decisión

### Decisión DNN

- Fecha y chat de origen:
- Respuesta del usuario o referencia accesible:
- Opción elegida y motivo:
- Sustituye a:
- Comportamiento deseado en piloto:
- Comportamiento deseado en producción después del corte:
- Cambio a producción antes del corte: ninguno / entrega separada autorizada:
- Elementos que se conservan:
- Diferencias intencionales o alcance pospuesto:
- Ejemplo de uso esperado:
- Criterios de aceptación:
- Dependencias de otras decisiones:
- Estado:
- Responsable técnico durante la entrega:

La cita de otro agente es contexto; comprobar la autorización y decisión original cuando el alcance de la entrega dependa de ella.

## Plantilla de una entrega

### Entrega ENN

- Decisiones incluidas:
- Alcance aprobado; estado que pasa a:
- Directorio y rama:
- Commit base y commit resultado:
- Archivos modificados:
- Datos QA y mecanismo de limpieza limitado a esos datos:
- Pruebas locales, comando, resultado y archivo de evidencia:
- Prueba visual en escritorio/móvil:
- Versiones de Worker, assets y servicio Python:
- Autorización/fecha del despliegue, si hubo:
- Resultado remoto y limitaciones:
- Demostración y aceptación del usuario:
- Regresión en modo legado:
- Rollback concreto:
- Pendientes y siguiente pregunta:

## Historial de documentación

13 de octubre de 2026: creados PLAN, MATRIZ_DECISIONES, este registro, ACEPTACION y CONTINUIDAD_AGENTES. Guardada evidencia de la comparación previa y puntos de entrada para reanudar. Sin cambios funcionales ni despliegues en esta entrega. El commit local de documentación se identifica con git log; no se introduce un hash autorreferencial dentro del commit.

13 de octubre de 2026 (tarde), Claude Code (chat Telegram del CEO): registradas las decisiones tomadas en ese chat antes de que existiera este plan (tabla superior). En discusión sin decidir: numeración visible por usuario de tareas (opción B «1, 2, 3…» explicada; el CEO preguntó cómo y dónde se implementaría, sin aprobarla). El CEO pidió que Claude Code lleve el plan de convergencia desde ahora (13-10 21:18: «Luego avanzaras tu con el plan»).
