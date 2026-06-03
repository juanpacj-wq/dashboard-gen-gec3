import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
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
      if (pathname !== '/config.json') return next()
      const inst = (searchParams.get('instance') || process.env.INSTANCE || 'gec3').replace(/[^a-z0-9_-]/gi, '')
      const candidate = path.resolve(ROOT, `deploy/config.${inst}.json`)
      const file = fs.existsSync(candidate) ? candidate : path.resolve(ROOT, 'public/config.json')
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      fs.createReadStream(file).pipe(res)
    })
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), serveInstanceConfig()],
  server: {
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
      "/api/autorizaciones": {
        target: "http://localhost:3002",
        changeOrigin: true,
      },
      "/api/eventos-dashboard": {
        target: "http://localhost:3002",
        changeOrigin: true,
      },
      "/api/periods": {
        target: "http://localhost:3001",
      },
      "/api/despacho-final": {
        target: "http://localhost:3001",
      },
      "/api/despacho": {
        target: "http://localhost:3001",
      },
      "/api/redespacho": {
        target: "http://localhost:3001",
      },
      "/api/proyeccion-periodos": {
        target: "http://localhost:3001",
      },
      "/api/proyeccion": {
        target: "http://localhost:3001",
      },
      "/api/desviacion-periodos": {
        target: "http://localhost:3001",
      },
    },
  },
})
