# Redespacho (rDEC) y ticker nacional

**Verifica:** el `RedespachoscraperService` está bajando `rDECMMDD.txt` del
portal XM cada 5 min, parseando tanto las 4 unidades de Gecelca como las
~530 plantas nacionales que alimentan el ticker del top 10.

## Cuándo correrlo

- Tras deploy.
- Si la fila "Proyeccion Despacho" del dashboard se desactualiza durante el día
  (debería cambiar cuando hay redespachos).
- Si el ticker inferior del dashboard no muestra plantas o muestra "SIMULADO".

## En el server (Ubuntu)

```bash
# Redespacho de nuestras 4 unidades
curl -s http://localhost:3001/api/redespacho/today | jq 'keys, (.GEC3 | length)'

# Plantas nacionales (para ticker)
curl -s http://localhost:3001/api/redespacho/national | jq 'length, .[0:3]'

# Logs del scraper
sudo journalctl -u dashboard-ws --since "10 minutes ago" \
  | grep -E '\[RedespScraper\]' | tail -10
```

## En local (PowerShell)

```powershell
$mine = (Invoke-WebRequest -Uri http://localhost:3001/api/redespacho/today -UseBasicParsing).Content | ConvertFrom-Json
"Mis unidades: $($mine | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name)"

$nat = (Invoke-WebRequest -Uri http://localhost:3001/api/redespacho/national -UseBasicParsing).Content | ConvertFrom-Json
"Plantas nacionales: $($nat.Count)"
$nat[0..2] | Format-List
```

## Esperado

`/api/redespacho/today`:
```json
[ "GEC3", "GEC32", "TGJ1", "TGJ2" ]
24
```

`/api/redespacho/national`:
```json
533     // o número similar (~530 plantas activas)
[
  { "code": "SOG1", "name": "SOGAMOSO",  "values": [819, 819, ...] },
  { "code": "CHVR", "name": "CHIVOR",    "values": [584, 584, ...] },
  ...
]
```

Logs:
```
[RedespScraper] Consultando: M:/InformacionAgentes/Usuarios/Publico/Redespacho/YYYY-MM/rDEC0504.txt
[RedespScraper] Datos cargados: GEC3, GEC32, TGJ1, TGJ2 | 533 plantas nacionales
[RedespScraper] Servicio iniciado — intervalo 300s
```

## Interpretación

- 🟢 4 unidades con 24 valores cada una + ~530 plantas nacionales.
- 🟢 Tras un redespacho, los valores de un periodo cambian respecto al primer
  fetch del día (verificable comparando "Despacho" vs "Proyeccion Despacho" en
  el dashboard).
- 🟡 `length: 0` plantas nacionales → el archivo se descargó pero no parseó
  correctamente; el ticker mostrará "SIMULADO". Investigar formato del archivo.
- 🔴 Endpoints devuelven `{}` y `[]` simultáneamente → scraper roto o portal XM
  inalcanzable. Mismo troubleshoot que `despacho-programado.md`.

## Auditoría de cambios (redespacho_historico)

```bash
# Las modificaciones a redespacho durante el día se loggean en redespacho_historico
# Útil cuando el operador pregunta "¿cuándo cambió este valor?"
node -e "
import('mssql').then(async sql => {
  const cfg = {
    server: process.env.DB_HOST.split('\\\\')[0],
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: {
      instanceName: process.env.DB_HOST.includes('\\\\') ? process.env.DB_HOST.split('\\\\')[1] : undefined,
      trustServerCertificate: true,
    },
  };
  const pool = await sql.default.connect(cfg);
  const r = await pool.request().query(\`
    SELECT TOP 20 unit_id, periodo, valor_mw_prev, valor_mw_new, version, detected_at
    FROM dashboard.redespacho_historico
    WHERE fecha = CAST(GETDATE() AS DATE)
    ORDER BY detected_at DESC
  \`);
  for (const row of r.recordset) console.log(row);
  await pool.close();
});
" 
```

(Ejecutar desde `dashboard-gen-gec3/server/` con `node --env-file=../.env -e ...`).

## Si falla

```bash
# El path M:/ es un share de red. Si el server no lo monta, el scraper falla.
ls /mnt/M/InformacionAgentes/Usuarios/Publico/Redespacho/ 2>/dev/null || echo "Share no montado"

# Manualmente forzar refresh: reinicia el servicio
sudo systemctl restart dashboard-ws
```
