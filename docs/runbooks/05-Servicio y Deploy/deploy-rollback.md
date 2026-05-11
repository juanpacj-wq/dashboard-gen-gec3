# Deploy + verificación + rollback

**Verifica:** el procedimiento de deploy estándar funciona sin sorpresas, y
hay un rollback rápido disponible si algo se rompe.

## Cuándo correrlo

- Cada vez que se aplican cambios nuevos en producción.
- Como simulacro mensual: hacer un cambio cosmético, deployar, verificar,
  rollbackear, verificar — para tener confianza en el procedimiento.

## Procedimiento de deploy estándar (server Ubuntu)

```bash
cd /var/www/dashboard-gen

# 0. Snapshot del commit actual (para rollback)
PREV=$(git rev-parse HEAD)
echo "Commit previo: $PREV"

# 1. Pull
git fetch origin
git log --oneline HEAD..origin/main    # ver qué viene
git pull origin main

# 2. Build frontend
npm run build

# 3. Server deps (solo si package.json cambió)
cd server
npm ci

# 4. Restart
sudo systemctl restart dashboard-ws

# 5. Smoke pack inmediato (ver README.md sección "Smoke pack mínimo post-deploy")
sleep 30
curl -s http://localhost:3001/health | jq '.status, .pme.stale, .emailDispatch.gec.stale, .emailDispatch.tgj.stale'
```

## Esperado tras smoke pack post-deploy

```
"ok"
false
false
false
```

Y el dashboard en `http://192.168.17.65/` muestra:
- 4 cards con badge MEDIDOR/PME (ver `04-Frontend y Realtime/badges-visuales.md`).
- Fila "Despacho Final" con ✉ en periodos donde llegaron emails.
- Generación con valores numéricos (no todos en 0).

## Rollback (si algo se rompió)

```bash
cd /var/www/dashboard-gen

# Volver al commit previo
git reset --hard $PREV   # usar el SHA capturado en el paso 0
# O si no tenés el SHA: git reset --hard HEAD~1

# Rebuild y restart
npm run build
cd server && npm ci
sudo systemctl restart dashboard-ws

# Reverificar /health
sleep 30
curl -s http://localhost:3001/health | jq '.status'
```

## Interpretación del smoke post-deploy

- 🟢 `status: "ok"` y los 3 stale en `false` → deploy exitoso, listo.
- 🟡 `pme.stale: true` durante el primer minuto → warming up de Playwright,
  esperar 30-60 segundos más y reverificar.
- 🔴 `status: "degraded"` persistente tras 2 minutos → algo del cambio rompió un
  componente. Identificar cuál con `jq '.pme, .emailDispatch'` y consultar el
  archivo correspondiente.
- 🔴 Servicio en `failed` (no responde a curl) → ver `service-restart.md` para
  diagnóstico, y considerar rollback inmediato si no se identifica la causa
  en pocos minutos.

## Verificación visual final

Tras el smoke automatizado:

1. Abrir `http://192.168.17.65/` con **Ctrl+Shift+R** (force reload, evita
   bundle viejo cacheado).
2. Verificar que los 4 cards tienen badge.
3. Verificar fila "Despacho Final" tiene ✉ donde corresponde.
4. Verificar fila "Generacion" tiene valores numéricos para periodos pasados.
5. Verificar que el header dice **"En vivo"** (WS conectado).

## Si fallaron varios deploys recientes

Si tenés que rollbackear pero no sabés a qué SHA volver, podés llegar al último
commit conocido bueno con:

```bash
# Lista commits recientes con sus mensajes
git log --oneline -15

# Buscar uno con mensaje "ok" / pre-feature problemática
# y volver:
git reset --hard <SHA>
```

Esto **NO afecta** el código en local del desarrollo (es operación de
producción solamente). El código local sigue igual y se puede re-deployar
después de fixear el problema.
