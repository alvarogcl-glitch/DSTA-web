# Plan de convergencia de DSTA

Producción es la referencia de comodidad y funcionamiento. El piloto conserva las capacidades necesarias para varias personas y sus mejoras se revisan junto con el usuario. La meta es una equivalencia **acordada y probada**, con diferencias intencionales registradas, antes de trasladar la versión multiusuario a producción.

## Punto de entrada

1. [MATRIZ_DECISIONES.md](MATRIZ_DECISIONES.md): 72 aspectos con comparación, recomendación y resultado verificable.
2. [REGISTRO_DECISIONES.md](REGISTRO_DECISIONES.md): decisiones del usuario, alcance por ambiente, implementación y aceptación.
3. [ACEPTACION.md](ACEPTACION.md): escenarios funcionales, visuales y de aislamiento.
4. [CONTINUIDAD_AGENTES.md](CONTINUIDAD_AGENTES.md): estado de reanudación, rutas, evidencia y procedimiento.
5. [evidencia/baseline.json](evidencia/baseline.json): fotografía técnica fechada, sin secretos.

## Alcance ya solicitado por el usuario

- Mantener como referencia la experiencia cómoda y funcional de producción.
- Revisar las diferencias de funciones, flujos y aspecto de forma gradual.
- Conservar las necesidades multiusuario y evaluar sus mejoras.
- Permitir que el usuario decida cómo queda cada función en ambos ambientes.
- Implementar y probar cada incremento elegido antes de avanzar.
- Documentar decisiones, resultados y siguiente paso para continuar desde otros agentes.

Estas instrucciones autorizan este plan y su documentación. Las elecciones concretas de producto siguen abiertas; no se convierten recomendaciones en decisiones. El plan no autoriza por sí solo el corte de producción, mensajes a otros chats o cambios sobre tareas personales.

## Definición de equivalencia

Para cada función acordada, una persona debe conseguir el mismo resultado con datos completos y reglas compatibles, siguiendo el flujo elegido, con tiempos y mensajes comprensibles. La separación entre cuentas se mantiene en todos los recorridos. El aspecto puede variar donde el usuario elija una mejora.

Una diferencia es aceptable cuando tiene una decisión explícita, una razón y una prueba del comportamiento elegido. Igualdad de código, suites verdes o una pantalla parecida no bastan para cerrar la equivalencia.

Producción actual queda como referencia durante la revisión. Si una mejora del piloto se quiere llevar a producción antes del corte, se registra como entrega separada con alcance y autorización propios. La producción futura puede compartir una base común y ofrecer un perfil del dueño y perfiles personales sin sacrificar el aislamiento.

## Estado inicial y evidencia

Revisión del 13 de octubre de 2026:

- Producción: main 40128b6841ddc9edb060ba403d7b84a570fe71b7; Worker activo e5b15c54-c9fe-4d98-b51a-62d8f1f6f891. Snapshot leído directamente en Vikunja: 8 líneas, 164 tareas y 5 etiquetas.
- Piloto: feat/multiusuario f721cb4e15e8f8f8f595501dd6a2eb2f84037bae; Worker activo 051f7146-63f4-48f3-9dce-43ec599cd3b6. Cuenta alvaro; raíz 403 en Vikunja de laboratorio :14701; 1 línea, 7 tareas y 2 etiquetas.
- Piloto: Granola guardado como ready y 30 minutas importadas. Bandeja: 19 procesadas, 5 descartadas, 6 por revisar; acciones: 5 aplicadas, 3 con error y 35 propuestas. No había acciones marcadas auto en la muestra.
- Ambos Workers descargados coinciden byte a byte con la compilación local. Esto verifica el Worker, no sustituye comparar assets, versión del Python activo y UI autenticada.
- Suites existentes: producción 117 pruebas Python y suites JavaScript; piloto 154 pruebas Python y suites JavaScript. Todas pasaron. No se ejecutó de nuevo cada E2E remoto.
- Simulaciones reproducidas: archivo de línea con tarea; nombre de línea duplicado; creación directa sin campos estructurados; entrega repetida de task.log agrega dos registros.
- Los servicios publicador/puente productivos y puente multiusuario estaban activos. La frecuencia normal del piloto es 300 s de publicación y 10 s de despacho.
- El aspecto se comparó desde código; falta revisión visual actual autenticada y en dispositivos.

El piloto **contiene datos personales y minutas importadas**. La frase histórica “solo datos sintéticos” no permite tratar su base, raíz o bandeja actual como desechable. Las pruebas futuras usarán cuentas y raíces propias de QA o fixtures, sin limpiar datos de Álvaro.

## Orden de revisión

Las primeras decisiones definen cómo se usa el sistema. Los defectos funcionales se resolverán dentro de un incremento cuyo comportamiento ya se haya elegido.

| Bloque | Decisiones principales | Resultado de la revisión | Dependencias |
|---|---|---|---|
| B01 Creación y papel del copiloto | D01–D04, D07, D21, D37 | Vía principal, alternativas y significado de Ejecutar/Aplicar. | Ninguna. Primera pregunta presentada: D01. |
| B02 Datos y edición de tareas | D05–D06, D08–D16, D20 | Campos, fechas, protección de antecedentes y operaciones disponibles. | B01. |
| B03 Bitácora y recuperación | D17–D19, D58, D62 | Guardado determinista/IA y recuperación de cualquier cambio incierto. | B01; coordinar con B02. |
| B04 Reglas de líneas | D22–D27 | Unicidad, archivo, descripción, fusión y restauración. | B01. |
| B05 Consultas y herramientas del copiloto | D28–D36 | Alcance de consultas, contexto, reuniones, recordatorios y respaldo. | D03 y campos de B02. |
| B06 Etiquetas | D38–D39; completar D30 | Paridad de clasificación y sus accesos. | B05 para gestión por chat. |
| B07 Granola y reconciliación | D40–D47 | Conexión propia, histórico, automatismos, revisión y actualización inmediata. | B02, B03, B05. |
| B08 Secciones y minutas generadas | D48–D54 | Perfil inicial, Cata, personalización, selección y resúmenes. | B02 y decisión de datos IA. |
| B09 Apariencia y primeros recorridos | D02, D55–D57, D59 | Pantallas comparadas y diseño aprobado en móvil/escritorio. | Inicio en B01; cierre después de B08. |
| B10 Sincronización y capacidad | D60–D65 | Frecuencias, actualización manual, estados de salud y prioridades. | Carga representativa de B05–B08. |
| B11 Cuentas y dispositivos | D66–D71 | Alta, sesión, soporte, aislamiento y experiencia del dueño/dispositivos. | Aislamiento desde B01; cierre con funcionalidades acordadas. |
| B12 Integración y equivalencia final | D72 y todas las aceptaciones | Versiones reproducibles, diferencias aceptadas y ensayo de migración/rollback. | Bloques anteriores cerrados o diferidos explícitamente. |

D02 pertenece a B01 para elegir el acceso y a B09 para revisar su apariencia. D30 queda decidido en B05 y se verifica con B06. No contar una misma decisión dos veces: el registro tiene una única entrada por ID.

## Ciclo de cada incremento

1. Presentar una situación concreta de producción y del piloto, con captura o ejemplo cuando ayude; máximo una a tres decisiones relacionadas a la vez.
2. Registrar la respuesta del usuario literalmente o con resumen fiel, incluyendo ambiente piloto, producción futura y producción antes del corte.
3. Definir alcance, criterios de aceptación, datos QA, rutas técnicas y cualquier diferencia intencional.
4. Preparar cambio pequeño en la copia apropiada; seguir las reglas de pruebas del proyecto. No mezclar decisiones aún abiertas.
5. Ejecutar pruebas de contrato/regresión y escenarios necesarios. Cambios visibles requieren navegador y revisión móvil; IA requiere probar también resultado, contexto y escritura, no solo texto del modelo.
6. Publicar en piloto únicamente si esa entrega está autorizada, verificar versión y proceso Python que la atiende, y comprobar en su URL. Una prueba local no se registra como validación remota.
7. Mostrar resultado al usuario, diferencias restantes y evidencia. La aceptación del usuario cierra usabilidad; el agente no la inventa.
8. Actualizar registro, estado de continuidad y siguiente pregunta en la misma entrega. Guardar cambios/documentación en Git local y anotar commit; publicar Git solo según alcance autorizado.

Se pueden agrupar cambios inseparables de un mismo recorrido; no modificar producción solo para conseguir uniformidad.

## Estados y cierre

Estados: por decidir → decidido → preparado → implementado → verificado local → verificado piloto → aceptado usuario. “Diferido explícitamente” y “diferencia aceptada” requieren la respuesta que los justifica y su condición de revisión.

Una decisión elegida sin código no está implementada; código local sin despliegue no está en piloto; pruebas verdes no acreditan aceptación visual. Un cambio exclusivo de documentación usa “documentado” y no finge pasar por estados de despliegue.

Para cerrar B12 deben estar resueltas las 72 filas, por aceptación completa o diferencia/diferimiento explícito compatible con la migración. Deben pasar los escenarios de [ACEPTACION.md](ACEPTACION.md), estar preservados datos/IDs del dueño, y existir ensayo del corte y rollback con respaldo recuperable.

El corte productivo requiere la autorización explícita del usuario sobre el resultado concreto. El runbook histórico F6 se revisa contra el diseño final; no se ejecuta por estar escrito.

## Próximo paso

Decidir D01: creación con copiloto principal y formulario opcional; solo copiloto; o formulario principal y copiloto opcional. La recomendación es la primera, conservando comodidad y alternativa determinista. D01 no resuelve automáticamente D03: se preguntará por separado si la IA ejecuta o propone. Después resolver D04 y D07 para que todas las vías guarden una tarea equivalente.
