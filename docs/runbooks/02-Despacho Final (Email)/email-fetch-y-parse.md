# Fetch + parse de correos de Redespacho

**Verifica:** los dos servicios `EmailDispatchService` (GEC + TGJ) están
conectándose a Microsoft Graph, listando correos del mailbox y parseando los
valores MW correctamente.

## Cuándo correrlo

- Tras cada deploy.
- Si la fila "Despacho Final" del dashboard muestra menos ✉ de lo esperado.
- Si en `/health` aparece `emailDispatch.{gec,tgj}.stale: true`.

## En el server (Ubuntu)

```bash
# Fetch + parse del último ciclo (los logs salen cada 5 min)
sudo journalctl -u dashboard-ws --since "10 minutes ago" \
  | grep -E '\[EmailDispatch:|\[Parse\]|\[Row\]|registros guardados' \
  | tail -50
```

## En local (PowerShell)

```powershell
# Si tenés el server local corriendo
Get-Content "$env:TEMP\m4-server*.log" -Tail 50 `
  | Select-String -Pattern "EmailDispatch:|\[Parse\]|registros guardados"
```

## Esperado

Al menos un ciclo reciente debería tener:

```
[EmailDispatch:GEC3,GEC32] N correos encontrados
 - Redespacho Periodo X del día DD/MM/YYYY de GECELCA 32, GECELCA 3 | ...
[Parse] Subject: Redespacho Periodo X ... | Match: Periodo X del día DD/MM/YYYY
[Row] GECELCA 32  0.00  0.00 → numbers: ['32','0.00','0.00']
[Row] GECELCA 3   0.00  0.00 → numbers: ['3','0.00','0.00']
[Parse] Resultado: [
  { unitId: 'GEC32', periodo: X, valorMw: 0 },
  { unitId: 'GEC3',  periodo: X, valorMw: 0 }
]
[EmailDispatch:GEC3,GEC32] N registros guardados desde correos

[EmailDispatch:TGJ1,TGJ2] N correos encontrados
[Parse] ... GUAJIRA 2, GUAJIRA 1 ...
[Row] GUAJIRA 1  145.00  145.00 → ...
[Row] GUAJIRA 2  130.00  130.00 → ...
[EmailDispatch:TGJ1,TGJ2] N registros guardados desde correos
```

## Interpretación

- 🟢 Para ambos servicios (`GEC3,GEC32` y `TGJ1,TGJ2`) aparecen las 3 líneas:
  "N correos encontrados", "[Parse] Resultado: [...]" no vacío, "N registros guardados".
- 🟡 "0 correos encontrados" → puede ser normal si el operador no envió aún
  (P2/P3 a veces faltan). Cruzar con `99-Diagnostico/probe-emails.md`.
- 🔴 `Variables GRAPH_* no configuradas, omitiendo` para TGJ → falta
  `GRAPH_MAILBOXTEG` en `.env`. **Caso real visto en producción** —
  agregar al `.env` y reiniciar.
- 🔴 `Error leyendo correos: Graph API error: 503` → transient de Microsoft;
  un solo error es OK. Si persiste varios ciclos, hay problema de
  permisos/tenant.
- 🔴 `[Parse] Resultado: []` repetido para TGJ pero con `[Row]` ausente → el
  body del email no contiene "GUAJIRA 1" / "GUAJIRA 2" como se espera.
  Investigar con `99-Diagnostico/probe-emails.md`.

## Si falla

```bash
# Verificar variables GRAPH_*
sudo cat /var/www/dashboard-gen/server/.env | grep -E '^(GRAPH_|MAILBOX)'

# Esperado: las 5 variables (GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET,
# GRAPH_MAILBOX, GRAPH_MAILBOXTEG) presentes.

# Verificar el filtro Graph directamente con el script probe
cd /var/www/dashboard-gen/server
node --env-file=../.env scripts/probe-emails.js
```

Ver `99-Diagnostico/probe-emails.md` para análisis detallado del mailbox.
