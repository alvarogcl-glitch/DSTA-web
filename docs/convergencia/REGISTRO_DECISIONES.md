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
