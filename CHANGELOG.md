# Historial de versiones

## Pendiente — Consulta de tareas creadas por fecha

- Consulta compacta `pmo_tasks_created` con total exacto y paginación completa.
- Filtro por creación nativa en America/Santiago, con fechas inclusivas y tareas
  completadas, sin confundir modificaciones con creaciones.
- Instrucciones del copiloto y regresiones para límites de día y páginas posteriores.
- Activación: instalar `tzdata` en el Python de la VM, actualizar MCP/puente y
  reiniciar DSTA Hermes Bridge; no requiere publicar el Worker.

## 1.1.0 — Gestión de etiquetas

- Etiquetas nativas de Vikunja en snapshots y tareas, con color de relleno.
- Filtro desplegable de etiquetas con búsqueda y selección múltiple en inventario.
- Sección de tareas agrupadas por etiquetas, incluyendo tareas sin clasificación.
- Ventana de personalización con creación, modificación, eliminación y paleta fija.
- Gestión en el inspector y creación de una etiqueta con asignación inmediata.
- Cola directa sin IA, UUID persistente, concesiones y confirmación por snapshot.
- Limpieza de etiquetas anteriores conservando Carrera tecnológica, con respaldo.
- Pruebas Python, Worker y navegador local, y documentación de activación en VM.

La activación requiere publicar el Worker y actualizar/reiniciar el publicador y
el puente de la VM. Esta versión de código no acredita por sí sola un despliegue
productivo ni la ejecución de la limpieza sobre datos reales.
