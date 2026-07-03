# D-120 · E1 — Flag `PME_ENABLED` en config + `METER_PROTOCOL` default modbus

> Etapa self-contained: un Claude futuro que no leyó el chat de planeación debe poder
> ejecutarla solo con este archivo + `_CONTEXTO-BASE.md` + `ESTADO.md` + el contexto del subrepo.

## Antes de empezar (obligatorio)
1. Lee `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. **Verifica que E0 figure ✅** en el tablero de `ESTADO.md`. Si no lo está, detente y reporta.
3. Relee las "Decisiones / desviaciones acumuladas" y "Datos descubiertos".

## Alcance de esta etapa
Solo `server/config.js`, `.env.example` y el test nuevo de config. Tras este commit el
comportamiento en runtime NO cambia todavía (server.js aún no consume `PME_ENABLED`); lo
único observable es que `PME_PASSWORD` deja de ser obligatoria sin el flag y que el default
de protocolo pasa a modbus. NO tocar orquestador, server.js ni alerter (eso es E2/E3).

## Tareas
1. `server/config.js`:
   - Exportar `PME_ENABLED` junto al bloque `PME` (líneas 1-14, que se conserva intacto):
     `export const PME_ENABLED = process.env.PME_ENABLED === '1'` — patrón de
     `CONFIG_SKIP_VALIDATION` (:115). Comentario breve: default apagado (D-120).
   - Validación fail-fast (:126): condicionar a `PME_ENABLED`:
     `if (PME_ENABLED && !PME.password) missing.push('PME_PASSWORD  (fallback PME, requerido con PME_ENABLED=1)')`.
     Ajustar también el mensaje general (:131) que dice "medidores + PME fallback".
   - `unit()` (:86-88): exigir `pme.referencia` solo con flag on:
     `if (PME_ENABLED && (!pme || !pme.referencia)) throw ...`; el retorno (:97) pasa a
     `pme: pme ? { referencia: pme.referencia, occurrence: pme.occurrence ?? 0 } : null`.
     Las 4 unidades conservan su `pme` hardcodeado.
   - `METER_DEFAULTS.protocol` (:27): `process.env.METER_PROTOCOL || 'modbus'`. Actualizar el
     comentario (:23-26): modbus es el default desde D-120; http queda como rollback; quitar
     la frase "el PME sigue siendo fallback en ambos casos" (ya no por default).
2. `.env.example`:
   - Agregar `PME_ENABLED=` documentado (default apagado; `1` para reactivar el fallback).
   - Cambiar el `METER_PROTOCOL=http` literal a `METER_PROTOCOL=modbus` y ajustar los
     comentarios de fallback (líneas ~78-86). Crítico: `deploy/setup.sh` copia esta plantilla
     al provisionar — una instancia nueva no debe quedar en http y sin fallback.
   - Anotar `PME_USER`/`PME_PASSWORD`/`PME_LOGIN_URL`/`PME_DIAGRAM_URL` (:15-19), `HEADLESS`
     (:30) y `PME_DIAGNOSE` (:150-153) como "solo aplican con PME_ENABLED=1".
3. Nuevo `server/__tests__/config.test.js` (vitest; config valida al **cargar el módulo**, así
   que cada caso usa `vi.resetModules()` + `vi.stubEnv(...)` + `await import('../config.js')`;
   stubear también las env de medidores que la validación exige — `IP_*`, `PSW_*`,
   `USER_MEDIDORES` — para aislar el caso PME):
   - (a) Sin `PME_PASSWORD` y sin `PME_ENABLED` → el módulo carga sin lanzar.
   - (b) `PME_ENABLED=1` sin `PME_PASSWORD` → lanza con mención a `PME_PASSWORD`.
   - (c) Sin `METER_PROTOCOL` → `METER_DEFAULTS.protocol === 'modbus'`.
   - (d) `METER_PROTOCOL=http` explícito → se respeta.

## Verificación (antes de commitear)
- `cd server && npm test` — todo verde (baseline actual + tests nuevos). No degradar.
- Frontend no se toca → no aplica `npm run build`.
- Smoke manual: con un `.env` sin `PME_PASSWORD` ni `PME_ENABLED`, `node --env-file=../.env -e "await import('./config.js')"` desde `server/` no lanza.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marca E1 como ✅ en el tablero con resumen de una línea.
- Agrega el bloque `### E1 — Flag PME_ENABLED en config  ✅` con: **Archivos tocados**,
  **Verificación** (resultado real de tests), **Desviaciones** ("ninguna" si aplica).
- Registra en "Datos descubiertos" cualquier hecho nuevo.

## Commit (1 commit por etapa)
```bash
git add server/config.js server/__tests__/config.test.js .env.example
git commit -m "$(cat <<'EOF'
feat(config): flag PME_ENABLED default off + METER_PROTOCOL default modbus (D-120)

PME_PASSWORD y pme.referencia dejan de ser obligatorias salvo con
PME_ENABLED=1. El default de protocolo pasa a modbus (D-118 ya estable
en ambas instancias); .env.example corregido para que una provision
nueva no quede en http sin fallback.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

> No hagas `push`/`merge`/`PR` en etapas intermedias — eso es exclusivo de la etapa de
> cierre (E4) y requiere confirmación humana.
> No incluyas en el commit los cambios ajenos al flujo presentes en el working tree
> (`CLAUDE.md` borrado, `src/CLAUDE.md`, `docs/combo-modbus-ion8650.md`).
