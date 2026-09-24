# DSTA-web

Dashboard ejecutivo PMO-DSTA. La interfaz es HTML, CSS y JavaScript sin framework ni etapa de compilación. Un Cloudflare Worker protege el sitio, sirve los archivos estáticos y expone la API del dashboard. La VM consulta Vikunja y publica snapshots autenticados en Workers KV.

## Estructura

```text
public/index.html            Dashboard real
src/worker.js                Autenticación, API y entrega de archivos
tools/publish_dashboard.py   Sincronizador Vikunja → Cloudflare
wrangler.jsonc               Worker, Static Assets y Workers KV
package.json                 Wrangler y comandos del proyecto
```

No se usa `dist` porque no hay un framework que compilar. Wrangler publica directamente `public/` como Static Assets.

## Generación de minutas

- Mantener presionada durante 650 ms una tarjeta LT/TR genera una minuta con la
  fecha local y únicamente las tareas abiertas de esa línea.
- **Generar minuta de portafolio** distribuye las tareas abiertas entre DeID,
  ICT, AER, Academias TI y temas generales/transversales.
- **Generar minuta Cata 1-1** incorpora únicamente los temas pendientes
  vinculados explícitamente a Cata.
- El texto generado se puede editar en el panel lateral y copiar al
  portapapeles. Como alternativa de teclado, `Mayús+Enter` sobre una LT/TR abre
  su minuta.

## Configuración de Cloudflare

La integración Git debe usar:

- Branch: `main`
- Root directory: `/`
- Build command: ninguno
- Deploy command: `npx wrangler deploy`
- Preview command: `npx wrangler versions upload`

El primer deploy crea automáticamente el namespace KV declarado como `DASHBOARD_DATA`. Después del deploy, en **Workers & Pages → dsta-web → Settings → Variables and Secrets**, crear estos tres secretos cifrados:

- `DASHBOARD_USER`: usuario solicitado por el navegador, por ejemplo `alvaro`.
- `DASHBOARD_PASSWORD`: contraseña del dashboard.
- `INGEST_TOKEN`: token largo y aleatorio usado exclusivamente por la VM.

El Worker falla de forma cerrada con estado 503 mientras falte cualquiera de esos secretos. Ningún secreto debe guardarse en Git.

## Publicación desde la VM

El publicador requiere estas variables locales:

```dotenv
VIKUNJA_URL=http://127.0.0.1:3456
VIKUNJA_API_TOKEN=...
DSTA_DASHBOARD_URL=https://dsta-web.<subdominio>.workers.dev
DSTA_DASHBOARD_INGEST_TOKEN=...
```

`DSTA_DASHBOARD_INGEST_TOKEN` debe ser idéntico al secreto `INGEST_TOKEN` de Cloudflare. Para probar una publicación:

```powershell
python tools/publish_dashboard.py --once --env-file C:\ruta\configuracion-local.env
```

En esta instalación, la URL de producción es
`https://dsta-web.alvaro-gcl.workers.dev`. El token también puede mantenerse en
un archivo local independiente, lo que evita incluirlo en variables o argumentos
de tareas programadas:

```powershell
python tools/publish_dashboard.py `
  --env-file C:\Users\admin\AppData\Local\hermes\.env `
  --dashboard-url https://dsta-web.alvaro-gcl.workers.dev `
  --ingest-token-file C:\Users\admin\AppData\Local\hermes\cache\vikunja-dashboard-ingest-token.txt
```

## Copiloto Hermes

El dashboard no conecta el navegador directamente con Hermes. El puente local
consulta el Worker mediante HTTPS saliente cada cinco segundos, toma las
solicitudes pendientes y ejecuta Hermes en la VM. No requiere publicar puertos
de Hermes ni crear un túnel entrante. Las conversaciones se mantienen en la
pestaña abierta del navegador. La cola y las respuestas recientes del chat se
guardan en un Durable Object de Cloudflare para evitar los retrasos de
propagación de Workers KV; los trabajos terminados se purgan pasado un día.
El snapshot de Vikunja y los resúmenes siguen en Workers KV.

El chat invoca Hermes con los toolsets `vikunja-dashboard` y `cronjob`, sin
acceso a terminal, archivos o navegador. El MCP `vikunja-dashboard` expone seis
operaciones acotadas: consultar proyectos/tareas, editar campos, completar una
tarea, actualizar su campo estructurado de dependencia y añadir comentarios.
Puede programar un recordatorio cuando se lo pidas y le indiques cuándo. Los
resúmenes automáticos de Cata usan Hermes en una sesión aislada sin herramientas.
Solo se recalculan para
tareas cuyo contenido cambió y se descartan si la tarea vuelve a cambiar antes
de terminar el resumen.

### Activación

1. El MCP `vikunja-dashboard` ya está registrado en esta VM y separado del MCP
   general de Telegram. Si se instala la VM desde cero, regístralo así:

   ```powershell
   hermes mcp add vikunja-dashboard `
     --command C:\Users\admin\AppData\Local\Programs\Python\Python312\python.exe `
     --args C:\Users\admin\Documents\Codex\2026-09-22\hola\work\DSTA-web\tools\vikunja_dashboard_mcp.py
   ```

2. Genera un secreto aleatorio de al menos 32 bytes:

   ```powershell
   python -c "import secrets; print(secrets.token_urlsafe(48))"
   ```

3. Guarda ese mismo valor como secreto cifrado `DSTA_BRIDGE_TOKEN` en **Workers
   & Pages → dsta-web → Settings → Variables and Secrets** y como variable
   `DSTA_BRIDGE_TOKEN` en `C:\Users\admin\AppData\Local\hermes\.env`. No lo
   guardes en el repositorio.

4. La URL del Worker y la ruta de Hermes ya tienen valores
   predeterminados para esta VM. Si cambian, configura estas variables locales:

   ```dotenv
   HERMES_CLI=C:\Users\admin\AppData\Local\Programs\Python\Python312\Scripts\hermes.exe
   DSTA_HERMES_PROVIDER=openai-codex
   DSTA_HERMES_MODEL=gpt-6-luna
   ```

5. Despliega el Worker actualizado desde `main` y ejecuta el puente en la VM:

   ```powershell
   python C:\Users\admin\Documents\Codex\2026-09-22\hola\work\DSTA-web\tools\hermes_bridge.py `
     --env-file C:\Users\admin\AppData\Local\hermes\.env
   ```

   Mantén el proceso activo para recibir consultas y procesar resúmenes. En esta
   VM, la tarea programada `DSTA Hermes Bridge` lo inicia al comenzar sesión
   y lo mantiene activo en segundo plano.

Sin `DSTA_BRIDGE_TOKEN`, el dashboard y la publicación de Vikunja siguen
funcionando; el chat informa que el puente no está configurado y no se generan
resúmenes automáticos.

En operación normal, el script consulta Vikunja cada 30 segundos. Solo escribe en KV si cambian los datos o cada cinco minutos como pulso de actividad, manteniéndose dentro de los límites del plan gratuito.

## Desarrollo local

```powershell
npm install
npm run dev
```

Para desarrollo se puede crear `.dev.vars` (ignorado por Git):

```dotenv
DASHBOARD_USER=alvaro
DASHBOARD_PASSWORD=contraseña-local
INGEST_TOKEN=token-local
```

## Despliegue manual opcional

La integración con GitHub despliega automáticamente cada commit en `main`. Si se necesita desplegar manualmente desde una sesión autenticada de Wrangler:

```powershell
npm install
npm run deploy
```
