# Decisiones de arquitectura — dashboard-gen-gec3 (ADR-lite)

Formato corto: Contexto / Decisión / Consecuencias. Para flujos detallados ver `architecture.md` y `../server/EXTRACTION_BACKEND_MAP.md`.

---

## D-101 — Migración PME centralizado → medidores ION8650 directos

**Contexto:** la extracción primaria dependía de `PMEScraper` (Playwright contra `gpme.gecelca.com.co/diagrama balance.dgm`). Cualquier cambio de UI/login del PME rompía la extracción; el reinicio del browser era costoso (~10s); dependencia de un componente externo no operado por nosotros.

**Decisión:** consultar directamente los 5 medidores Schneider PowerLogic ION8650 vía HTTP (`/Operation.html`, HTTP Basic, parsing del `<td class='v'>... kW</td>`). Polling propio cada 2s con `Promise.all` por unidad. PMEScraper queda como hot-standby.

**Consecuencias:** `MeterPoller` con misma API pública que `PMEScraper` (`start/stop/getStatus/onData`) — `server.js` solo cambió 2 zonas. Sin browser para reiniciar, watchdog/heartbeat simplificados. Por-meter status visible en `/health` sin leer logs. Subproyecto Python `fabric-meter-sink/` replica esta extracción para escribir a Microsoft Fabric Lakehouse.

---

## D-102 — `ExtractorOrchestrator` con state machine por unidad

**Contexto:** sustituir PME por medidores introdujo dos fuentes posibles. Pero los medidores pueden caer parcialmente (un meter de los 5) sin que sea problema sistémico; el switch a PME debe ser por unidad, no global.

**Decisión:** `ExtractorOrchestrator` mantiene state machine `{ source: 'meter' | 'pme' | null }` por unidad. Histeresis: `fallbackThreshold=3` (3 errores meter consecutivos → switch a `'pme'`), `recoveryThreshold=2` (2 OK consecutivos del meter → recovery a `'meter'`). Tick cada `pollMs=2000`.

**Consecuencias:** falla parcial es contenida (TGJ1 puede estar en `meter` mientras TGJ2 está en `pme`). El campo `source` se expone en el payload WS (D-103). Si todos los meters caen, el dashboard sigue funcionando con datos PME — invisible al operador a nivel valor, pero visible vía badge UI.

---

## D-103 — `source` per-unit en payload WS y badge UI (M1-M3)

**Contexto:** la decisión del orchestrator (qué fuente está activa) era invisible al operador. Si TGJ1 caía a PME, nadie se enteraba.

**Decisión:** tres pasos atómicos:
- M1: `extractorOrchestrator.js:226` — agregar `source: state.source` al `mergedUnits.push`. `state.source` ya existía.
- M2: `useRealtimeData.js` — confirmar que `setUnits(msg.units)` propaga sin transformar. Comentario documental de 2 líneas.
- M3: `UnitCards.jsx` — badge mini en header de cada card. "MEDIDOR" verde para `'meter'`, "PME" ámbar para `'pme'`, nada para `null` (warming).

**Consecuencias:** los 4 ticks de 2s después de un switch meter→pme reflejan visualmente. `theme.js` ganó `amberDim` y `amberBorder` para simetría con el patrón verde. Cero hooks/stores nuevos. Lógica del badge directa en el componente (`realtimeUnit?.source`).

---

## D-104 — Convención de signos por frontera de medición

**Contexto:** los medidores ION8650 reportan `kW total` desde la perspectiva física donde están instalados. TGJ1/TGJ2 están en frontera de **salida** (signo coincide con generación neta); GEC3/GEC32 están en frontera de **entrada** (signo opuesto — la unidad genera → energía sale por otro punto → el medidor cuenta auxiliares negativos).

**Decisión:** configurar `frontierType: 'output' | 'input'` por unidad en `config.js`. `meterPoller.js` invierte el signo si `frontierType === 'input'` a nivel **unidad** (después de combinar con `combine: 'sum'` cuando aplica). Normalizar `-0 → 0` para evitar inconsistencias con `Object.is`.

**Consecuencias:** acumulador, projection calculator, DB y frontend siguen viendo convención PME canónica (positivo = generación neta). Inversión es concern del extractor solamente. Detalle físico + verificación con datos reales del día de migración (PME y meters lado a lado) en `../server/SIGN_CONVENTION.md`. Tests en `meterPoller.test.js` bajo "Convención de signos".

---

## D-105 — Aislamiento por unidad en MeterPoller

**Contexto:** si un medidor de GEC3 (que tiene 2) falla, ¿qué reportar? Sumar solo el otro daría un valor parcial que el integrador del acumulador interpretaría como "la planta está generando solo la mitad", contaminando los MWh acumulados.

**Decisión:** **si CUALQUIER medidor de una unidad falla en un tick, esa unidad reporta `valueMW=null`**. El acumulador no integra `null` (`if (valor == null) continue`). Aislamiento entre unidades: la falla de un meter de GEC3 no afecta TGJ1/TGJ2/GEC32 — cada unidad tiene su propia rama de `Promise.all`.

**Consecuencias:** sub-reporting prevenido. Si un medidor de GEC3 está crónicamente caído, GEC3 entera reporta `null` hasta que el ExtractorOrchestrator detecte 3 ticks consecutivos así y switchee a PME. El campo `perMeter[unitId@host]` en `/health.pme` permite identificar exactamente qué meter está fallando.

---

## D-106 — Clamping de valores negativos en presentación

**Contexto:** el PME (y ocasionalmente los meters) generan spikes negativos espurios — quedaban propagándose al acumulador, a la proyección y al cálculo de desviación, distorsionando display.

**Decisión:** clamping a `>=0` en presentación, no en datos crudos:
- `final_` y `proyGeneracion` clampados con `Math.max(0, ...)` en `Table.jsx`.
- `deviation` recomputada con `Math.max(0, projection)` contra `redespacho` en `Table.jsx` (periodo actual) y `UnitCards.jsx` (formula `((clampedProj - redespacho) / redespacho) * 100`).
- `UnitCards` recibe `xmDispatch` de `Dashboard.jsx` para acceder al redespacho del periodo actual.

**Consecuencias:** datos crudos en BD y WS preservados (pueden ser negativos). El clamping es solo display. `projectionCalculator.computeLive` también aplica `Math.max(0, currentMw)` para clampar lecturas negativas al calcular proyección.

---

## D-107 — Sin router, sin state library, sin CSS framework

**Contexto:** la app es de pantalla única (un solo dashboard que se mira en una TV operativa). Agregar React Router, Redux/Zustand, Tailwind sería overhead sin beneficio.

**Decisión:** SPA pura con un solo componente raíz (`Dashboard.jsx`) que compone children. Estado local en hooks (`useRealtimeData`, `useXmGeneration`, `useXmDispatch`). Estilos inline via objetos JS importados de `theme.js`.

**Consecuencias:** bundle chico, build rápido. Sin learning curve para Tailwind. Sin state manager → si la app crece a múltiples vistas, evaluar React Router + context o Zustand. Las cards usan estilos inline largos (líneas 6-83 de `UnitCards.jsx`) — aceptable hasta ~150 líneas por componente; arriba de eso, refactor.

---

## D-108 — Vite proxy `/api/despacho-final` ANTES de `/api/despacho`

**Contexto:** Vite hace matching por prefijo simple. `/api/despacho` matchea también `/api/despacho-final` si está listado primero, rompiendo el ruteo.

**Decisión:** orden explícito en `vite.config.js`: `/api/despacho-final/*` listado ANTES de `/api/despacho/*`.

**Consecuencias:** documentado como warning en CLAUDE.md y `architecture.md`. Mismo orden replicado en `deploy/nginx.conf`. Si se agrega un nuevo endpoint con prefijo compartido, revisar el orden.

---

## D-109 — Cero MW es dato válido

**Contexto:** una unidad puede estar parada (despacho 0). El acumulador no debe descartar lecturas de 0, pero sí debe descartar `null` (datos ausentes por falla del meter).

**Decisión:** todas las funciones de persistencia usan `if (valor == null) continue`, NO `if (!valor)` ni `if (valor === 0)`. Aplica a `accumulator.update`, `saveDespachoProgBulk`, `saveRedespachoProgBulk`, `saveAccumState`.

**Consecuencias:** 0 MW se integra como 0 MWh (correcto: planta parada genera 0). Solo errores reales propagan `null` y son descartados.

---

## D-110 — Despacho final: email primary, XM fallback al minuto 55

**Contexto:** los emails de redespacho llegan al mailbox compartido típicamente en los primeros minutos del periodo, pero hay periodos donde el email se atrasa o no llega. Sin un fallback, el dashboard quedaría sin valor de "despacho final" para esos periodos.

**Decisión:** `EmailDispatchService` corre cada 5 min leyendo mailbox vía Microsoft Graph. Al minuto 55 de cada hora, intenta llenar periodos sin despacho final con XM API (`GeneProgRedesp`). Constraint en `despacho_final`: `source IN ('email', 'xm_fallback')`. Email filter desde `T01:00:00Z` (8 PM Colombia previo) para capturar early-period emails (periodos 1 y 2).

**Consecuencias:** GRAPH_* variables deben estar en local AND server (la doc en CLAUDE.md lo recalca). Endpoint `/api/despacho-final/today` devuelve `{ GEC3: { 1: {valor_mw, source}, ... }, ... }` con la source indicada para auditoría.

---

## D-111 — `redespacho_historico` audit log

**Contexto:** XM puede actualizar el rDEC durante el día (cambios de redespacho). Necesitamos trazabilidad de qué valor cambió cuándo.

**Decisión:** `saveRedespachoProgBulk` detecta cambios con threshold `Math.abs(existing - new) > 0.01` y logea una fila en `dashboard.redespacho_historico` con `valor_mw_prev` y `valor_mw_new`. `redespacho_programado` queda como UPSERT con `version` incremental. Index `IX_redesp_hist_fecha` en `(fecha, unit_id, periodo)` para queries.

**Consecuencias:** auditoría completa. Costo en escrituras solo cuando hay cambios reales. El frontend no consume `redespacho_historico` directamente — es para reportes operativos posteriores.

---

## D-112 — Subproyecto Python `fabric-meter-sink` para Microsoft Fabric

**Contexto:** Power BI report en Fabric necesitaba lecturas de medidores con cadencia fina (no la lectura cada 5 min del notebook anterior que consumía capacidad F2). Pero el Node backend no escribe a OneLake/Delta.

**Decisión:** subproyecto Python independiente que replica la lógica de `meterPoller.js` (incluyendo `aplicar_signo`), corre como systemd service on-prem, escribe cada 15s a tabla Delta `BRC_PGN_GENERACION_MEDIDORES` en Fabric Lakehouse vía `deltalake` (delta-rs, sin Spark/Java). Ver `fabric-meter-sink/CLAUDE.md`.

**Consecuencias:** dos implementaciones paralelas de la extracción (Node + Python) que comparten convenciones (signos, aislamiento por unidad). Ambas deben actualizarse cuando cambia la topología. La columna `ge32` en Fabric (sin C) es histórica — renombrarla rompería reports BI en producción.

---

## D-113 — Lessons learned migración PME → meters (de `server/migration-prompts/`)

Las migration-prompts fueron una secuencia de 11 prompts ejecutados en orden durante la migración. Lecciones útiles que sobreviven:

- **API pública compatible** entre PMEScraper y MeterPoller permitió cambio quirúrgico en `server.js` (solo 2 zonas: imports + instanciación). Variable se siguió llamando `scraper` para que monitoreo externo no requiera cambios.
- **Validación fail-fast** en `config.js` levanta excepción con la **lista completa** de variables de entorno faltantes (no una por una). Saltable con `CONFIG_SKIP_VALIDATION=1` para tests/scripts ad-hoc.
- **`perMeter` en getStatus()** fue el feature más útil post-migración para diagnóstico operativo: permitió identificar qué medidor específico estaba fallando sin parsear logs.
- **`MeterFormatError`** (HTML respondió 200 pero la celda `kW total` no existe / la unidad no es `kW` / el número no es finito) se separó de errores de red porque es **señal de cambio de firmware** — el operador debe verlo, no es transitorio.
- Tests con `--pool=forks` (no threads) son necesarios por el manejo de timers fake en vitest.

---

## D-114 — Negocios pendientes (deuda y próximos pasos)

- **F15 (Bit-cora-g3 → dashboard):** badge de disponibilidad por planta consumiendo `GET /api/eventos-dashboard?tipo=DISP&planta_id=` de Bit-cora-g3. Ver `../../docs/interfaces-cross-repo.md` y `Bit-cora-g3/docs/decisions.md` D-009.
- **`graphify-out/`**: contiene un knowledge graph (`GRAPH_REPORT.md`) generado en algún momento. Las god nodes y comunidades listadas allí pueden estar desactualizadas tras la migración a meters. Tratar como referencia, no fuente de verdad. Si se vuelve a generar: `python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"`.

---

## D-115 — Heartbeat + alerting in-process (sin Prometheus por ahora)

**Contexto:** los 7 servicios de extracción del Dashboard (meterPoller,
orchestrator, accumulator, emailDispatch GEC/TGJ, despacho/redespacho scrapers)
pueden fallar silenciosamente. El switch meter→PME del orchestrator (D-102) es
invisible al operador si nadie está mirando el badge UI (D-103). Sin alerting,
incidentes pueden durar horas hasta que alguien note datos viejos.

**Decisión:** alerter in-process en `server/alerter.js` que:
- Polea cada `ALERT_POLL_INTERVAL_SEC=30s` un snapshot canónico de
  `buildHealthSnapshot()` (`healthSnapshot.js`, también expuesto vía nuevo
  endpoint `GET /health/detailed`).
- Evalúa umbrales configurables vía env vars `ALERT_THRESH_*` (defaults en
  `.env.example` + runbook).
- Emite `WARN` (degradación per-componente) o `CRITICAL` (falla operativa global
  / accumulator stalled).
- Manda al webhook genérico vía `alertDispatcher.js` (HTTP POST con
  serialización Teams/Slack/genérica según `ALERT_TARGET`).
- Mantiene estado solo en memoria (Map por `incident_key`); cooldown
  `ALERT_COOLDOWN_MIN=30` min entre re-emisiones; reinicio del proceso = se
  olvida (aceptable dado deploy poco frecuente).
- Emite recovery solo para `CRITICAL` (WARN cierra silenciosamente).
- `/health` original **intacto** (compat con nginx/uptime externos).

Detalle de las 6 decisiones cerradas (Q1..Q6) en `preguntas-01-obs-alerting.md`
(raíz workspace, archivado en `.scratch/flujo-2026-06-obs-alerting/`).

**Consecuencias:**
- Cero dependencias nuevas: `fetch` global Node 20+, `Intl.DateTimeFormat`,
  `setInterval`. No se introduce Prometheus, OTel ni cualquier otro framework
  de observabilidad — anti-patrón #4 del plan maestro 2026-05.
- Operación calibra umbrales vía env vars sin redeploy de código.
- Runbook único `docs/runbooks/observability.md` cubre los 7 escenarios con
  diagnóstico + fix.
- El `dashboard-ws.service` debe tener `ALERT_WEBHOOK_URL` configurado en
  producción; si vacío, el alerter sigue evaluando y solo loguea warn por cada
  alert no enviada — útil para dev local sin webhook.
- En este codebase la var `scraper` de `server.js` ES un `ExtractorOrchestrator`,
  por lo que el snapshot llena `services.orchestrator` y deja `services.meterPoller=null`
  (el meter poller está encapsulado dentro del orchestrator).
- W4b (Pino structured logging) reemplazará el `console.error` interno del
  alerter por logs estructurados con request_id / incident_key. No bloquea W2.

## D-116 — Carry-forward del medidor con TTL (fix valle de Desviación %)

**Contexto:** nulls transitorios del ION8650 (1-2 ticks sueltos) caían a `0 MW`
vía `?? 0` en tres lugares (broadcast, accumulator, `computeLive`). Con MW=0 la
proyección colapsa al puro acumulado → la desviación se hunde (valle −78%
verificado en `trace-GEC32-2026-05-26-11.jsonl`) y contamina el minute-bucket de
`feedDeviation`. El fallback meter→PME por conteo (3 ticks/6s, D-102) cedía a PME
por glitches sueltos aunque el medidor tuviera dato real al tick siguiente.
Aplica a las 4 unidades (mismo camino de código en `ExtractorOrchestrator`).

**Decisión:** carry-forward con TTL `METER_HOLD_TTL_MIN` (default 3 min), reemplaza
el fallback por conteo. Mientras el TTL no expire y el medidor entregue null,
la unidad sigue `source='meter'` emitiendo el último MW bueno (`holding=true`,
**prioridad sobre PME**). `lastGoodMeter` es un store separado del `#meterCache`
(que `#onMeterData` pisa con null al fallar). Al expirar el TTL cede a PME (si
válido) + alerta per-unit `orchestrator:meterDown ≥ 3min`; si PME también muerto →
`valueMW=null`. `consecMeterErrors` y el reloj `meterDownSince` corren durante el
hold (observabilidad veraz; el hold NO los resetea). En el accumulator, null deja
de integrarse (`continue` en vez de `?? 0`); `feedDeviation` se envuelve en guard
de null (defensa en profundidad). `fallbackThreshold` se retira de la firma del
orchestrator (decisión ahora time-based); las llamadas que aún lo pasen se ignoran
sin romper (el destructuring descarta props extra).

**Consecuencias:** elimina el valle del chart de Desviación % y corrige la
sub-integración de energía del `?? 0`. D-102 (recovery 2-OK pme→meter) y D-105
(aislamiento por unidad) intactos. El badge MEDIDOR/PME (D-103) no cambia: el hold
se ve como `'MEDIDOR'` (backend-only, sin badge "retenido"). Payload WS y
`getStatus().perUnit` ganan `holding`/`heldTicks`/`lastHoldAt`/`meterDownSeconds`
(aditivo). Reconciliación del umbral viejo de alerta 30s → 3 min
(`ALERT_THRESH_METER_CONSEC_ERRORS` 15→90, no-op en prod; canónica es la
per-unit time-based).

---

## D-117 — Multi-instancia vía config de UI en runtime (no build-time)

**Contexto:** se necesita correr una 2ª instancia del dashboard en otro servidor,
alimentando otra BD, con diferencias mínimas de UI (orden de unidades y unidad
seleccionada por defecto). El frontend no tenía patrón de config (`main.jsx`
renderiza síncrono, cero `import.meta.env`). La meta a largo plazo es Docker, así
que el mecanismo elegido no debe dificultar esa migración. Build-time (`vite
--mode` + `.env.<modo>`) obligaría a un artefacto/imagen por instancia, contra el
modelo Docker de "una imagen, N instancias por env".

**Decisión:** config de instancia en **runtime** vía `GET /config.json`, servido
**fuera del bundle** (nginx `location = /config.json` → `instance/config.json`
per-servidor, no versionado). `src/config/instance.js` expone `loadInstanceConfig()`
(fetch con fallback a defaults = comportamiento `gec3` histórico) y `getConfig()`
síncrono. `main.jsx` carga la config y recién entonces hace **import dinámico** de
`Dashboard` (necesario porque `units.js` computa el orden de `UNITS` en module-eval).
Los hardcodes (`units.js`, `Dashboard.jsx` default+logo, `useEventosBitacora` plantas,
`useXmDispatch` IDs) leen `getConfig()`. Plantillas versionadas `deploy/config.*.json`;
secretos+BD siguen en `server/.env` (gitignored). Despliegue idéntico en ambos
servidores (`deploy/update.sh`): build instancia-agnóstico; la identidad vive en
`server/.env` + `instance/config.json`.

**Consecuencias:** el mismo `dist/` (y a futuro la misma imagen Docker) sirve
cualquier instancia según el `config.json` montado. Sin forks ni ramas por instancia
(evita *fork drift*). Si `/config.json` falta/falla, arranca con defaults `gec3` (no
rompe; preserva "funciona aunque el backend esté caído"). El `branding` en el schema
permite título/logo por instancia aunque hoy solo difiere orden/default. Riesgo
abierto: ambas instancias reusan las mismas credenciales PME/medidor → contención
concurrente; validar en pilot y, si falla, mover B a solo-presentación o creds
dedicadas (ver `deployment-multi-instancia.md`). Guía completa:
`docs/deployment-multi-instancia.md`.

---

## D-118 — Extracción primaria por Modbus TCP (reemplaza HTTP scraping)

**Contexto:** la extracción raspaba la web del medidor (`GET /Operation.html`), cuyo
servidor HTTP del ION8650 admite **1 sola conexión simultánea** (doc Schneider,
`Documentación medidores ION8650/PM puertos comunicacion simultaneo.xlsx`). Con **3
lectores concurrentes** sobre los mismos 5 medidores (Node GEC3, Node Guajira, Python
`fabric-meter-sink`) la contención por ese único slot producía los nulls transitorios
que D-116 parchea con carry-forward. Es el riesgo de contención que D-117 dejó abierto.
**Modbus TCP (puerto 502) admite 8 conexiones.** Validación en sombra (3h, ~18.475
lecturas, 2026-06-30): **0.00% null en Modbus** vs HTTP con timeouts, y latencia
Modbus p50 ~15-25ms vs HTTP ~1.1s/p99 ~5s (~50× más rápido). Combo validado contra el
valor HTTP: registro 40204 (INT32, word order high, escala /1000), unitId 1.

**Decisión:** Modbus pasa a ser la **fuente primaria** vía toggle `METER_PROTOCOL`
(`http` default | `modbus`). El boundary ya existía: `ION8650Client.fetchKwTotal()` →
un `ION8650ModbusClient` con la misma firma (`server/meterModbusClient.js`, Function 03,
errores tipados + `MeterModbusException`). `createMeterClientFactory()`
(`server/meterClientFactory.js`) elige el cliente por protocolo y lo inyecta vía el
`clientFactory` que `MeterPoller`/`ExtractorOrchestrator` ya reenviaban; con `http` el
factory es `undefined` → poller usa su cliente HTTP. **El PME sigue siendo fallback
hot-standby** (D-116 intacto). Cliente Modbus: `modbus-serial`, 1 socket persistente por
medidor. Validación previa: `scripts/probe-modbus.js` (descubrimiento) y
`shadow-modbus-watch.js` + `analyze-shadow.js` (comparación HTTP vs Modbus con criterios
de éxito medibles).

**Consecuencias:** nada downstream cambia — combine/sum, `/1000`, inversión de signo
(`meterPoller.js`), carry-forward/PME (D-116), accumulator, proyección, `/health`,
frontend ven el mismo `valueMW` en convención PME. `INT32` signed entrega los negativos
de Gecelca nativos. Rollout **canary**: GEC3 primero (Guajira como control HTTP), 24-48h
en `/health`, luego Guajira; rollback = `METER_PROTOCOL=http` + restart (sin código).
Presupuesto de conexiones: 2 Node + (follow-up) 1 Python = 3 ≪ 8 — verificar que el PME
no consuma slots `:502` (suele hablar ION nativo `:7700`). Follow-up: migrar
`fabric-meter-sink` (Python `pymodbus`) con el mismo combo, eliminando el último lector
HTTP. Reduce además la carga sobre el medidor y da datos genuinamente en tiempo real.

## D-119 — Sub-path `/dashboard` en el servidor unificado + TLS corporativo (pgen.gecelca.com.co)

**Fecha:** 2026-07-01

**Contexto:** el servidor gecelca3 pasa a alojar también Bitácora bajo un mismo dominio
(`pgen.gecelca.com.co`) y un solo nginx, separados por ruta (contrato en
`../docs/deployment-unificado.md`). El dashboard venía sirviéndose en la raíz `/`; Bitácora exige
HTTPS (cookie Secure + OIDC), lo que arrastra TLS para todo el dominio.

**Decisión:** sub-path configurable por env **`APP_BASE_PATH`** (default raíz `/` — preserva
Guajira/standalone; el servidor unificado construye con `/dashboard`): `vite.config.js` lo usa
como `base` y `src/config/paths.js` centraliza `apiUrl`/`wsUrl`/`assetUrl` sobre
`import.meta.env.BASE_URL` (ningún literal `/api`, `/ws`, `/config.json` en el frontend). El
backend NO cambia: nginx quita el prefijo (barra final en `proxy_pass`). `deploy/nginx.conf` es el
server block ÚNICO del dominio: `:80` → 301 HTTPS, `:443` con **certificado corporativo** (cert +
key + bundle en `/etc/nginx/ssl/pgen.gecelca.com.co/`, renovación manual — runbook en
`Bit-cora-g3/deploy/DEPLOY.md §6`), HSTS, `/` → 302 `/dashboard/`, fallback SPA con named
location (pitfall `alias`+`try_files`), y placeholder para las locations de Bitácora.
`eventos-dashboard` se enruta a Bitácora (3002) con match exacto. El valor efectivo de
`APP_BASE_PATH` se **persiste en `server/.env`** durante `setup.sh` y `update.sh` tiene guard
anti-drift (fail-fast si nginx está namespaced pero el .env no lo declara).

**Consecuencias:** (a) un solo código/build sirve raíz o sub-path; Guajira no se ve afectada.
(b) El dominio completo queda en HTTPS (WS pasa a `wss` por el mismo proxy; sin mixed content).
(c) El cert corporativo NO se autorrenueva — registrar vencimiento y renovar a mano. (d) Los
updates son seguros ante el drift de base (guard + persistencia). Cross-ref: [[D-117]]
(multi-instancia runtime), `../docs/deployment-unificado.md` (topología completa).
