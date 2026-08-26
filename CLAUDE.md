# CLAUDE.md — raíz de dashboard-gen-gec3

La guía real está en **[`src/CLAUDE.md`](./src/CLAUDE.md)** (arquitectura en una pantalla, comandos y las
convenciones críticas numeradas). Este archivo solo orienta:

- Front (Vite + React 19): `src/` → `src/CLAUDE.md`.
- Backend Node (medidores Modbus, scrapers XM, despacho final, WS): `server/` → `server/EXTRACTION_BACKEND_MAP.md`, `server/SIGN_CONVENTION.md`.
- Sink Python a Fabric + PostgreSQL: `fabric-meter-sink/` → `fabric-meter-sink/CLAUDE.md`.
- Referencia operativa (endpoints, env vars, tablas, deploy, debugging): `docs/referencia-operativa.md`.
- Decisiones: `docs/decisions.md`. Runbooks: `docs/runbooks/`.
- Metodología de implementación (olas de lotes en chats paralelos, gates, sin firmas de IA en commits):
  `../metodología de implementación/README.md`. Hooks: `git config core.hooksPath .githooks`.

Reglas del workspace (plantas, TZ Bogotá, contrato cross-repo con Bitácora): `../CLAUDE.md`.
