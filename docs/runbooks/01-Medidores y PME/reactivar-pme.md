# Reactivar el fallback PME (deshabilitado por default desde D-120)

**Qué hace:** vuelve a encender el `PMEScraper` (Playwright + Chromium con login a
`gpme.gecelca.com.co`) como fallback hot-standby de los medidores. Desde D-120 el
fallback está **apagado por default**: el server no instancia el scraper y la
extracción de potencia corre solo con los medidores (Modbus TCP).

## Cuándo usarlo

- Problema sostenido con Modbus Y con HTTP en varios medidores a la vez (LAN de
  medidores inestable) donde se necesita la fuente secundaria mientras se repara.
- Diagnóstico comparativo puntual contra el diagrama de balance del PME.

## Pasos (en el server, Ubuntu)

1. Edita el `.env` del servicio (`/var/www/dashboard-gen/server/.env`):

   ```bash
   PME_ENABLED=1
   PME_USER=<usuario>
   PME_PASSWORD=<password>    # obligatoria con el flag encendido (fail-fast en arranque)
   # PME_LOGIN_URL / PME_DIAGRAM_URL solo si difieren de los defaults de config.js
   ```

2. Verifica que el Chromium de Playwright está instalado (el deploy lo instala siempre;
   esto es solo por si se limpió a mano):

   ```bash
   cd /var/www/dashboard-gen/server && npx playwright install chromium
   ```

3. Reinicia el servicio:

   ```bash
   sudo systemctl restart dashboard-ws
   ```

4. Verifica el log de arranque:

   ```bash
   journalctl -u dashboard-ws -n 50 --no-pager | grep -i "Fallback PME"
   # → [Server] Fallback PME: HABILITADO (PME_ENABLED=1)
   ```

5. Verifica el estado del scraper:

   ```bash
   curl -s http://localhost:3001/health | jq '.pme.pmeEnabled, .pme.pme'
   # → true, y el objeto anidado del scraper deja de ser null
   ```

   La conmutación meter↔pme vuelve a operar como en D-116 (ver
   `orchestrator-fuente.md` y `pme-scraper.md`).

## Volver a apagarlo

`PME_ENABLED=` (vacío o quitar la línea) + `sudo systemctl restart dashboard-ws`.
Verifica que el log diga `Fallback PME: DESHABILITADO` y que no quede ningún proceso
de Chromium (`ps aux | grep -i chrom`).

## Referencias

- ADR **D-120** en `docs/decisions.md` (decisión y consecuencias).
- Alertas sin fallback: `orchestrator:meterDown:GLOBAL` en `../observability.md`.
- Rollback del protocolo primario (independiente de este flag): `cutover-modbus.md`.
