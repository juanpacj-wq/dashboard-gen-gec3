import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

// Dev-only: sirve /config.json según la instancia elegida, SIN editar archivos ni el .env.
// Instancia = ?instance= (query, cambio en vivo por URL) → INSTANCE (env) → 'gec3' (default).
// Fuente única: deploy/config.<instancia>.json (las mismas plantillas que usa el servidor).
// Se instala ANTES de los middlewares internos de Vite para sombrear public/config.json.
// En prod no aplica: nginx sirve /config.json ignorando el query string.
const serveInstanceConfig = () => ({
  name: 'serve-instance-config',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url) return next()
      const { pathname, searchParams } = new URL(req.url, 'http://localhost')
      // El frontend pide config.json bajo su BASE_URL. En dev el base default es '/', pero
      // aceptamos también la forma con sub-path por si se corre dev con APP_BASE_PATH.
      if (!pathname.endsWith('/config.json')) return next()
      const inst = (searchParams.get('instance') || process.env.INSTANCE || 'gec3').replace(/[^a-z0-9_-]/gi, '')
      const candidate = path.resolve(ROOT, `deploy/config.${inst}.json`)
      const file = fs.existsSync(candidate) ? candidate : path.resolve(ROOT, 'public/config.json')
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      fs.createReadStream(file).pipe(res)
    })
  },
})

// Sub-path de despliegue, configurable por env (paridad con Bit-cora-g3). Sin APP_BASE_PATH el
// app vive en la raíz '/' — dev, y el servidor de Guajira (instancia standalone sin Bitácora).
// El servidor UNIFICADO (que convive con Bitácora) construye con APP_BASE_PATH=/dashboard. Vite
// expone el valor en import.meta.env.BASE_URL (ver src/config/paths.js); un solo código sirve
// cualquier base sin tocar URLs. update.sh lee este env del server/.env por-servidor.
const rawBase = process.env.APP_BASE_PATH || '/'
const base = rawBase.endsWith('/') ? rawBase : rawBase + '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react(), serveInstanceConfig()],
  server: {
    // Dev sirve en la raíz (base '/'), así que el frontend pide /api, /ws, /config.json y estos
    // proxies van sin strip. En prod el strip del sub-path lo hace nginx, no Vite. Nota: Vite
    // resuelve por prefijo MÁS LARGO, no por orden de declaración — /api/eventos-dashboard
    // (→3002) le gana a /api (→3001) aunque se reordenen las claves.
    proxy: {
      "/api/xm": {
        target: "https://servapibi.xm.com.co",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/xm/, ""),
      },
      "/ws": {
        target: "http://localhost:3001",
        ws: true,
      },
      // eventos-dashboard vive en el backend de Bitácora (3002), endpoint público cross-repo.
      "/api/eventos-dashboard": {
        target: "http://localhost:3002",
        changeOrigin: true,
      },
      // Resto de la API → backend del dashboard (3001).
      "/api": {
        target: "http://localhost:3001",
      },
    },
  },
})
