# Corrección — Carry-forward de medidor con TTL (fix valle de Desviación %)

> **Especificación ejecutable.** Abrir sesión en `dashboard-gen-gec3/`.
> Los números de línea son orientativos (el archivo cambió tras agregar el `DeviationTracer`);
> usar los anclajes de código citados (nombres de función / strings distintivos) para localizar.
>
> **Alcance: las 4 unidades (GEC3, GEC32, TGJ1, TGJ2).** El fix vive en el
> `ExtractorOrchestrator`, cuya máquina de estados ya corre **por unidad** (`#unitState` es un
> `Map` con una entrada por unidad; `#tick()` itera `for (const unit of this.#units)`). Todo lo
> que se agrega es per-unit y uniforme. Se diagnosticó con GEC32 porque despacha todo el día,
> pero el camino de código es el mismo para las cuatro. La única diferencia entre unidades
> sigue siendo la ya existente (GEC3/GEC32 son `frontierType:'input'` con inversión de signo;
> Guajiras son `'output'`), y es ortogonal al carry-forward: el valor retenido es el último
> `valueMW` bueno **ya post-inversión**.

## Contexto y causa raíz

El chart de Desviación % muestra valles verticales profundos (ej. −78%) en minutos aislados,
físicamente imposibles. Se instrumentó un `DeviationTracer` (ya mergeado) que capturó el bug
en `server/traces/trace-GEC32-2026-05-26-11.jsonl`.

**Causa raíz (confirmada con datos):** cuando el medidor ION8650 devuelve `null` por 1-2 ticks
sueltos, el `ExtractorOrchestrator` sigue en `source='meter'` y emite `valueMW=null` (porque hoy
switchea a PME recién tras 3 errores consecutivos = 6s). Aguas abajo, ese null se convierte en
`0 MW` en tres lugares:
- `server/server.js` (broadcast): `const currentMw = unit.valueMW ?? 0`
- `server/projectionCalculator.js` (`computeLive`): `const mw = Number.isFinite(currentMw) ? Math.max(0, currentMw) : 0`
- `server/accumulator.js` (`update`): `const mw = unit.valueMW ?? 0`

Con MW=0 la proyección colapsa al puro acumulado → la desviación se hunde (ej. −78%) → ese tick
contamina el promedio del minuto en `accumulator.feedDeviation` → valle visible en `minuteDeviations`.

**Evidencia:** ticks `src=meter, cm=null, pme=249.42 (válido), proj=acum, dev=−78.77%`, flags
`nullCoercedToZero, outlierDeviation`. El PME tenía dato real disponible todo el tiempo. El bug
está presente HOY en las 4 unidades (mismo camino de código); solo se grabó GEC32 porque el
tracer estaba limitado con `TRACE_DEVIATION=GEC32`.

## Objetivo

Reemplazar el fallback meter→PME basado en conteo (3 ticks/6s) por **carry-forward del último
valor bueno del medidor** con TTL configurable (default 3 min). Mientras el TTL no expire y el
medidor entregue null/no-finito, la unidad sigue `source='meter'` emitiendo el último valor bueno
(`holding=true`). Backend-only, sin cambios de UI.

## Decisiones de diseño (confirmadas)

1. **Carry-forward con TTL = 3 min**, configurable por env `METER_HOLD_TTL_MIN` (default 3).
   Reemplaza el fallback actual de 6s/3-ticks.
2. Durante 0–3 min de medidor inválido: emitir el **último MW bueno del medidor**
   (`holding=true`), `source` sigue `'meter'`. **Prioridad sobre PME.**
3. A los 3 min con medidor aún caído: **switch a PME** (si válido) + **una sola alerta**
   "medidor caído". Si PME también inválido → `valueMW=null`. No se extiende el hold.
4. El valor retenido **reemplaza la medición en todo el pipeline** (energía + proyección).
   Bonus: arregla la sub-integración de energía del `?? 0` en el accumulator.
5. **Observabilidad veraz:** el hold NO resetea la frescura del medidor; `consecMeterErrors` y
   el reloj de meter-down siguen corriendo durante el hold.
6. **Trazabilidad (3 sinks, sin tabla DB):** campos en el health snapshot per-unit; log
   estructurado por episodio (inicio/fin); regla del alerter a 3 min. Subir el umbral viejo de
   30s a 3 min (una sola alerta).
7. **Sin cambios de UI** (no badge "retenido"; backend-only).
8. ADR nuevo = **D-116** (último existente: D-115).

---

## Cambios por archivo

### 1) `server/extractorOrchestrator.js` — corazón del cambio

**1a. Constante + constructor.** Junto a `FRESHNESS_MS`, agregar `DEFAULT_HOLD_TTL_MIN = 3`. En
el constructor aceptar `holdTtlMin = DEFAULT_HOLD_TTL_MIN` y, para tests, `holdTtlMs` directo
(gana sobre `holdTtlMin` si se pasa — precisión con fake timers). Guardar `this.#holdTtlMs`.
Mantener `fallbackThreshold`/`recoveryThreshold` en la firma por compat (ver Riesgo R2).

**1b. Estado por unidad** (init donde hoy se setea `{source, since, consecMeterErrors, consecMeterOk, justSwitched}`):
agregar `lastGoodMeter: null` (`{value, at}`), `holding: false`, `heldTicks: 0`,
`lastHoldAt: null`, `meterDownSince: null`.
`lastGoodMeter` es un store **separado** de `#meterCache` porque `#onMeterData` sobrescribe el
cache con `value:null` cuando el medidor falla.

**1c. Actualizar `lastGoodMeter` solo con válidos.** En la rama `if (meterValid)` de `#tick()`:
`state.lastGoodMeter = { value: meter.value, at: now }`. Reusar `isValid(meter, now)` (valida
freshness <30s + finito + no-null).

**1d. Nueva lógica de decisión** (reemplaza el bloque `if (prev === null) … else if (prev === 'meter') … else if (prev === 'pme')`).
Mantener intactos el cálculo de `meterValid`/`pmeValid` y la actualización de
`consecMeterOk`/`consecMeterErrors`. Pseudocódigo:

```js
const prevSource = state.source
const wasHolding  = state.holding
const ttlExpired  = state.lastGoodMeter ? (now - state.lastGoodMeter.at) >= this.#holdTtlMs : true

// reloj meter-down: corre durante el hold, el hold NO lo resetea
if (meterValid) state.meterDownSince = null
else if (state.meterDownSince === null) state.meterDownSince = now

if (meterValid) {
  if (prevSource === 'pme') {                 // recovery pme→meter: preserva recoveryThreshold (D-102)
    if (state.consecMeterOk >= this.#recoveryThreshold) { state.source='meter'; state.since=now; state.justSwitched=true }
  } else {
    if (prevSource !== 'meter') { state.source='meter'; state.since=now; state.justSwitched=true }
    else state.source='meter'
  }
  state.holding = false
}
else if (state.lastGoodMeter && !ttlExpired) {  // HOLD — prioridad sobre PME
  state.source = 'meter'
  state.holding = true
}
else {                                          // TTL expiró o sin lastGoodMeter → ceder a PME
  state.holding = false
  if (pmeValid && prevSource !== 'pme') { state.source='pme'; state.since=now; state.justSwitched=true }
  // ambas muertas: mantener source previo (value será null); conserva histéresis
}
```

**1e. Episodio de hold (log inicio/fin)** usando el helper `log()` del módulo:

```js
if (state.holding) {
  if (!wasHolding) {
    state.heldTicks = 1; state.lastHoldAt = now
    log('warn', `[${unit.id}] HOLD start — retiene ${state.lastGoodMeter.value} MW (lastGood age=${Math.round((now-state.lastGoodMeter.at)/1000)}s)`)
  } else state.heldTicks++
} else if (wasHolding) {
  const reason = meterValid ? 'meter recovered' : (pmeValid ? 'TTL→pme' : 'TTL→null')
  log('info', `[${unit.id}] HOLD end — ${state.heldTicks} ticks reason=${reason}`)
  state.heldTicks = 0
}
```

NO tocar `consecMeterErrors` aquí (observabilidad veraz).

**1f. Cálculo de `valueMW`** (reemplaza el actual):

```js
let valueMW
if (state.source === 'meter')    valueMW = meterValid ? meter.value : (state.holding ? state.lastGoodMeter.value : null)
else if (state.source === 'pme') valueMW = pmeValid ? pme.value : null
else                             valueMW = null
```

**1g. `mergedUnits.push(...)`:** agregar `holding: state.holding` (aditivo, no rompe consumidores).

**1h. `getStatus().perUnit[unitId]`:** agregar `holding`, `heldTicks`, `lastHoldAt` (ISO),
`meterDownSeconds: state.meterDownSince ? Math.floor((now - state.meterDownSince)/1000) : 0`.

**1i. `getTickSnapshot(unitId)`** (ya existe): agregar `holding`, `heldTicks`,
`lastGoodMeterValue`, `lastGoodMeterAgeMs` para el tracer.

**1j. Log de arranque:** reemplazar la mención de `fallbackThreshold` por `holdTtlMin`.

### 2) `server/accumulator.js` — null deja de integrarse

Hoy `update()` marca "tick exitoso" solo si `valueMW != null`, pero luego hace
`const mw = unit.valueMW ?? 0` e integra ese 0 (sub-integración de energía). Cambiar a SKIP real:
manteniendo las líneas que setean `#lastUpdateAt`/`#lastUnitWithValue` cuando `valueMW != null`,
**antes** de calcular `mw` agregar:

```js
if (unit.valueMW == null) continue   // D-105/D-116: null NO se integra (antes se coercía a 0 — bug)
const mw = unit.valueMW
```

Con carry-forward, null casi nunca llega (solo ambas fuentes muertas o arranque sin lastGoodMeter).
`feedDeviation` ya hace `if (deviation != null)` — sin cambios.

### 3) `server/healthSnapshot.js` y `server/alerter.js`

**3a. healthSnapshot.js:** sin cambios estructurales (copia el `getStatus()` completo del
orchestrator; los campos nuevos de `perUnit` fluyen solos). Actualizar el JSDoc.

**3b. alerter.js — regla "medidor caído" a 3 min:**
- En `DEFAULTS`/`readEnv`: agregar `ALERT_THRESH_METER_DOWN_MIN: 3`.
- Subir `ALERT_THRESH_METER_CONSEC_ERRORS` de 15 a ~90 (≈3 min a 2s/tick). Ese bloque opera
  sobre `meterPoller.perMeter`, que es no-op en prod (el orchestrator encapsula al poller) —
  subirlo es defensivo.
- Nuevo bloque en `#evaluate`, dentro del loop per-unit:

```js
const k = `orchestrator:meterDown:${u}`
const downSec = perUnit[u].meterDownSeconds ?? 0
if (downSec >= c.ALERT_THRESH_METER_DOWN_MIN * 60) {
  this.#open(k, 'WARN', {
    title: `Medidor ${u} caído ${Math.round(downSec/60)} min (carry-forward agotado)`,
    body:  `holding=${perUnit[u].holding} source=${perUnit[u].source} consecMeterErrors=${perUnit[u].consecMeterErrors}`,
  }, now)
} else this.#close(k, now, false)
```

Cooldown por `incident_key` vía `#open`. La alerta PME-persist existente coexiste como incident distinto.

### 4) `server/server.js` (broadcast) y `server/deviationTracer.js`

- En `broadcast`, dejar `const currentMw = unit.valueMW ?? 0` como defensa (con carry-forward ya
  trae el retenido). **Defensa en profundidad:** envolver el feed de desviación en
  `if (unit.valueMW != null) accumulator.feedDeviation(...)` para que un null residual (ambas
  fuentes muertas) no reintroduzca un valle.
- En el record del tracer (bloque ya existente en broadcast): agregar `holding`, `heldTicks`,
  `lastGoodMeterValue` (en `meter:{}`) y `holding` en `flags:{}`. Aditivo; `analyze.js` lo ignora
  si no lo conoce.
- `deviationTracer.js`: sin cambios (escribe lo que se le pasa).

---

## Edge cases (cubiertos por el diseño)

| Edge | Comportamiento |
|---|---|
| Arranque sin lastGoodMeter + meter null (hoy spike −82%) | `ttlExpired=true` → rama PME. PME válido → pme sin hold; PME inválido → null → accumulator `continue` + feed skip → **sin spike** |
| Meter válido, luego null <3min | HOLD con último valor bueno |
| Flapping ok/null/ok/null | cada OK resetea `lastGoodMeter.at` y `meterDownSince` → nunca acumula 3 min → sigue en meter; `consecMeterErrors` veraz |
| Ambas fuentes muertas | `valueMW=null` → accumulator `continue`, feed skip; source previo se mantiene (conserva histéresis) |
| Recovery tras switch a PME | meter válido + `consecMeterOk>=recoveryThreshold` → meter |
| Hold cruza límite de hora | valor retenido se integra normal; cierre de periodo usa `prev.lastMW` ya retenido |

---

## Estrategia de tests (vitest, `--pool=forks`)

Los tests ya usan `vi.useFakeTimers()` + `advanceTimersByTimeAsync` (vitest fakea `Date.now()`).
El TTL se controla con fake timers, sin esperar tiempo real. Exponer `holdTtlMs` en
`buildOrchestrator` y pasar un TTL corto (ej. `2*POLL_MS`) en los tests de switch.

**Casos nuevos** (`server/__tests__/extractorOrchestrator.test.js`):
1. Hold corto retiene valor (`valueMW`=último bueno, `source='meter'`, `holding=true`, `consecMeterErrors=1`).
2. Hold sostenido a través de N nulls <TTL (`heldTicks` incrementa).
3. Prioridad sobre PME: meter null + PME válido dentro de TTL → emite el retenido, no PME.
4. TTL expira → cede a PME (avanzar reloj >TTL → `source='pme'`, `holding=false`).
5. TTL expira sin PME → `valueMW=null`, `holding=false`.
6. Arranque sin lastGoodMeter: null + PME → pme directo; sin PME → null (sin spike).
7. `lastGoodMeter` solo con válidos (70, null, 71 → retiene 70, luego 71).
8. Flapping resetea TTL (nunca cae a PME).
9. Recovery con `recoveryThreshold` tras PME (preserva D-102).
10. `getStatus` expone `holding/heldTicks/lastHoldAt/meterDownSeconds`.
11. `meterDownSeconds` corre durante hold y un OK lo resetea a 0.

**Tests existentes a re-especificar** (no "rotos" — cambian de semántica): el bloque de
histéresis (3 nulls ya NO switchea — ahora retiene) y recovery. Pasarles `holdTtlMs` corto para
reproducir el switch, o reescribir aserciones. Estimado ~6-8 tests editados.

**`server/__tests__/alerter.test.js`:** nuevo `describe` "medidor caído (meterDown ≥ 3min)" con
snapshots inyectados: no dispara con `meterDownSeconds:120`; sí WARN con `200` (incidentKey
`orchestrator:meterDown:GEC3`); cooldown → 1 alerta en dos ticks.

**`server/__tests__/accumulator.test.js`:** caso "valueMW=null no altera `accumulated` ni `minuteAvgs`".

---

## Documentación

- **`.env.example`:** agregar `METER_HOLD_TTL_MIN=3` (comentario: carry-forward del último valor
  bueno durante nulls transitorios; tras TTL min sin lectura válida cede a PME, D-116) y
  `ALERT_THRESH_METER_DOWN_MIN=3`. Actualizar `ALERT_THRESH_METER_CONSEC_ERRORS` si se sube a 90.
- **`CLAUDE.md`** (sección Environment Variables): bullet de `METER_HOLD_TTL_MIN` y agregar
  `ALERT_THRESH_METER_DOWN_MIN` al bullet `ALERT_THRESH_*`.
- **`docs/decisions.md` — nuevo D-116** (formato Contexto/Decisión/Consecuencias, ADR-lite, espejo de D-115):
  - *Contexto:* nulls transitorios del ION8650 caían a 0 MW vía `?? 0` (broadcast/accumulator/computeLive)
    → proyección colapsa, contamina el minute-bucket de desviación (valle −78%); fallback de
    3-ticks/6s cedía a PME por glitches sueltos.
  - *Decisión:* carry-forward con TTL `METER_HOLD_TTL_MIN` (default 3min); `lastGoodMeter` separado
    del meterCache; hold con prioridad sobre PME; `consecMeterErrors`/reloj meter-down sin resetear
    (observabilidad veraz); null deja de integrarse en accumulator (`continue`); feed de desviación
    con guard de null; alerta per-unit `meterDown≥3min`; `fallbackThreshold` obsoleto (decisión
    time-based). Aplica a las 4 unidades.
  - *Consecuencias:* elimina el valle; corrige sub-integración de energía; D-102 (recovery 2-OK) y
    D-105 (aislamiento por unidad) intactos; badge MEDIDOR/PME sin cambios (hold se ve como 'MEDIDOR');
    reconciliación del umbral de alerta 30s→3min.

---

## Verificación end-to-end (en dev)

1. **Tests:** `cd server && npm test`. Originales (ajustados) + nuevos en verde.
2. **Hold corto:** correr server con `TRACE_DEVIATION=GEC3,GEC32,TGJ1,TGJ2` + `METER_HOLD_TTL_MIN=3`.
   Forzar un null corto del medidor. Verificar en el JSONL: durante el null `holding:true`,
   `currentMw`≈último valor (no 0), `deviationPct` estable, sin `outlierDeviation`.
3. **Hold >3min:** mantener medidor caído >3min. Verificar transición `holding:true → source:pme`
   al cruzar TTL y `meterDownSeconds` cruzando 180; confirmar que dispararía `orchestrator:meterDown:<unit>`.
4. **Analyzer:** `node server/traces/analyze.js <jsonl>` — confirmar que ya no hay valle ni
   `nullCoercedToZero` propagado a deviation.
5. **/health/detailed:** `curl -s localhost:3001/health/detailed` → verificar
   `services.orchestrator.perUnit.<unit>.{holding,heldTicks,meterDownSeconds}` en las 4 unidades.

---

## Riesgos / notas

- **R1 — Re-spec de tests:** ~6-8 tests de histéresis/recovery cambian de semántica. Mitigar
  exponiendo `holdTtlMs` en el constructor.
- **R2 — `fallbackThreshold` obsoleto:** se deja aceptado-pero-ignorado (documentado en D-116);
  eliminar en cleanup posterior para no romper `METER_DEFAULTS`/llamadas/tests.
- **R3 — `?? 0`:** dejar el de broadcast (defensa); cambiar el de accumulator a `continue`.
- **R4 — `ALERT_THRESH_METER_CONSEC_ERRORS`:** el bloque que lo usa es no-op en prod
  (meterPoller=null); la alerta canónica es la nueva per-unit time-based.
- **R5 — `isValid` 30s vs TTL 3min:** `lastGoodMeter.at` se sella con el `now` de captura; el TTL
  corre desde la última captura buena (comportamiento deseado).

---

## Checklist de ejecución

- [ ] `server/extractorOrchestrator.js`: TTL, estado per-unit, lógica de decisión, episodio de hold, `valueMW`, `getStatus`/`getTickSnapshot`.
- [ ] `server/accumulator.js`: `continue` en null.
- [ ] `server/alerter.js`: regla `meterDown` + reconciliación de umbral.
- [ ] `server/server.js`: guard de null en `feedDeviation` + campos `holding` en el record del tracer.
- [ ] `.env.example` + `CLAUDE.md` + `docs/decisions.md` (D-116).
- [ ] Tests nuevos + re-spec de los existentes; `npm test` verde.
- [ ] Verificación end-to-end con tracer/analyzer en las 4 unidades.
