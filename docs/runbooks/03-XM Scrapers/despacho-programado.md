# Despacho programado (dDEC)

**Verifica:** el `DespachoscraperService` está bajando el archivo
`dDECMMDD_TIES.txt` del portal de XM, parseando los 24 valores horarios para
GEC3, GEC32, TGJ1, TGJ2, y exponiéndolos vía REST.

## Cuándo correrlo

- Tras deploy.
- Si la fila "Despacho" del dashboard muestra valores raros o todos a 0.
- Cada mañana después de las 04:00 Bogotá (cuando XM publica el archivo).

## En el server (Ubuntu)

```bash
# Endpoint REST
curl -s http://localhost:3001/api/despacho/today | jq 'keys, (.GEC3 | length)'

# Logs del scraper
sudo journalctl -u dashboard-ws --since "1 hour ago" \
  | grep -E '\[DespScraper\]' | tail -10
```

## En local (PowerShell)

```powershell
$resp = (Invoke-WebRequest -Uri http://localhost:3001/api/despacho/today -UseBasicParsing).Content | ConvertFrom-Json
$resp | Get-Member -MemberType NoteProperty | Select-Object Name
"GEC3 length: $($resp.GEC3.Count)"
"TGJ1 length: $($resp.TGJ1.Count)"
```

## Esperado

```json
[ "GEC3", "GEC32", "TGJ1", "TGJ2" ]
24
```

Cada unidad con array de 24 valores numéricos (uno por hora del día).

Logs:
```
[DespScraper] Nuevo día YYYY-MM-DD — buscando archivo de despacho
[DespScraper] Consultando: Energia y Mercado/DESPACHO/TIES/Despachos/YYYY-MM/dDECMMDD_TIES.txt
[DespScraper] Archivo encontrado y cargado para YYYY-MM-DD
[DespScraper] Datos persistidos en DB para YYYY-MM-DD
```

## Interpretación

- 🟢 Las 4 keys presentes, cada una con array de 24 elementos numéricos.
- 🟡 Antes de las 04:00 Bogotá puede no estar publicado aún. Logs mostrarán
  `[DespScraper] Archivo de hoy no disponible aún (HTTP 500/404)` y el
  servicio reintentará cada 5 min.
- 🔴 Endpoint devuelve `{}` o falta alguna unidad → scraper nunca encontró el
  archivo (problema con XM portal o conectividad).
- 🔴 Logs con `Reintentando en 5s` indefinidamente → revisar conectividad a
  `api-portalxm.xm.com.co`.

## Si falla

```bash
# Forzar conexión al portal XM
curl -I https://api-portalxm.xm.com.co/

# Si responde 200, el scraper retomará al próximo intervalo (5 min).
# Si no responde, el problema está en la red corporativa de Gecelca al portal XM.

# Ver fallback desde DB (si el scraper persistió antes):
curl -s http://localhost:3001/api/despacho/today | jq '.GEC3[0:3]'
```

El servicio carga desde DB como fallback si el scraper no consigue el archivo
nuevo. Eso significa que el dashboard puede mostrar valores del día anterior
hasta que el scraper recupere — verificable comparando con la fecha del archivo.
