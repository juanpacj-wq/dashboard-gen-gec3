# .githooks — hooks versionados (metodología v2)

Actívalos una vez por clon: `git config core.hooksPath .githooks`.

- `commit-msg`: rechaza `Co-Authored-By` / `Generated with` (sin firmas de IA) y, cuando este chat
  tiene un lote reclamado (`LOTE_SESION=LNN-HHMM` en el entorno), exige el scope `(D-NNN LNN)` en el título.
- `pre-commit`: bloquea `.env` y binarios sueltos en la raíz; `node --check` de cada `.js`/`.mjs` que
  entra; con `LOTE_SESION`, rechaza archivos fuera del territorio del lote (`prompts/*/LOTES.json`);
  eslint sobre lo que entra si el repo tiene `eslint.config.js`; ruff en `fabric-meter-sink/` si hay venv.

Los hooks son `sh` + Node (funcionan en Git Bash de Windows y en Ubuntu). Sin dependencias.
