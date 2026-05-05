#!/usr/bin/env bash
# Instalador idempotente de Fabric Meter Sink en Linux.
#
# Asume que el código ya está copiado a INSTALL_DIR (ej. vía rsync, git, scp).
# El script crea el venv, el usuario de sistema, los directorios runtime,
# y registra la unit de systemd.
#
# Uso:
#   sudo /opt/fabric-meter-sink/deploy/install.sh

set -euo pipefail

INSTALL_DIR="/opt/fabric-meter-sink"
SERVICE_USER="fabric-sink"
SERVICE_GROUP="fabric-sink"
SERVICE_FILE="fabric-meter-sink.service"
RUNTIME_DIR="/var/run/fabric-meter-sink"
LOG_DIR="${INSTALL_DIR}/logs"

# ─── Pre-requisitos ──────────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: este script debe correr como root (usa sudo)." >&2
    exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 no está instalado. Instalalo con tu package manager." >&2
    exit 1
fi

PY_VERSION=$(python3 -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')")
PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)
if (( PY_MAJOR < 3 )) || { (( PY_MAJOR == 3 )) && (( PY_MINOR < 10 )); }; then
    echo "ERROR: Python ${PY_VERSION} es muy viejo, se requiere ≥ 3.10." >&2
    exit 1
fi

if [[ ! -d "$INSTALL_DIR" ]]; then
    echo "ERROR: $INSTALL_DIR no existe." >&2
    echo "       Copiá el código a $INSTALL_DIR primero (rsync/git clone/scp), después correr este script." >&2
    exit 1
fi

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
    echo "ERROR: $INSTALL_DIR/.env no existe." >&2
    echo "       Copiá $INSTALL_DIR/.env.example a $INSTALL_DIR/.env y rellená credenciales reales." >&2
    exit 1
fi

# ─── Usuario de sistema ──────────────────────────────────────────────────────

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    echo "Creando usuario de sistema: $SERVICE_USER"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
else
    echo "Usuario $SERVICE_USER ya existe — OK"
fi

# ─── Venv + install ──────────────────────────────────────────────────────────

if [[ ! -d "$INSTALL_DIR/.venv" ]]; then
    echo "Creando venv en $INSTALL_DIR/.venv"
    python3 -m venv "$INSTALL_DIR/.venv"
fi

echo "Instalando dependencias del proyecto..."
"$INSTALL_DIR/.venv/bin/pip" install --quiet --upgrade pip
"$INSTALL_DIR/.venv/bin/pip" install --quiet -e "$INSTALL_DIR"

# ─── Directorios runtime ─────────────────────────────────────────────────────

echo "Configurando directorios runtime..."
mkdir -p "$RUNTIME_DIR"
chown "$SERVICE_USER:$SERVICE_GROUP" "$RUNTIME_DIR"

mkdir -p "$LOG_DIR"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR"

# .env contiene secretos (CLIENT_SECRET) — restringir lectura.
chmod 640 "$INSTALL_DIR/.env"

# ─── systemd ─────────────────────────────────────────────────────────────────

echo "Instalando unit de systemd..."
cp "$INSTALL_DIR/deploy/$SERVICE_FILE" "/etc/systemd/system/$SERVICE_FILE"
chmod 644 "/etc/systemd/system/$SERVICE_FILE"

systemctl daemon-reload
systemctl enable "$SERVICE_FILE"

cat <<EOF

✓ Instalación completa.

Próximos pasos:
  sudo systemctl start fabric-meter-sink
  sudo systemctl status fabric-meter-sink
  sudo journalctl -u fabric-meter-sink -f

Verificar heartbeat (debe actualizarse cada ~15 s):
  stat $RUNTIME_DIR/heartbeat

Logs rotativos en disco:
  ls -lh $LOG_DIR/

EOF
