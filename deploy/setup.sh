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
# Sub-path de despliegue. Servidor UNIFICADO gecelca3 (con Bitácora): correr este script con
# `APP_BASE_PATH=/dashboard sudo -E ./setup.sh`. Despliegue root (incl. Guajira): dejarlo vacío
# → raíz '/'. Precedencia: env var > server/.env existente > raíz. El valor efectivo se
# PERSISTE en server/.env (paso 7b) para que update.sh reconstruya con la misma base.
if [ -z "${APP_BASE_PATH:-}" ] && [ -f "$APP_DIR/server/.env" ]; then
  APP_BASE_PATH="$(grep -E '^APP_BASE_PATH=' "$APP_DIR/server/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
fi
export APP_BASE_PATH="${APP_BASE_PATH:-}"
echo "  base del build: '${APP_BASE_PATH:-/}'"
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

# 7a. Persistir el sub-path efectivo del build en server/.env. Sin esto, el siguiente
# update.sh (que lee APP_BASE_PATH de server/.env) reconstruiría en la raíz '/' y rompería
# el app bajo /dashboard/ silenciosamente.
if grep -qE '^APP_BASE_PATH=' "$APP_DIR/server/.env"; then
  sed -i "s|^APP_BASE_PATH=.*|APP_BASE_PATH=${APP_BASE_PATH}|" "$APP_DIR/server/.env"
else
  printf '\nAPP_BASE_PATH=%s\n' "$APP_BASE_PATH" >> "$APP_DIR/server/.env"
fi
echo "  APP_BASE_PATH='${APP_BASE_PATH}' persistido en server/.env (lo usa update.sh)"

# 7b. Config de instancia (per-servidor, fuera del bundle — la sirve nginx en /config.json).
# Por defecto siembra la instancia gec3. En el servidor B, sobreescribir con la plantilla
# guajira ANTES o DESPUÉS de este script:
#   sudo cp /var/www/dashboard-gen/deploy/config.guajira.json /var/www/dashboard-gen/instance/config.json
mkdir -p "$APP_DIR/instance"
if [ ! -f "$APP_DIR/instance/config.json" ]; then
  cp "$APP_DIR/deploy/config.gec3.json" "$APP_DIR/instance/config.json"
  echo ""
  echo "  >>> Config de instancia sembrada: $APP_DIR/instance/config.json (gec3)"
  echo "  >>> Para la instancia guajira: sudo cp $APP_DIR/deploy/config.guajira.json $APP_DIR/instance/config.json"
  echo ""
fi

# 8. Nginx
# NOTA: deploy/nginx.conf es la topología del SERVIDOR UNIFICADO (namespaced /dashboard +
# placeholder para /bitacora). Para Guajira/standalone (root '/') usar un nginx propio, no este.
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
echo "Verificar (BASE='${APP_BASE_PATH:-/}'):"
echo "  sudo systemctl status dashboard-ws"
echo "  journalctl -u dashboard-ws -f"
echo "  curl http://localhost${APP_BASE_PATH}/health"
echo "  # servidor unificado: curl -I http://localhost/   → 302 a /dashboard/"
echo ""
