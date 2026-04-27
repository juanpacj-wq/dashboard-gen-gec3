import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
