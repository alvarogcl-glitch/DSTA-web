# Antecedentes para decidir la creación de tareas

D01 sigue por decidir. El usuario pidió comprender los recorridos antes de elegir. Este documento separa las tres vías actuales de una posible combinación futura. No se creó ninguna tarea para preparar estos antecedentes.

## La misma tarea en los tres recorridos

Ejemplo ficticio: “Crea en la línea Gestión una tarea llamada Preparar informe de riesgos, responsable Paula, fecha 20 de octubre de 2026, dependencia del informe de Finanzas y criterio de cierre: informe revisado y enviado”.

La línea Gestión debe existir en el ambiente correspondiente. Los nombres y datos son ilustrativos, no una instrucción de escritura.

## Producción con copiloto

1. Abrir el chat y escribir la solicitud en lenguaje natural.
2. La IA interpreta el pedido y consulta herramientas para localizar la línea y preparar la creación. Puede preguntar si necesita aclaraciones; no hay un formulario previo obligatorio.
3. La herramienta crea en Vikunja una tarea con título y descripción estructurada. Admite responsable, fecha objetivo, dependencia y criterio; los campos vacíos se registran como Por confirmar. Incluye SOURCE/ACTION_KEY.
4. El sistema verifica la creación y publica datos nuevos antes de finalizar la respuesta correctamente. Fallos de publicación se comunican; no asumir éxito solo por texto del modelo.
5. La persona ve la respuesta y la nueva tarea en el portafolio.

Enviar la solicitud explícita permite ejecutar el cambio por chat. No existe un paso universal de “propuesta → Aplicar” como en el piloto. El texto exacto de la confirmación depende de la IA.

Ventaja de uso: expresar el resultado completo en una frase, añadir contexto y pedir varias operaciones relacionadas. Dependencia: modelo principal o respaldo más puente y servicios. Si la IA interpreta mal un dato, puede requerir una corrección posterior. Elegir esta vía no obliga a quitar accesos directos a otras funciones que ya son cómodas.

## Piloto con formulario

1. Abrir la tarjeta de la línea Gestión.
2. Pulsar Nueva tarea.
3. Escribir título, descripción y fecha; la línea queda determinada por la tarjeta abierta.
4. Pulsar Guardar. Código determinista envía el cambio; ningún modelo interpreta esos campos.
5. El puente crea en Vikunja, publica y comprueba un snapshot antes de terminar el seguimiento.

No hay casillas separadas para responsable, dependencia o criterio. Para que el ejemplo aparezca con esos datos en indicadores/inspector, la descripción debe tener líneas como:

```text
Responsable: Paula
Dependencia: Informe de Finanzas
Criterio de cierre: Informe revisado y enviado

Preparar informe de riesgos.
```

Escribir “Paula preparará el informe cuando Finanzas entregue sus datos” como prosa no garantiza que el dashboard detecte Responsable o Dependencia. La creación directa tampoco agrega automáticamente SOURCE/ACTION_KEY como la herramienta productiva.

Ventaja de uso: para una tarea simple, evita espera e interpretación del modelo y fija exactamente título/descripción/fecha. Sigue necesitando red, Worker, puente y Vikunja. Sus campos actuales no equivalen al formulario estructurado completo que podría diseñarse.

## Piloto con copiloto y Aplicar

1. Escribir la misma solicitud en el chat.
2. La IA recibe el contexto propio y puede devolver una propuesta estructurada válida. No tiene herramientas para crear por sí misma.
3. El chat muestra Aplicar con una descripción corta de la propuesta. En creación, la presentación actual resume título, línea y fecha, no una revisión completa de todos los campos.
4. Hasta pulsar Aplicar no se crea la tarea. Una respuesta textual sin propuesta aplicable tampoco la crea.
5. Al pulsar Aplicar, el código ejecuta la creación y verifica su resultado por snapshot, como la vía directa.

La IA puede incluir Responsable/Dependencia/Criterio dentro de la descripción propuesta, pero la acción no tiene parámetros separados para esos campos ni normaliza automáticamente el texto al formato del creador productivo. No se debe presumir que una petición en lenguaje natural genera siempre la misma estructura.

Ventaja de uso: lenguaje natural más decisión final de la persona. Coste de interacción: esperar la propuesta y aplicar cada cambio. Para una línea nueva seguida de una tarea, los IDs deben existir; la propuesta inicial no puede referenciar un ID futuro inventado. Hasta cinco propuestas por respuesta.

## Comparación para la elección

| Aspecto | Producción por copiloto | Piloto por formulario | Piloto por propuesta |
|---|---|---|---|
| Lo que hace la persona | Expresa el pedido completo. | Abre línea y llena campos. | Expresa pedido, espera y aplica. |
| Interpretación de IA | Sí. | No. | Sí para preparar propuesta; no para ejecutarla. |
| Momento de la escritura | Durante la ejecución de la solicitud del chat. | Después de Guardar. | Después de Aplicar. |
| Información específica | Herramienta con responsable, fecha, dependencia y criterio. | Título, descripción libre, fecha. | Título, descripción y fecha; estructura depende de propuesta. |
| Dependencia de disponibilidad IA | Sí, principal o respaldo. | No. | Sí para preparar la propuesta. |
| Revisión antes de guardar | No hay tarjeta obligatoria de revisión. | Campos visibles en formulario. | Vista corta actual, incompleta para revisar toda la descripción. |
| Petición de varios cambios | Agente puede encadenar herramientas. | Varias operaciones de interfaz. | Hasta cinco propuestas con aplicación individual y dependencias de IDs. |
| Adecuación | Pedidos con contexto o varias propiedades. | Captura exacta y simple. | Pedidos con contexto y control previo. |

No hay mediciones de tiempo comparables para asegurar segundos exactos. El formulario elimina el tiempo del modelo; todas las vías dependen de recepción del puente y confirmación de datos.

## Qué significa combinar los recorridos

“Copiloto principal y formulario opcional” es una propuesta de acceso, todavía no implementada como diseño final. Puede significar conservar el chat como recorrido habitual y ofrecer Nueva tarea discretamente para captura exacta o cuando la IA no esté disponible.

La modalidad de ejecución se decide por separado: ese copiloto podría ejecutar como producción, presentar siempre propuesta, o pedir revisión solo en operaciones elegidas. D01 no selecciona automáticamente D03.

También es independiente el contrato de datos: ambas vías pueden diseñarse para guardar responsable, fecha, dependencia, criterio y origen de forma equivalente. Ese trabajo corresponde a D04/D07; no está resuelto por dejar ambos botones.

## Decisiones que se discutirán después de los antecedentes

- D01: acceso principal y alternativa.
- D03: cuándo la IA ejecuta y cuándo la persona revisa/aplica.
- D04/D07: campos y trazabilidad comunes.
- D02: ubicación y apariencia de los controles.
- D37: operaciones relacionadas, cantidad y orden.

Antes de pedir decisión se puede mostrar un recorrido con fixture y capturas si el usuario necesita ver pantallas. Usar cuentas QA separadas; no crear tareas del ejemplo en su portafolio. Mantener la decisión pendiente mientras solicite más antecedentes.
