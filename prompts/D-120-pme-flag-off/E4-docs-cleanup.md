# D-120 · E4 — Docs + cleanup + cierre

> Última etapa (siempre). Vuelca la decisión a los docs permanentes, borra el scaffolding
> efímero y deja el branch mergeable. El "breve .md de cambios" se materializa acá = el ADR D-120.

## Antes de empezar (obligatorio)
1. Lee `_CONTEXTO-BASE.md` y `ESTADO.md`.
2. **Verifica que E1, E2 y E3 figuren ✅.** Si alguna no lo está, detente: el cierre no corre
   sobre una implementación incompleta.

## 1. Smoke completo
- `cd server && npm test` con el baseline esperado (documenta el resultado exacto).
- Frontend no se tocó → `npm run build` no es obligatorio, pero un build rápido de sanidad no
  sobra si hubo desviaciones.
- Checklist de smoke manual para el autor (Claude lo deja explícito, el humano lo verifica):
  - [ ] Server local sin `PME_ENABLED` → log "Fallback PME: DESHABILITADO", cero Chromium.
  - [ ] Dashboard en el navegador: unidades con dato y badge MEDIDOR; nunca badge PME.
  - [ ] `GET /health` → `pme: null` anidado, sin `degraded`.
  - [ ] Con `PME_ENABLED=1` + `PME_PASSWORD`: el scraper arranca (rollback verificado).

## 2. Documentación permanente (el "changelog" del flujo)
- **ADR `D-120` en `docs/decisions.md`** — formato fijo (Contexto / Decisión / Consecuencias,
  4-8 líneas). Cross-ref `[[D-116]]` (carry-forward TTL) y `[[D-118]]` (Modbus primaria).
  Contenido mínimo: PMEScraper (Playwright/Chromium) era el mayor consumidor de recursos;
  ambas instancias estables en Modbus; flag `PME_ENABLED` default apagado (código conservado);
  `METER_PROTOCOL` default modbus; nueva CRITICAL `orchestrator:meterDown:GLOBAL`;
  reactivación = `PME_ENABLED=1` + `PME_PASSWORD` + restart.
- **Runbook nuevo o sección en `docs/runbooks/01-Medidores y PME/`**: "Reactivar PME" —
  pasos exactos (`PME_ENABLED=1`, `PME_PASSWORD`, restart del servicio) y rollback de
  protocolo (`METER_PROTOCOL=http` + restart, sin código).
- **Actualizar menciones "PME sigue siendo fallback hot-standby"** (hoy quedaría falso por
  default) en: `docs/architecture.md`, `docs/runbooks/01-Medidores y PME/cutover-modbus.md`,
  `docs/runbooks/01-Medidores y PME/orchestrator-fuente.md`, `docs/runbooks/01-Medidores y
  PME/pme-scraper.md` (nota de "deshabilitado por default desde D-120" al inicio),
  `server/EXTRACTION_BACKEND_MAP.md`, `docs/runbooks/observability.md` (alertas) y
  `docs/runbooks/04-Frontend y Realtime/badges-visuales.md` (badge PME solo con flag on).
- **`src/CLAUDE.md`** (nota: es el CLAUDE.md vigente del subrepo, está untracked en el working
  tree): actualizar la tabla de env vars (`PME_ENABLED`, default modbus) y las secciones que
  describen el PMEScraper como extracción realtime. 1-3 frases + link al ADR; respetar el
  límite de tamaño. NO commitear el archivo si el usuario prefiere mantenerlo fuera del flujo
  — confirmar con él (está en un movimiento de CLAUDE.md sin commitear ajeno a D-120).

## 3. Cleanup del scaffolding (git rm)
> El scaffolding es efímero; el historial de git lo conserva (`git show <commit>:<path>`).

```bash
git rm -r "prompts/D-120-pme-flag-off"
```

## 4. Commit de cierre
```bash
git add docs/ server/EXTRACTION_BACKEND_MAP.md
git commit -m "$(cat <<'EOF'
chore(repo): cerrar D-120 — flag PME off + docs + cleanup de scaffolding

ADR D-120 agregado (PME deshabilitado por default, solo Modbus TCP);
runbook de reactivación; menciones de fallback hot-standby actualizadas;
scaffolding prompts/D-120-pme-flag-off eliminado.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```
(Ajusta el `git add` a los archivos realmente tocados; no arrastres los cambios ajenos al
flujo del working tree.)

## 5. Push / PR — REQUIERE CONFIRMACIÓN HUMANA
> Estas acciones NO se ejecutan sin OK explícito del usuario.
Pregunta al usuario antes de:
- `git push -u origin feat/pme-flag-off-2026-07`.
- Camino A: `git merge` a `main` (o merge desde la UI).
- Camino B: `gh pr create` / abrir PR desde el navegador.

Recordatorio de despliegue (para el usuario, no automatizar): deploy normal con sudo; no hay
que tocar los `.env` de producción (el default apagado hace el trabajo); verificar en
`journalctl` que no se lanza Chromium y comparar memoria/CPU del servicio antes/después.

## 6. Actualizar ESTADO.md por última vez
- Marca E4 ✅ con el resumen. (El archivo se borra junto con el resto del scaffolding en el
  paso 3; el resumen final ya vive en el ADR D-120.)
