# Auto-recovery de snapshots REST en `useRealtimeData`

**Verifica:** el hook frontend re-fetchea los 5 endpoints REST (periods,
despacho-final, proyeccion, proyeccion-periodos, desviacion-periodos)
periódicamente cada 5 min y al reconectar el WebSocket — la red de seguridad
contra el bug que dejaba pestañas con state stale para siempre.

## Cuándo correrlo

- Tras deploy del fix `866f9be fix(useRealtimeData)`.
- Si una pestaña vieja del dashboard muestra todo en cero o con desviaciones de -100%.
- Para validar comportamiento en el caso "abrir dashboard durante restart del backend".

## Test 1: refetch periódico cada 5 min

**No requiere comandos en server.** Test visual desde browser:

1. Abrir el dashboard (`http://192.168.17.65/` en prod, o `http://localhost:5173/` en dev).
2. Abrir DevTools (F12) → tab **Network** → filtrar por `/api/`.
3. Al cargar la página deberías ver 5 requests GET:
   - `/api/periods/today`
   - `/api/despacho-final/today`
   - `/api/proyeccion/today`
   - `/api/proyeccion-periodos/today`
   - `/api/desviacion-periodos/today`
4. **Esperar 5 minutos** sin tocar nada.
5. Verificar que los **mismos 5 requests aparecen de nuevo** automáticamente.

## Test 2: refetch on WS reconnect

Más rápido que el test 1 (no hay que esperar 5 min):

1. Con el dashboard abierto y `En vivo` en el header, F12 → Network.
2. En otra ventana, **reiniciar el backend**:
   ```bash
   # Server prod
   sudo systemctl restart dashboard-ws
   ```
   ```powershell
   # Local — Ctrl+C en la terminal que corre `npm start` y volver a arrancar
   ```
3. El header del dashboard pasa a `Reconectando` y luego vuelve a `En vivo`.
4. **Verificar en F12 → Network** que los 5 requests REST se dispararon
   automáticamente cuando el WS reconectó (no esperaron al próximo tick de 5 min).

## Esperado

En Network tab, durante el test 2:
```
GET /api/periods/today          200  (cargó al mount)
GET /api/despacho-final/today   200
GET /api/proyeccion/today       200
GET /api/proyeccion-periodos/today  200
GET /api/desviacion-periodos/today  200
... esperando ...
WS /ws                          (Status: Pending → reconectando)
GET /api/periods/today          200  ← gatillado por reconnect
GET /api/despacho-final/today   200  ← idem
... etc
```

## Interpretación

- 🟢 Los 5 requests aparecen tanto al mount como cada 5 min y al reconectar WS.
- 🟢 Si abrís la pestaña en mal momento (backend reiniciando), los datos se
  autocorrigen al primer tick exitoso sin necesidad de Ctrl+Shift+R.
- 🔴 Solo aparecen 5 requests al inicio y nunca se repiten → el commit
  `866f9be fix(useRealtimeData)` no llegó a producción. Verificar
  `git log --oneline -10` y rebuild + restart del servicio.
- 🔴 Aparecen los 5 requests pero el dashboard sigue con valores stale → el
  problema no es del hook sino del backend (`/api/periods/today` está devolviendo
  array vacío). Cruzar con `02-Despacho Final (Email)/persistencia-db.md`.

## Cómo verificar la versión del bundle

El bundle incluye un hash que cambia con cada build:

```bash
# Server
ls /var/www/dashboard-gen/dist/assets/index-*.js
# Esperado tras este fix: index-j6GIoZMT.js (o un hash más reciente, no el viejo DinBCB5g)
```

```powershell
# Local
Get-ChildItem "dashboard-gen-gec3\dist\assets\index-*.js"
```

Si todavía aparece el hash viejo en producción → falta `npm run build` post-pull.

## Si falla

```bash
cd /var/www/dashboard-gen
git log --oneline | grep "fix(useRealtimeData)"
# Si no aparece el commit 866f9be:
git pull
npm run build
sudo systemctl restart dashboard-ws
```

Tras eso, **ctrl+shift+R en el browser** para que descargue el nuevo bundle.
