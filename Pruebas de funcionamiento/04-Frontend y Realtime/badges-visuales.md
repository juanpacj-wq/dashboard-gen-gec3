# Badges visuales MEDIDOR/PME en cards

**Verifica:** la mini-feature M1+M2+M3 — cada `UnitCard` muestra un badge
indicando de qué fuente proviene la lectura: "MEDIDOR" verde si el medidor
ION8650 está sirviendo, "PME" ámbar si el orchestrator hizo fallback al
scraper Playwright.

## Cuándo correrlo

- Tras deploy de los commits M1/M2/M3 (06c5fed, 05ae543, 0ca074e).
- Como verificación rápida visual del estado del orchestrator.
- Si una unidad reporta inconsistencias en el dashboard.

## Test (puramente visual)

1. Abrir el dashboard (prod: `http://192.168.17.65/` ; local: `http://localhost:5173/`).
2. Esperar ~5 segundos para que cargue el primer broadcast WS.
3. Mirar las 4 cards de unidades en la barra superior (GEC3, GEC32, TGJ1, TGJ2).
4. Cada card debe mostrar un **badge pequeño** a la derecha del id de unidad.

## Esperado (estado normal)

Las 4 cards muestran:
- Texto: **"MEDIDOR"**
- Color: verde (`#00d4aa`)
- Fondo: verde tenue translúcido

```
┌──────────────────────────────────────┐
│ ● TGJ1   [MEDIDOR]                   │
│   CAPAIns - 145 MW            +0.7%  │
└──────────────────────────────────────┘
```

Cuando una card está **seleccionada**, también aparece el badge "SELECCIONADA"
a la derecha:
```
┌──────────────────────────────────────────────────┐
│ ● TGJ2  [MEDIDOR]              [SELECCIONADA]    │
│   Capacidad Instalada - 130 MW                   │
└──────────────────────────────────────────────────┘
```

## Estados alternativos

- 🟢 4 cards con **"MEDIDOR" verde** → estado ideal, todos los meters sirviendo.
- 🟡 1+ cards con **"PME" ámbar** (color `#f59e0b`) → fallback activo. La card
  sigue funcionando pero está leyendo del scraper, no del medidor físico. Es
  comportamiento correcto del hot-standby — investigar el meter caído con
  `01-Medidores y PME/conectividad-medidores.md`.
- 🟡 Sin badge en alguna card durante los primeros 5-10 seg post-load → warming up,
  todavía no hay decisión del orchestrator. Debería aparecer en breve.
- 🔴 **Ningún badge** después de 30s → el frontend no está recibiendo `units[].source`.
  Probable: el bundle viejo está cacheado en el browser o M1 no se desplegó.
- 🔴 Badge dice "MEDIDOR" pero los logs muestran que la unidad cayó a PME
  → desincronización. Verificar `04-Frontend y Realtime/snapshots-refetch.md`
  y refrescar con Ctrl+Shift+R.

## Verificación cruzada

El badge UI debe coincidir con `/health.pme.perUnit[id].source`:

```bash
# Server
curl -s http://localhost:3001/health \
  | jq '.pme.perUnit | to_entries[] | "\(.key): \(.value.source)"'
```

Si UI dice "MEDIDOR" → `source: "meter"` en el JSON.
Si UI dice "PME" → `source: "pme"` en el JSON.

## Si falla

```bash
# Forzar refresh sin caché en el browser:
# Chrome/Edge: Ctrl+Shift+R
# Firefox: Ctrl+F5

# Si tras Ctrl+Shift+R sigue sin badge, verificar el bundle:
ls /var/www/dashboard-gen/dist/assets/index-*.js  # debe ser hash post-deploy
```

Si el bundle es viejo, falta `npm run build` post-`git pull`. Ver
`05-Servicio y Deploy/deploy-rollback.md`.
