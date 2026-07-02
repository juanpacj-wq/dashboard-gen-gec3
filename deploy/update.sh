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

# Identidad primero: sin instance/config.json el frontend cae al default (gec3), que en el
# servidor de Guajira es la instancia EQUIVOCADA. Fail-fast con la instrucción de siembra.
if [ ! -f "$APP_DIR/instance/config.json" ]; then
  echo "ERROR: falta $APP_DIR/instance/config.json (identidad de la instancia)." >&2
  echo "  Sembrarla UNA vez:  sudo mkdir -p $APP_DIR/instance && sudo cp $APP_DIR/deploy/config.<instancia>.json $APP_DIR/instance/config.json" >&2
  exit 1
fi

# El script corre como root (sudo) pero el repo puede tener otro dueño → git rechazaría
# operar con "dubious ownership". Registrarlo como seguro es idempotente.
git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" \
  || git config --global --add safe.directory "$APP_DIR"

echo "== Actualizando dashboard en $APP_DIR =="
git pull --ff-only

echo "== Build frontend =="
npm ci
# Sub-path de despliegue POR-SERVIDOR: se lee de server/.env (APP_BASE_PATH). El servidor
# unificado gecelca3 (convive con Bitácora) lo pone en /dashboard; un despliegue root (incl.
# Guajira) lo deja vacío → build en la raíz '/'. El MISMO script sirve ambos sin hardcodear la ruta.
APP_BASE_PATH="$(grep -E '^APP_BASE_PATH=' "$APP_DIR/server/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
export APP_BASE_PATH

# Guard anti-drift: si el nginx instalado sirve el app namespaced bajo /dashboard pero
# server/.env no declara APP_BASE_PATH, el build saldría en la raíz '/' y rompería todos los
# assets/api bajo /dashboard/. Fail-fast con la corrección exacta en vez de romper silencioso.
if [ -z "$APP_BASE_PATH" ] \
   && grep -qs 'location /dashboard/' /etc/nginx/sites-enabled/dashboard-gen /etc/nginx/sites-available/dashboard-gen; then
  echo "ERROR: nginx sirve este app bajo /dashboard/ pero server/.env no tiene APP_BASE_PATH." >&2
  echo "  Corregir UNA vez:  echo 'APP_BASE_PATH=/dashboard' | sudo tee -a $APP_DIR/server/.env" >&2
  echo "  y volver a correr update.sh." >&2
  exit 1
fi
echo "   base del build: '${APP_BASE_PATH:-/}'"
npm run build

echo "== Deps del servidor =="
cd server
npm ci

# Chromium es para el fallback PME, NO la fuente primaria (el medidor ION8650 lo es, D-116).
# Por eso su instalación NUNCA debe tumbar el deploy: si falla (p. ej. red corporativa con TLS
# interceptado → SELF_SIGNED_CERT_IN_CHAIN), avisamos y seguimos. Se instala en la MISMA ruta
# que server/.env (PLAYWRIGHT_BROWSERS_PATH) para que www-data pueda leer el navegador.
PW_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$APP_DIR/.ms-playwright}"
if PLAYWRIGHT_BROWSERS_PATH="$PW_BROWSERS_PATH" npx playwright install chromium; then
  chmod -R a+rX "$PW_BROWSERS_PATH" 2>/dev/null || true
else
  echo "WARN: no se pudo instalar/actualizar Chromium (fallback PME). El deploy continúa: el" >&2
  echo "      medidor es la fuente primaria. Si la red corporativa intercepta TLS, instalalo con" >&2
  echo "      NODE_EXTRA_CA_CERTS=<CA-corp> (o NODE_TLS_REJECT_UNAUTHORIZED=0 como último recurso)." >&2
fi

echo "== Reiniciando servicio =="
sudo systemctl restart dashboard-ws

# NOTA: este script NO sincroniza nginx.conf. El deploy/nginx.conf del repo corresponde al
# SERVIDOR UNIFICADO (namespaced /dashboard + placeholder de /bitacora); Guajira usa su propio
# nginx (root). Aplicar nginx es un paso manual y por-servidor (ver CLAUDE.md / DEPLOY-*.md):
#   sudo cp deploy/nginx.conf /etc/nginx/sites-available/dashboard-gen && sudo nginx -t && sudo systemctl reload nginx

BASE="${APP_BASE_PATH:-}"
echo "== Listo. Instancia actual: $(cat "$APP_DIR/instance/config.json" 2>/dev/null | grep -o '"instance"[^,]*' || echo 'desconocida') =="
echo "   Verificar: curl -s http://localhost${BASE}/health && curl -s http://localhost${BASE}/config.json"
