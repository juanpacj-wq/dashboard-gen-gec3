# Invariante de generación — verificar, corregir y auditar (D-125)

**Para qué:** confirmar que la BD cumple la invariante de dominio —**la generación nunca es
negativa y la desviación nunca baja de −100 %**— y corregirla si no. Usa dos scripts
standalone: `verify-invariants.js` (diagnóstico, no escribe) y `backfill-d125.js` (corrección
auditable, dry-run por defecto).

## Por qué existe la invariante

Los medidores ION8650 de Gecelca están en **frontera de entrada**: con la unidad parada
consumiendo auxiliares, el valor canónico queda negativo (≈ −14,7 MW en GEC32). Eso es
físicamente correcto y la inversión de signo del `meterPoller` está bien
(`server/SIGN_CONVENTION.md`). Lo que no es correcto es que ese negativo se propague como
*generación*: se integra como MWh negativos y hunde la desviación por debajo de −100 %, que no
tiene sentido físico — no se puede dejar de generar más que todo lo despachado.

El caso testigo: **GEC32, 2026-07-30, periodo 8**. Con `generacion_mwh = −14,79` contra un
despacho final de 35 MW, `desviacion_periodos` guardaba **−142,27 %**, mientras
`proyeccion_periodos` —escrita en el mismo callback— decía **−100**. En pantalla se veía
`GENERACION 0.0` al lado de `DESVIACION −142 %`. Detalle completo en `docs/decisions.md`
**D-125**.

## Diagnóstico: `verify-invariants.js`

Escanea las 6 tablas del esquema `dashboard` y **no escribe nada**. Sale con código `1` si
encuentra violaciones, así que se puede encadenar.

### En el server (Ubuntu)

```bash
cd /var/www/dashboard-gen/server
sudo node --env-file=.env scripts/verify-invariants.js
```

> El `.env` del server vive en `server/.env`, **no** en la raíz del repo como en local.

### En local (PowerShell)

```powershell
Push-Location "dashboard-gen-gec3\server"
node --env-file=..\.env scripts\verify-invariants.js
Pop-Location
```

### Esperado

```
=== Verificación de invariantes D-125 ===
BD: PortalG3 @ 192.168.17.20\mssqlg3
Pisos: generación >= 0 · desviación >= -100

✔ generacion_periodos    sin violaciones
✔ generacion_acumulado   sin violaciones
✔ desviacion_periodos    sin violaciones
✔ proyeccion_periodos    sin violaciones
✔ proyeccion_actual      sin violaciones
✔ proyeccion_historico   sin violaciones

Total: 0 fila(s) en violación · 0 celda(s) a corregir
```

### Interpretación

- 🟢 `Total: 0` y exit code `0` → la invariante se cumple. Con las CHECK constraints activas,
  este es el único resultado posible.
- 🔴 Cualquier violación → la instancia no tiene las constraints puestas, o corrió con código
  anterior a D-125. Seguí con el backfill.
- **Filas vs celdas:** una fila de `proyeccion_historico` puede violar `acumulado_mwh`,
  `proyeccion_mwh` y `current_mw` a la vez. El reporte separa las dos cifras a propósito.

## Corrección: `backfill-d125.js`

**Dry-run por defecto** — sin `--apply` no escribe absolutamente nada, ni siquiera crea la
tabla de auditoría. Flags: `--apply`, `--verbose` (20 filas de muestra en vez de 5).

```bash
cd /var/www/dashboard-gen/server
sudo node --env-file=.env scripts/backfill-d125.js              # dry-run: revisar
sudo node --env-file=.env scripts/backfill-d125.js --apply
```

Es **idempotente**: los WHERE son `< 0` / `< -100`, así que una segunda corrida reporta 0
celdas. Corre en lotes de 5.000 filas en autocommit para no inflar el log de transacciones ni
bloquear las tablas que el servicio escribe en vivo.

En `desviacion_periodos` no solo clampa: después de llevar `generacion_mwh` a 0 **recalcula**
`desviacion_pct` desde su denominador real (`desp_final_mw`), para que la fila quede coherente.
Con denominador > 0 queda en `-100`; sin denominador queda en `NULL`, que es un estado válido
del dominio (periodo sin despacho final) y la UI pinta como `–`.

## Orden obligatorio en una instancia nueva

**No es el orden de los commits.** Una CHECK constraint sobre datos sucios falla.

1. **Desplegar el código y reiniciar** (`sudo /var/www/dashboard-gen/deploy/update.sh`). El
   extractor deja de producir negativos. Las constraints intentan crearse y fallan — queda
   logueado y tolerado, el servicio sigue vivo.
2. `verify-invariants.js` → registrar el alcance del "antes".
3. `backfill-d125.js` (dry-run) → revisar que el total cuadre con el paso 2.
4. `backfill-d125.js --apply`.
5. `verify-invariants.js` → tiene que dar **0**.
6. **Reiniciar de nuevo** (`sudo systemctl restart dashboard-ws`) → ahora sí las constraints
   entran.
7. `curl -s http://localhost:3001/health/detailed` → `invariantes.ok === true`.

El paso 6 es fácil de olvidar: las constraints se crean en `initDB()`, o sea **en el arranque
del servicio**, no cuando corre el backfill.

## Recuperar un valor original

Nada se sobrescribió sin dejar rastro: la corrección y su fila de auditoría van en la **misma
sentencia atómica**. Consultar `dashboard.correccion_d125`:

```sql
-- Resumen de lo corregido
SELECT tabla, columna, COUNT(*) AS celdas, MIN(valor_antes) AS peor
FROM dashboard.correccion_d125
GROUP BY tabla, columna ORDER BY tabla, columna;

-- El valor original de una celda concreta
SELECT columna, valor_antes, valor_despues, motivo, aplicado_en
FROM dashboard.correccion_d125
WHERE tabla = 'desviacion_periodos'
  AND unit_id = 'GEC32' AND fecha = '2026-07-30' AND periodo = 8;
```

`periodo` está normalizado a **1-24** en toda la auditoría, incluso para las tablas
`generacion_*`, que internamente guardan `hora` 0-23 (ahí se registró `hora + 1`).

## Si `/health/detailed` reporta `invariantes.ok = false`

```bash
curl -s http://localhost:3001/health/detailed | grep -o '"invariantes":{[^}]*}'
sudo journalctl -u dashboard-ws -n 100 --no-pager | grep "D-125"
```

`constraintsFaltantes` trae los nombres de las que no están. El log dice por qué falló cada
una. Causa típica: la tabla todavía tiene filas que violan la invariante → correr el backfill y
**reiniciar** (paso 6 de arriba).

Que el servicio esté vivo con `ok: false` es **por diseño**: un `initDB()` que tumba el arranque
convertiría un problema de datos en una caída total del dashboard (la lección del crash-loop de
`modbus-serial` del 2026-07-04). Pero es un estado degradado, no aceptable de forma permanente:
sin constraints, la invariante depende otra vez de que todo call-site se acuerde de clampar.

## Nota de red

La instancia `192.168.17.20\mssqlg3` **no es alcanzable desde el sandbox de red** de las
herramientas de Claude Code. Cualquier llamada a Bash/PowerShell que toque la BD necesita
`dangerouslyDisableSandbox: true`. Un `Failed to connect ... in 15000ms` desde ahí es el
sandbox, no la red.
