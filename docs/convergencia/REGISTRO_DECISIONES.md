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
