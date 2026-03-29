#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/var/www/dashboard-gen

echo "=== Dashboard Generacion GEC3 — Setup de produccion ==="

# 1. Dependencias del sistema
echo "[1/8] Instalando dependencias del sistema..."
sudo apt-get update -qq
sudo apt-get install -y nginx curl xvfb

# Node.js 20 LTS (si no esta instalado)
if ! command -v node &>/dev/null; then
  echo "[1/8] Instalando Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "  Node: $(node -v) | npm: $(npm -v)"

# 2. Dependencias de Playwright (Chromium headless)
echo "[2/8] Instalando dependencias de Playwright/Chromium..."
sudo npx playwright install-deps chromium

# 3. Directorio de la aplicacion
echo "[3/8] Preparando directorio $APP_DIR..."
sudo mkdir -p "$APP_DIR"
sudo chown "$USER":"$USER" "$APP_DIR"

# 4. Copiar archivos (si se ejecuta desde el repo local)
echo "[4/8] Copiando archivos del proyecto..."
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
rsync -a --exclude node_modules --exclude .git --exclude dist "$SCRIPT_DIR/" "$APP_DIR/"

# 5. Build del frontend
echo "[5/8] Instalando dependencias y construyendo frontend..."
cd "$APP_DIR"
npm ci
npm run build

# 6. Dependencias del servidor + Chromium
echo "[6/8] Instalando dependencias del servidor..."
cd "$APP_DIR/server"
npm ci
npx playwright install chromium

# 7. Archivo de entorno
if [ ! -f "$APP_DIR/server/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/server/.env"
  echo ""
  echo "  >>> IMPORTANTE: Edita /var/www/dashboard-gen/server/.env con las credenciales reales"
  echo "  >>> sudo nano /var/www/dashboard-gen/server/.env"
  echo ""
fi

# 8. Nginx
echo "[7/8] Configurando Nginx..."
sudo cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/dashboard-gen
sudo ln -sf /etc/nginx/sites-available/dashboard-gen /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# 9. systemd
echo "[8/8] Configurando servicio systemd..."
sudo cp "$APP_DIR/deploy/dashboard-ws.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dashboard-ws

echo ""
echo "=== Despliegue completado ==="
echo ""
echo "Verificar:"
echo "  sudo systemctl status dashboard-ws"
echo "  journalctl -u dashboard-ws -f"
echo "  curl http://localhost/health"
echo ""
