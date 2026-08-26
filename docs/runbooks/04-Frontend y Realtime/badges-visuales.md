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

> **D-126:** el badge ámbar **"PME" ya no existe** — el fallback se retiró y `source` solo
> puede ser `"meter"` o `null`. El único badge posible es "MEDIDOR" verde.

- 🟢 4 cards con **"MEDIDOR" verde** → estado ideal, todos los meters sirviendo.
- 🟡 Sin badge en alguna card durante los primeros 5-10 seg post-load → warming up,
  todavía no hay decisión del orchestrator. Debería aparecer en breve.
- 🟡 Card sin badge pero **con valor** → carry-forward activo (D-116): el medidor dio null
  y se está reteniendo el último valor bueno. Transitorio; cruzar con
  `01-Medidores y PME/orchestrator-fuente.md` (`holding: true`).
- 🔴 **Ningún badge** después de 30s → el frontend no está recibiendo `units[].source`.
  Probable: el bundle viejo está cacheado en el browser o el build no se desplegó.
- 🔴 Aparece un badge **"PME" ámbar** → el bundle desplegado es **anterior a D-126**.
  Verificar la versión del build y redesplegar; el backend ya no emite `source: "pme"`.

## Verificación cruzada

El badge UI debe coincidir con `/health.pme.perUnit[id].source` (la llave `pme` del health
es el nombre histórico del estado del extractor, no el scraper retirado):

```bash
# Server
curl -s http://localhost:3001/health \
  | jq '.pme.perUnit | to_entries[] | "\(.key): \(.value.source)"'
```

Si UI dice "MEDIDOR" → `source: "meter"` en el JSON.
Si la card no tiene badge → `source: null` (warming) en el JSON.

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
