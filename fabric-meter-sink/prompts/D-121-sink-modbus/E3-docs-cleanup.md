# D-121 · E3 — Smoke real + docs + cleanup + cierre

> PLANTILLA de la **última** etapa. Vuelca la decisión a los docs permanentes, borra el
> scaffolding efímero y deja el branch mergeable. El "breve .md de cambios" se materializa
> como el ADR `D-121`.

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` y `ESTADO.md`.
2. **Verificá que E1 y E2 figuren ✅.** Si alguna no lo está, detenete: el cierre no corre
   sobre una implementación incompleta.

## 1. Smoke completo (decisión: confiar en el combo validado + smoke real)
- `pytest` (suite completa) verde — documentá el resultado exacto.
- `ruff check` limpio.
- **Smoke Modbus real** contra los 5 medidores: `python -m scripts.probe_modbus` →
  verificá kw plausibles y **signo correcto por planta** (TGJ output +, GEC input − *después* del
  poller/sign; ojo: el probe muestra el kw crudo del cliente, sin signo — la inversión se ve corriendo el
  service). Anotá las lecturas y latencias reales en "Datos descubiertos" de `ESTADO.md`.
- **E2E Fabric**: corré `python -m src.main` un par de ciclos (o el servicio unos minutos) y confirmá que
  la tabla Delta destino recibe filas con kW, columnas `tgj1/tgj2/gec3/ge32`, `uom='KW'`, coherentes con lo
  que traía por HTTP (comparación puntual contra una lectura HTTP del mismo instante, o contra lo que
  persiste el Node en MSSQL).
- **Rollback probado**: `METER_PROTOCOL=http` → el service vuelve a leer por scraping sin cambios de código.

## 2. Documentación permanente (el "changelog" del flujo)
- **ADR `D-121` en `../docs/decisions.md`** — formato fijo (Contexto / Decisión / Consecuencias, 4–8 líneas).
  Contenido: `fabric-meter-sink` migrado a Modbus TCP reutilizando el combo de D-118 (40204/int32/high/1000/
  unit 1/502), toggle `METER_PROTOCOL` de rollback, elimina el último lector HTTP (presupuesto de conexiones
  post-migración: 2 Node + 1 Python = 3 ≪ 8). Cross-ref `[[D-118]]` `[[D-120]]` `[[D-112]]`.
- **`fabric-meter-sink/CLAUDE.md`**:
  - Actualizá la sección **Stack**: `pymodbus` es ahora la fuente de lectura; `httpx`/BeautifulSoup quedan
    solo para el rollback HTTP.
  - Agregá una entrada corta (1–3 frases) sobre el toggle `METER_PROTOCOL` (default `modbus`) con link al ADR.
  - **Corregí de paso** la sección "Variables de entorno", que está desalineada con el código real: documenta
    `METER_{TGJ1}_HOST`/`FABRIC_TENANT_ID` **inexistentes**; el código usa `IP_*`, `PSW_*`, `USER_MEDIDORES`,
    `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `FABRIC_WORKSPACE_ID`, `FABRIC_LAKEHOUSE_NAME`,
    `FABRIC_TABLE_NAME`. Dejala reflejando la realidad + las nuevas `METER_PROTOCOL`/`METER_MODBUS_*`.
- **`README.md`**: ajustá la referencia al protocolo de lectura donde diga "HTTP" como fuente primaria.

## 3. Cleanup del scaffolding (git rm)
```bash
git rm -r "prompts/D-121-sink-modbus"
```

## 4. Commit de cierre
```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(repo): cerrar D-121 — sink Python en Modbus + docs + cleanup de scaffolding

Migración de fabric-meter-sink a Modbus TCP completada y verificada (smoke real de los
5 medidores + escritura a Fabric). ADR D-121 agregado a docs/decisions.md; CLAUDE.md
(stack + vars de entorno corregidas) y README actualizados. Elimina el último lector HTTP.
Scaffolding del flujo removido (recuperable por git).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

## 5. Push / PR — REQUIERE CONFIRMACIÓN HUMANA
> Estas acciones NO se ejecutan sin OK explícito del usuario (ver `01-convenciones.md`).
Preguntá al usuario antes de:
- `git push -u origin feat/fabric-sink-modbus-2026-07`.
- Camino A: `git merge` a `main` (o merge desde la UI).
- Camino B: `gh pr create` / abrir PR desde el navegador.

## 6. Actualizar ESTADO.md por última vez
- Marcá E3 ✅ con el resumen. (El archivo se borra junto con el resto del scaffolding en el paso 3;
  el resumen final ya vive en el ADR `D-121`.)
