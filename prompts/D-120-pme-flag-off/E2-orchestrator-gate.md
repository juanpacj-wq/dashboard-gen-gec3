# D-120 · E2 — Gate `pmeEnabled` en el orquestador (sin scraper, sin login, sin conmutación)

> Etapa self-contained: un Claude futuro que no leyó el chat de planeación debe poder
> ejecutarla solo con este archivo + `_CONTEXTO-BASE.md` + `ESTADO.md` + el contexto del subrepo.

## Antes de empezar (obligatorio)
1. Lee `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. **Verifica que E1 figure ✅** en el tablero de `ESTADO.md`. Si no lo está, detente y reporta.
3. Relee las "Decisiones / desviaciones acumuladas" y "Datos descubiertos".

## Alcance de esta etapa
El gate completo en runtime: orquestador + wiring en server.js + smoke script + tests del
camino flag-off. Tras este commit, un server sin `PME_ENABLED=1` no instancia PMEScraper
(cero Chromium). NO tocar alerter (E3) ni docs (E4). El camino `PME_ENABLED=1` debe quedar
bit a bit idéntico al actual: **ningún test existente se modifica** (solo se agregan).

## Tareas
1. `server/extractorOrchestrator.js`:
   - Nuevo param del constructor `pmeEnabled = true` (:30-46). El default **true** preserva
     los tests existentes; el default apagado vive en config (E1).
   - Guardia (:53-55): `if (pmeEnabled && !pme) throw new TypeError('ExtractorOrchestrator: pme config required')`.
   - Guardar `this.#pmeEnabled = pmeEnabled` (campo privado nuevo).
   - Instanciación (:96-100): `this.#pmeScraper = pmeEnabled ? new pmeScraperCtor({...}) : null`.
     Con flag off NO llamar `unitsForPME()` (crashearía con `pme: null`).
   - `start()` (:111-121) y `stop()`: guard `if (this.#pmeScraper)` alrededor del arranque/
     parada del scraper. Agregar `pmeEnabled=${this.#pmeEnabled}` al log de arranque (:106-109).
   - `#tick`: donde se calcula la validez del dato pme, forzar
     `const pmeValid = this.#pmeEnabled ? isValid(pme, now) : false`. No tocar las ramas
     (:277-289): con `pmeValid=false` la conmutación a pme queda inalcanzable y la rama
     "ambas muertas" produce el comportamiento acordado (source sticky + `valueMW=null`,
     ver tabla de semántica en `_CONTEXTO-BASE.md`).
   - `getStatus()` (:171-207): agregar `pmeEnabled: this.#pmeEnabled` top-level y devolver
     `pme: null` cuando no hay scraper (hoy llama al getStatus del scraper).
2. `server/server.js`:
   - Importar `PME_ENABLED` de `./config.js` y pasarlo al orquestador: `pmeEnabled: PME_ENABLED`
     (:611-617).
   - Log de arranque: "Fallback PME: DESHABILITADO (PME_ENABLED=1 para reactivar)" /
     "Fallback PME: HABILITADO", simétrico al log de protocolo (:606).
   - Actualizar el comentario del fallback (:594-600).
   - Verificar (sin cambiar) que `/health` (:148-162) y el WS handshake (:350-371) usan el
     `stale`/`valueStale` top-level y toleran `pme: null` anidado.
3. `server/scripts/smoke-orchestrator.js`: pasar `pmeEnabled: PME_ENABLED` igual que server.js
   (hoy construye el orquestador con `PME` y arrancaría el scraper).
4. `server/__tests__/extractorOrchestrator.test.js` — nuevo `describe('pmeEnabled=false', ...)`
   reutilizando los helpers/fakes existentes (fake `pmeScraperCtor`, fake meter, fake timers):
   - Constructor sin `pme` y con `pmeEnabled: false` NO lanza.
   - `pmeScraperCtor` jamás se invoca (spy) y `start()`/`stop()` no revientan.
   - Meter caído → hold TTL → al expirar: `source` sigue `'meter'`, `holding=false`,
     `valueMW=null` (nunca conmuta a pme aunque el fake pme emita datos válidos).
   - Recovery normal del meter tras el null (vuelve a emitir valor).
   - Arranque en frío sin lectura válida → `source=null`, `valueMW=null`.
   - `getStatus()`: `pmeEnabled === false` y `pme === null`.
   - Sanity del camino on: un caso con `pmeEnabled: true` explícito se comporta como hoy
     (conmuta a pme al agotar TTL).

## Verificación (antes de commitear)
- `cd server && npm test` — batería existente intacta + describe nuevo verde.
- Smoke manual con flag apagado: `npm run start` (o `dev`) sin `PME_ENABLED` en el `.env` →
  log "Fallback PME: DESHABILITADO", **cero proceso Chromium** (verificar con el monitor de
  procesos), `GET /health` responde con `pme: null` anidado y sin `degraded`, el WS sirve
  `units[]` con `source: 'meter'`.
- Smoke con `PME_ENABLED=1` (requiere `PME_PASSWORD`): el scraper arranca como siempre.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marca E2 como ✅ en el tablero con resumen de una línea.
- Agrega el bloque `### E2 — Gate pmeEnabled en el orquestador  ✅` con: **Archivos tocados**,
  **Verificación** (resultado real de tests + smoke), **Desviaciones** ("ninguna" si aplica).
- Registra en "Datos descubiertos" cualquier hecho nuevo.

## Commit (1 commit por etapa)
```bash
git add server/extractorOrchestrator.js server/server.js server/scripts/smoke-orchestrator.js server/__tests__/extractorOrchestrator.test.js
git commit -m "$(cat <<'EOF'
feat(orchestrator): gate pmeEnabled — sin scraper, sin login, sin conmutación (D-120)

Con PME_ENABLED apagado (default) el orquestador no instancia PMEScraper:
cero Chromium en el servidor. pmeValid forzado a false deja la rama de
conmutación inalcanzable; tras el hold TTL (D-116) la unidad emite null
con source sticky. Camino PME_ENABLED=1 idéntico al actual (default del
constructor = true, batería de tests existente sin cambios).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

> No hagas `push`/`merge`/`PR` en etapas intermedias — eso es exclusivo de la etapa de
> cierre (E4) y requiere confirmación humana.
> No incluyas en el commit los cambios ajenos al flujo presentes en el working tree.
