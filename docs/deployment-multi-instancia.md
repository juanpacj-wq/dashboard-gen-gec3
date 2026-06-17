# Despliegue multi-instancia — Dashboard Generación

Guía para correr **dos (o más) instancias** de este dashboard en servidores distintos, cada
una alimentando su propia base de datos, con diferencias **mínimas de UI**, manteniendo la
capacidad de **actualizar todas en paralelo pero de forma independiente** — y dejando el
camino allanado para una futura migración a **Docker**.

> Caso que motiva esta guía:
> - **Instancia A (`gec3`, actual):** orden de unidades `GEC3, GEC32, TGJ1, TGJ2`; default `GEC3`.
> - **Instancia B (`guajira`, nueva):** orden `TGJ1, TGJ2, GEC3, GEC32`; default `TGJ1`.
> - Ambas monitorean **las mismas plantas físicas** (mismo PME, mismos medidores ION8650).
> - Ambos servidores Ubuntu/Linux (se reutiliza `deploy/`). Decisión ADR: [D-117](./decisions.md).

---

## 0. Principio rector

**Un solo código. Una rama (`main`) como fuente de verdad. Las diferencias entre instancias
viven en CONFIGURACIÓN, nunca en código duplicado.**

El enemigo es el *fork drift*: copiar el repo o mantener una rama `instancia-B` con cambios de
UI obliga a portar cada bugfix de backend/scrapers/medidores para siempre, lo que destruye el
objetivo de actualizar en paralelo.

Hay **dos capas de configuración**, con reglas opuestas de versionado:

| Capa | Qué contiene | ¿Se commitea? | Dónde |
|---|---|---|---|
| **Secretos / runtime** | DB, credenciales PME, IPs y passwords de medidores, Graph API, puerto | **NO** (gitignored) | `server/.env` por servidor |
| **UI / build-time→runtime** | Orden de unidades, unidad por defecto, plantas de bitácora, branding | **SÍ** (plantillas, sin secretos) | `instance/config.json` por servidor (sembrado desde `deploy/config.*.json`) |

---

## 1. La diferencia de UI como configuración de RUNTIME

**Decisión clave (Docker-forward):** la config de UI se entrega en **runtime** vía
`GET /config.json`, NO en build-time. Vite hornea las env en build; usar `vite --mode`
obligaría a un artefacto distinto por instancia. Sirviendo un `config.json` aparte del bundle,
el **mismo build** (a futuro, la **misma imagen Docker**) sirve cualquier instancia según el
archivo que monte cada servidor. Ver [D-117](./decisions.md).

### 1.1 Cómo funciona (ya implementado)

- **`src/config/instance.js`** — `loadInstanceConfig()` hace `fetch('/config.json')` con
  fallback a defaults (= comportamiento histórico `gec3`); `getConfig()` lee la config ya
  cargada de forma síncrona. Nunca lanza: sin `/config.json` arranca como `gec3`.
- **`src/main.jsx`** — carga la config y **recién entonces** importa `Dashboard`
  dinámicamente. El import dinámico es necesario porque `src/data/units.js` computa el orden
  de `UNITS` en module-eval; así evalúa con `getConfig()` ya poblado.
- **Consumidores de la config:** `src/data/units.js` (orden de `UNITS`), `src/Dashboard.jsx`
  (unidad default + logo), `src/hooks/useEventosBitacora.js` (`bitacoraPlantas`),
  `src/hooks/useXmDispatch.js` (lista de IDs).

### 1.2 Schema de `config.json`

```json
{
  "instance": "guajira",
  "unitOrder": ["TGJ1", "TGJ2", "GEC3", "GEC32"],
  "defaultUnit": "TGJ1",
  "bitacoraPlantas": ["GEC3", "GEC32"],
  "branding": { "title": "Dashboard Generación", "logo": "/G3 blanco.png", "logoAlt": "Gecelca" }
}
```

- `unitOrder` — orden de las tarjetas; las unidades omitidas se anexan al final (defensivo).
- `defaultUnit` — unidad seleccionada al abrir y fallback de deselección.
- `bitacoraPlantas` — plantas con bitácora; `[]` desactiva el fetch a `/api/eventos-dashboard`
  (útil si una instancia no tiene Bitácora accesible).
- `branding` — título de pestaña + logo. Hoy solo difiere orden/default, pero el campo está
  listo para branding por instancia sin tocar código.

### 1.3 Archivos versionados (sin secretos)

- **`public/config.json`** — defaults `gec3`; sirve `npm run dev` y queda como fallback dentro
  del bundle (`dist/config.json`).
- **`deploy/config.gec3.json`** y **`deploy/config.guajira.json`** — plantillas por instancia.

> **No se usa `vite --mode` ni `.env.<modo>`.** El build es instancia-agnóstico.

### 1.4 Probar localmente

```bash
npm run dev          # usa public/config.json (gec3) → UI igual que siempre
# editar public/config.json a los valores guajira y recargar → orden TGJ1.. y default TGJ1
# borrar public/config.json → arranca igual con defaults gec3 (no rompe)
```

---

## 2. La capa de secretos / runtime (por servidor)

`server/.env` está gitignored y lo lee el server (dev vía `--env-file=../.env`; prod vía
systemd `EnvironmentFile`). Cada servidor tiene su **propio** `server/.env`:

- **Instancia A:** `DB_HOST`/`DB_NAME` actuales.
- **Instancia B:** `DB_HOST` del **otro SQL Server** + su `DB_NAME`/credenciales; **mismas**
  `PME_*`, `USER_MEDIDORES`, `IP_*`/`PSW_*`, `GRAPH_*` (credenciales compartidas — ver §3).

`server/db.js` autocrea el esquema `dashboard` y sus tablas con `CREATE IF NOT EXISTS` en el
primer arranque. **Caveat:** no hace `ALTER`; cambios de columnas en releases futuros hay que
probarlos en una instancia antes que la otra.

---

## 3. Concurrencia: el ÚNICO riesgo real de este caso

Como ambas instancias monitorean las mismas plantas **con las mismas credenciales**, los dos
servidores van a, en paralelo:

1. Loguearse al mismo PME (`PME_USER`) con Playwright.
2. Leer los mismos medidores ION8650 (mismas IPs/credenciales) vía meterPoller.
3. Descargar los mismos archivos XM y leer el mismo buzón Graph (inofensivo: idempotente).

Los puntos 1-2 son los delicados: el ION8650 admite conexiones TCP limitadas, y el login PME
concurrente con el mismo usuario puede invalidar la sesión más vieja.

### Opción A — Stacks independientes completos (máxima independencia)

Cada servidor corre su stack completo (PME + meterPoller + XM + email) a su propia BD.

- ✅ Instancias 100% independientes.
- ⚠️ Doble carga sobre PME/medidores; posible contención.

### Opción B — Plano de adquisición único (sin contención)

Un servidor primario adquiere de hardware y escribe; B **no toca hardware** (consume el WS del
primario o lee de BD).

- ✅ Sin doble carga ni contención.
- ⚠️ Acopla la liveness de B al primario.

### Recomendación + pilot (bloqueante)

Arrancar con **Opción A** y **pilotar la concurrencia** unas horas vigilando, **en ambos
servidores**, `curl -s localhost/health/detailed` y `journalctl -u dashboard-ws -f`.

- **Criterio de aceptación:** la tasa `source='meter'` se mantiene estable en AMBAS instancias
  (B no degrada los medidores de A a `source='pme'`); sin tormenta de errores de medidor ni
  desconexiones PME recurrentes. Runbook: `docs/runbooks/observability.md`.
- **Si falla:** mover B a **Opción B** o gestionar credenciales dedicadas. Mitigante de fondo:
  el medidor es primario y PME solo fallback (D-116), así que la contención PME tiene impacto
  acotado.
- **Documentar el resultado** como ADR en `docs/decisions.md`.

---

## 4. Contrato cross-repo (Bitácora)

`deploy/nginx.conf` proxea `/api/eventos-dashboard` → `:3002` (backend de `Bit-cora-g3`).
En el caso actual, **B tendrá su propia Bitácora** desplegada junto a él, así que su nginx
proxea a `127.0.0.1:3002` igual que A — sin cambios. Si Bitácora-B aún no está, las features
de autorizaciones/eventos degradan limpio (catch en `useEventosBitacora`); también se puede
poner `bitacoraPlantas: []` en su `config.json` para no intentar el fetch.

> El despliegue de la Bitácora propia de B es una dependencia paralela (otro repo); el mismo
> principio "config, no fork" aplica allí.

---

## 5. Despliegue y flujo de actualización

### 5.1 Misma ruta en ambos servidores

Son máquinas distintas → no hay colisión: `APP_DIR=/var/www/dashboard-gen` **igual en ambos**.
Así `deploy/nginx.conf` y `deploy/dashboard-ws.service` se reutilizan **sin cambios**. Lo único
distinto por servidor: `server/.env` y `instance/config.json`.

### 5.2 nginx sirve `config.json` desde fuera del bundle

`deploy/nginx.conf` ya incluye:
```nginx
location = /config.json {
    alias /var/www/dashboard-gen/instance/config.json;
    default_type application/json;
    add_header Cache-Control "no-store";
}
```
Mantiene `dist/` inmutable y el config externo → en Docker se monta como volumen o lo genera
el entrypoint.

### 5.3 Provisión inicial (servidor B)

1. Crear la BD en el SQL Server destino + login con permisos (tablas autocreadas al arrancar).
2. Clonar el repo en `/var/www/dashboard-gen` (rama `release`, ver §5.5).
3. `sudo cp deploy/config.guajira.json instance/config.json`.
4. Crear `server/.env` con `DB_*` del nuevo host y las credenciales compartidas.
5. Correr `deploy/setup.sh` (instala Node/nginx/Playwright, build, nginx, systemd; siembra
   `instance/config.json` con gec3 si no existe — sobreescribir con guajira como en el paso 3).

### 5.4 Actualización (idéntica en ambos servidores)

`deploy/update.sh` es instancia-agnóstico (el build no depende de la instancia):
```bash
sudo /var/www/dashboard-gen/deploy/update.sh
```
La identidad (`server/.env` + `instance/config.json`) se setea una vez en la provisión y
`update.sh` no la toca.

### 5.5 Paralelo pero independiente: rama `release`

- Fuente de verdad: `main` en el único `origin`.
- Para desacoplar el *timing*, los servidores siguen una rama **`release`** (o tags `vX.Y`),
  no `main` directo. Flujo: merge a `main` → validar → `git push origin main:release`.
- **Paralelo:** mismo `update.sh` en ambos. **Independiente:** actualizás B, lo observás, y
  recién después A; si B falla, A sigue en la versión previa.

### 5.6 Migración en sitio de un servidor pre-multi-instancia

Para un servidor que ya corre el dashboard desde antes de la bifurcación (sin `instance/`,
sin `location = /config.json` en nginx, sin `update.sh` en disco — `update.sh` no puede
auto-instalarse, esta migración es manual y una sola vez):

```bash
cd /var/www/dashboard-gen
sudo git fetch origin
sudo git checkout <rama-con-multi-instancia>     # main, una vez mergeado

# Identidad de instancia (una sola vez; update.sh no la toca)
sudo mkdir -p instance
sudo cp deploy/config.<instancia>.json instance/config.json

# nginx cambió (agrega location = /config.json)
sudo cp deploy/nginx.conf /etc/nginx/sites-available/dashboard-gen
sudo nginx -t && sudo systemctl reload nginx

sudo npm ci && sudo npm run build
cd server && sudo npm ci
sudo systemctl restart dashboard-ws
```

Verificar: `curl -s http://localhost/config.json` devuelve la instancia esperada y
`curl -s http://localhost/health` responde. De ahí en adelante aplica §5.4.

**Gotcha visto en producción (GEC3, 2026-06):** si `.git/objects` quedó con dueños mezclados
(deploys previos como root), `git fetch` sin sudo falla con `insufficient permission for
adding an object to repository database`. Correr git con sudo; si root se queja de
`dubious ownership`, registrar la ruta: `sudo git config --global --add safe.directory
/var/www/dashboard-gen` (`update.sh` ya lo hace solo en cada corrida).

---

## 6. Migración a Docker (fase futura)

Lo hecho en §1-§5 ya lo facilita: **build instancia-agnóstico** (un artefacto), **config de UI
en runtime** (archivo externo), **backend 100% env-driven** (`--env-file` nativo → `--env-file`
de Docker), y `server.js` **no sirve estáticos** (separación limpia SPA/backend).

Forma objetivo:
- `Dockerfile` sobre `mcr.microsoft.com/playwright` (Chromium ya resuelto).
- Entrypoint que **genera `instance/config.json` desde variables de entorno** (o se monta como
  volumen) → **una imagen, N instancias** vía `docker run --env-file instance.env`.
- `docker-compose.yml` con dos servicios (gec3/guajira); cada `--env-file` configura **todo**
  (DB + PME + medidores + UI). nginx en host o como contenedor.
- **MSSQL queda externo** (no se dockeriza).
- **Validar acceso de red** del contenedor a las IPs de los medidores (`network_mode: host` o
  ruta a la LAN corporativa).

---

## 7. Anti-patrones a evitar

- ❌ **Copiar el repo** o **rama larga por instancia** → divergencia permanente.
- ❌ **`if (instancia === 'B')`** disperso por componentes → la diferencia es config, no ramas.
- ❌ **Commitear `server/.env`** o `instance/config.json` → solo plantillas `deploy/config.*.json`.
- ❌ **`vite --mode` / `.env.<modo>`** → rompe "una imagen, N instancias"; usar runtime config.
- ❌ **`git pull` de `main`** directo en producción sin gate `release`/tag.
- ❌ **APP_DIR distinto por servidor** → al ser máquinas separadas, mantenerla igual reutiliza
  `deploy/` sin tocar nada.
```
