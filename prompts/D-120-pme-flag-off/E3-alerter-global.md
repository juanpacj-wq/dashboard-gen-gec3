# D-120 · E3 — CRITICAL global meterDown cuando PME está deshabilitado

> Etapa self-contained: un Claude futuro que no leyó el chat de planeación debe poder
> ejecutarla solo con este archivo + `_CONTEXTO-BASE.md` + `ESTADO.md` + el contexto del subrepo.

## Antes de empezar (obligatorio)
1. Lee `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. **Verifica que E1 y E2 figuren ✅** en el tablero de `ESTADO.md`. Si alguna no lo está,
   detente y reporta (esta etapa consume el campo `pmeEnabled` que E2 agregó a `getStatus()`).
3. Relee las "Decisiones / desviaciones acumuladas" y "Datos descubiertos".

## Alcance de esta etapa
Solo `server/alerter.js`, sus tests y la documentación de la env nueva en `.env.example`.
Sin PME, la alerta CRITICAL "todas las unidades en PME" pierde sentido; su reemplazo es
"todas las unidades sin medidor". NO tocar orquestador ni docs permanentes (E4).

## Tareas
1. `server/alerter.js`:
   - Agregar `ALERT_THRESH_METER_DOWN_GLOBAL_MIN: 2` a `DEFAULTS` (:5-20), overridable por env
     (mismo patrón que `ALERT_THRESH_PME_GLOBAL_MIN`; NO reutilizar esa var: semántica distinta,
     tuneo independiente).
   - En `#evaluate`, junto al bloque global existente (:153-167), agregar la alerta
     `orchestrator:meterDown:GLOBAL`:
     - Gate: `const pmeOff = orch?.pmeEnabled === false` — comparación **estricta**: snapshots
       legacy sin el campo (tests existentes, instancias viejas) no cambian de comportamiento.
     - Condición: `pmeOff && unitIds.length > 0 && unitIds.every(u => !perUnit[u].holding && (perUnit[u].meterDownSeconds ?? 0) >= c.ALERT_THRESH_METER_DOWN_GLOBAL_MIN * 60)`.
       El `!holding` evita el falso positivo mientras el carry-forward todavía sirve valores:
       en la práctica dispara en el primer tick tras agotarse el hold TTL (~3 min).
     - Al disparar: `#open` con severidad CRITICAL, título "TODAS las unidades sin medidor
       (PME deshabilitado)", body orientado a acción (probable falla de LAN de medidores; sin
       fallback activo; valores en null; revisar conectividad de los hosts).
     - Rama else: `#close` con recovery (las CRITICAL emiten RECOVERED, mismo patrón que
       `orchestrator:pme:GLOBAL`).
   - No tocar las alertas existentes: `orchestrator:pme:${u}`, `orchestrator:pme:GLOBAL`
     (se auto-desactiva con flag off porque `source` nunca es `'pme'`) ni
     `orchestrator:meterDown:${u}` (convive: 4 WARN per-unit + 1 CRITICAL global es el patrón
     ya usado por pme per-unit + pme:GLOBAL).
2. `server/__tests__/alerter.test.js` — nuevo describe (reutilizar los builders de snapshot
   existentes, agregándoles `pmeEnabled: false` donde aplique):
   - Dispara CRITICAL cuando TODAS las unidades tienen `meterDownSeconds >= 120`, `holding=false`
     y `pmeEnabled === false`.
   - NO dispara si alguna unidad está en `holding=true` (carry-forward activo).
   - NO dispara con `pmeEnabled: true` ni con el campo ausente (snapshot legacy).
   - NO dispara si solo algunas unidades están caídas (las per-unit meterDown sí).
   - Emite RECOVERED cuando una unidad vuelve.
   - Respeta cooldown/incidencia abierta (no re-notifica cada tick).
3. `.env.example`: documentar `ALERT_THRESH_METER_DOWN_GLOBAL_MIN` (default 2) junto a los
   umbrales existentes (:129-130), anotando que solo aplica con PME deshabilitado.

## Verificación (antes de commitear)
- `cd server && npm test` — batería existente de alerter intacta + describe nuevo verde.
- Smoke manual opcional: flag apagado + IPs de medidores inválidas en un `.env` local → a los
  ~3 min (TTL) el dispatcher loguea/envía la CRITICAL global (sin webhook configurado se ve en
  el log del alerter).

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marca E3 como ✅ en el tablero con resumen de una línea.
- Agrega el bloque `### E3 — CRITICAL global meterDown  ✅` con: **Archivos tocados**,
  **Verificación** (resultado real de tests), **Desviaciones** ("ninguna" si aplica).
- Registra en "Datos descubiertos" cualquier hecho nuevo.

## Commit (1 commit por etapa)
```bash
git add server/alerter.js server/__tests__/alerter.test.js .env.example
git commit -m "$(cat <<'EOF'
feat(alerter): CRITICAL global meterDown cuando PME está deshabilitado (D-120)

Reemplaza a orchestrator:pme:GLOBAL (sin sentido sin fallback): con
PME_ENABLED apagado, todas las unidades sin medidor por más de
ALERT_THRESH_METER_DOWN_GLOBAL_MIN (2 min, sin contar el hold) dispara
CRITICAL con recovery. Gate estricto pmeEnabled === false para no
alterar snapshots legacy.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

> No hagas `push`/`merge`/`PR` en etapas intermedias — eso es exclusivo de la etapa de
> cierre (E4) y requiere confirmación humana.
> No incluyas en el commit los cambios ajenos al flujo presentes en el working tree.
