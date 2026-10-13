# Trabajo en DSTA multiusuario

El plan vigente de convergencia está en docs/convergencia/PLAN.md.
Antes de modificar funciones, lee la matriz, el registro de decisiones, la aceptación y la
continuidad enlazados allí. El registro y respuestas humanas posteriores determinan el estado.
Las fases del plan histórico MULTIUSUARIO_PLAN.md no prueban equivalencia con producción.

El usuario quiere conservar la usabilidad de producción, mantener aislamiento por persona y
decidir gradualmente las mejoras. Prepara, implementa y prueba incrementos elegidos; conserva
otras decisiones abiertas. Las recomendaciones no autorizan cambios funcionales.

Sigue la práctica de pruebas del proyecto: para cambios de comportamiento empieza por una
prueba que lo acredite y falle en la base anterior cuando corresponda. Añade pruebas del
resultado observable, no copias de implementación. Verifica modo cuentas y legado cuando
el contrato común cambia. Los cambios visibles requieren revisión de navegador/móvil.

Staging contiene datos personales de alvaro y minutas importadas; pruebas con fixtures o
cuentas/raíces QA separadas. No limpiar datos existentes. Usa wrangler.staging.jsonc para
piloto y registra Worker, assets y Python por separado. No desplegar a producción ni hacer
push a main sin autorización concreta ya existente del usuario.

Actualiza registro, evidencia y siguiente paso con cada entrega. Nunca guardar secretos,
cookies, contraseñas ni links de invitación activos en archivos de documentación o Git.
