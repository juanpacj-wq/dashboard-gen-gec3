# D-121 — Preguntas y respuestas (congeladas)

> Sesión de planeación 2026-07-03. Estas respuestas son **autoritativas** para toda la
> implementación. Una vez cerradas no se reabren: si algo cambia durante la ejecución, es
> una **desviación** y se documenta en `ESTADO.md` + el commit de la etapa, no acá.
>
> Reglas de las rondas (fase 1 — descubrimiento):
> - 3 a 8 preguntas por ronda, específicas, con opciones (a/b/c…) y una recomendación
>   técnica cuando haya opinión.
> - No preguntar lo que el `CLAUDE.md` / `docs/` del subrepo ya responde.
> - Iterar hasta tener confianza alta en: scope, breakdown en etapas atómicas, riesgos y
>   criterio de éxito.

## Ronda 1

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | ¿Cómo reemplazamos el cliente HTTP en el sink? **(a)** Toggle `METER_PROTOCOL` con rollback, arquitectura idéntica al Node (mantener `meter_client.py` HTTP + factory que elige) — *recomendada, más segura*; **(b)** Reemplazo limpio, borrar HTTP/httpx/BeautifulSoup y credenciales. | **(a) Toggle con rollback**. Flag `METER_PROTOCOL` default `modbus`; se conservan `meter_client.py`, `USER_MEDIDORES` y `PSW_*` como vía de rollback sin código muerto. |
| 2 | El combo Modbus ya lo validó el Node contra HTTP (sombra 3 h, 0.00 % null). ¿Validamos también en el lado Python antes de cortar? **(a)** Script de sombra/probe Python que compara Modbus vs HTTP unas horas; **(b)** Confiar en el combo ya validado (misma red, mismos medidores) + solo smoke test — *recomendada por costo/beneficio*. | **(b) Confiar en el combo validado**. Sin etapa de sombra. Solo smoke test real (una lectura Modbus por medidor + un par de ciclos a Fabric) antes de cerrar. |
| 3 | ¿Qué librería Modbus para el cliente Python (servicio on-prem systemd de larga duración)? **(a)** `pymodbus` (`ModbusTcpClient` sync) — *madura, recomendada*; **(b)** `pyModbusTCP` (pura-Python, liviana). | **(a) pymodbus**. `ModbusTcpClient` sync + decode manual con `struct` (`>i`/`>HH`) para igualar exactamente word-order/escala del Node. |

<!-- No hicieron falta más rondas: scope, breakdown, riesgos y criterio de éxito quedaron con confianza alta. -->

## Detalles operativos confirmados

- **Combo Modbus reutilizado tal cual** (validado por el Node, `docs/combo-modbus-ion8650.md`):
  registro **40204** → offset PDU **203** (`register − 40001`), count **2**, **FC03**
  `read_holding_registers`, decode **int32 con signo**, word order **high** (big-endian ABCD),
  escala **/1000**, unit id **1**, puerto **502**. No se re-descubre.
- **Contrato de salida idéntico**: `fetch_kw_total()` devuelve `{"kw": float, "fetched_at": iso-UTC,
  "latency_ms": int}` con `kw` en **kilowatts SIN signo aplicado** (cero y negativos válidos). La suma
  por unidad y la inversión de signo por frontera siguen ocurriendo aguas arriba (`meter_poller.py` +
  `sign_convention.py`), sin cambios.
- **Destino Fabric intacto**: mismo esquema Delta, columna histórica `ge32` (sin C), valores en kW
  (`uom='KW'`), buffer rotativo overwrite. `fabric_writer.py`, `service.py`, `sign_convention.py` NO se tocan.
- **Unit id global = 1** para los 5 medidores (así corre producción). El override por medidor
  (`MB_UNIT_<ip_env>` del Node) queda documentado como punto de extensión, no se implementa ahora.
- **Validación fail-fast protocol-aware**: con `modbus` solo se exigen los `IP_*`; `USER_MEDIDORES`/`PSW_*`
  solo se exigen si `METER_PROTOCOL=http`.
- **D-NNN**: `D-121` (secuencial en `../docs/decisions.md`, tras D-120). Rama: `feat/fabric-sink-modbus-2026-07`.
