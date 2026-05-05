import os

# Tests no necesitan IPs/passwords reales. Saltar la validación fail-fast de
# config.py para que `from src.config import UNITS` funcione en CI sin un
# `.env` poblado.
os.environ.setdefault("CONFIG_SKIP_VALIDATION", "1")
