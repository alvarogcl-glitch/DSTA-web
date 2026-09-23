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
