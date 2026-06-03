#!/usr/bin/env bash
set -euo pipefail

# Actualización en sitio. IDÉNTICO en todos los servidores: el build es instancia-agnóstico.
# La identidad de cada servidor vive en dos archivos por-servidor que este script NO toca:
#   - server/.env             (secretos + BD)
#   - instance/config.json    (orden de unidades, default, branding)
#
# Uso:  sudo /var/www/dashboard-gen/deploy/update.sh

APP_DIR=/var/www/dashboard-gen
cd "$APP_DIR"

echo "== Actualizando dashboard en $APP_DIR =="
git pull --ff-only

echo "== Build frontend =="
npm ci
npm run build

echo "== Deps del servidor =="
cd server
npm ci
npx playwright install chromium   # no-op si ya está instalado

echo "== Reiniciando servicio =="
sudo systemctl restart dashboard-ws

echo "== Listo. Instancia actual: $(cat "$APP_DIR/instance/config.json" 2>/dev/null | grep -o '"instance"[^,]*' || echo 'desconocida') =="
echo "   Verificar: curl -s http://localhost/health && curl -s http://localhost/config.json"
