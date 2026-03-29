# Instrucciones: Integrar cuenta autenticada de XM para generación real del día

## Contexto

Actualmente el dashboard usa la API pública de XM (`servapibi.xm.com.co`) sin autenticación para obtener despacho (`GeneProgDesp`) y redespacho (`GeneProgRedesp`). Estas métricas funcionan para el día actual.

Sin embargo, la métrica de generación real (`Gene`) tiene ~3 días de retraso en la API pública, por lo que no sirve para el día de hoy. La columna GENERACIÓN (MW) en la tabla actualmente solo muestra datos para el periodo actual usando el PME vía WebSocket, y 0 para el resto de periodos.

Con una cuenta autenticada de XM (portal NEON/BI), se debería poder acceder a `Gene` con datos del día actual (~1h de retraso).

## Datos que necesito del usuario

Antes de hacer cambios, necesito que me proporciones:

1. **URL base de la API autenticada** — puede ser diferente a `servapibi.xm.com.co`. Ejemplos posibles:
   - `https://sinergox.xm.com.co/...`
   - `https://neon.xm.com.co/api/...`
   - La misma URL pero con headers de autenticación
2. **Método de autenticación** — ej: API key, Bearer token, usuario/contraseña, OAuth2, cookie de sesión
3. **Credenciales** — token, API key, o usuario/contraseña según el método
4. **Formato de respuesta** — verificar si la API autenticada devuelve el mismo formato JSON que la pública:
   ```json
   {
     "Items": [
       {
         "Date": "2026-03-28",
         "HourlyEntities": [{
           "Id": "Recurso",
           "Values": {
             "code": "GEC3",
             "Hour01": "146575.35",
             ...
           }
         }]
       }
     ]
   }
   ```
5. **Confirmar que `Gene` devuelve datos del día actual** — ejecutar una prueba manual con la cuenta:
   ```
   POST {url_base}/hourly
   Content-Type: application/json
   Authorization: {tu_token}

   {
     "MetricId": "Gene",
     "StartDate": "YYYY-MM-DD",  (fecha de hoy)
     "EndDate": "YYYY-MM-DD",
     "Entity": "Recurso",
     "Filter": []
   }
   ```
   Compartir la respuesta (o al menos confirmar que `Items` no está vacío y los códigos `GEC3`, `GE32`, `TGJ1` aparecen).

## Cambios a realizar

### 1. Variables de entorno para credenciales

Crear un archivo `.env` en la raíz del proyecto (ya está en `.gitignore`):

```env
VITE_XM_AUTH_URL=https://...    # URL base de la API autenticada (si es diferente)
VITE_XM_AUTH_TOKEN=Bearer xxx   # Token o API key
```

### 2. Proxy en `vite.config.js`

**Archivo:** `vite.config.js`

Agregar un segundo proxy para la API autenticada si la URL es diferente. Si es la misma URL pero con headers, agregar los headers al proxy existente:

```js
// Opción A: URL diferente → nuevo proxy
"/api/xm-auth": {
  target: process.env.VITE_XM_AUTH_URL || "https://servapibi.xm.com.co",
  changeOrigin: true,
  rewrite: path => path.replace(/^\/api\/xm-auth/, ""),
  headers: {
    Authorization: process.env.VITE_XM_AUTH_TOKEN || "",
  },
},

// Opción B: Misma URL → agregar headers al proxy existente
"/api/xm": {
  target: "https://servapibi.xm.com.co",
  changeOrigin: true,
  rewrite: path => path.replace(/^\/api\/xm/, ""),
  headers: {
    Authorization: process.env.VITE_XM_AUTH_TOKEN || "",
  },
},
```

### 3. Fetch de `Gene` en `useXmDispatch.js`

**Archivo:** `src/hooks/useXmDispatch.js`

Agregar una función `fetchGene` que use el endpoint autenticado y agregarla al `fetchAll()`:

- Crear función `fetchMetricAuth(metricId, dateStr)` similar a `fetchMetric` pero usando `/api/xm-auth/hourly` (o el endpoint autenticado correspondiente)
- En `fetchAll()`, agregar `Gene` al `Promise.all` con `.catch(() => ({}))` para no tumbar despacho/redespacho si falla:
  ```js
  const [despData, redespData, geneData] = await Promise.all([
    fetchMetric("GeneProgDesp", dateStr),
    fetchMetric("GeneProgRedesp", dateStr),
    fetchMetricAuth("Gene", dateStr).catch(() => ({})),
  ]);
  ```
- Incluir `generacion: geneData[xmCode] || null` en el resultado por unidad
- En `fetchRedespacho`, preservar `generacion` del fetch anterior

### 4. Tabla: usar `Gene` para periodos pasados

**Archivo:** `src/components/Table.jsx`

Cambiar la lógica de la columna GENERACIÓN (MW):

- **Periodos anteriores al actual** (`i < currentIdx`): usar dato de `Gene` de la API autenticada (MW por hora). Si no hay dato, mostrar 0.
- **Periodo actual** (`i === currentIdx`): seguir usando el acumulado PME (`pmeAccumulated`).
- **Periodos futuros** (`i > currentIdx`): mostrar 0.

```js
const hasXmGene = !!xmUnit?.generacion;
// ...dentro del .map():
let final_;
if (i === currentIdx) {
  final_ = pmeGenMWh;  // PME acumulado en tiempo real
} else if (i < currentIdx && hasXmGene) {
  final_ = xmUnit.generacion[i] ?? 0;  // Gene de API autenticada
} else {
  final_ = 0;
}
```

### 5. Verificar códigos de unidades

**Archivo:** `src/hooks/useXmDispatch.js`

Confirmar que los códigos en `UNIT_XM_CODE` coinciden con los que devuelve `Gene` en la API autenticada. En la API pública se verificó que existen `GEC3`, `GE32`, `TGJ1` pero **NO** `TGJ2`. Si la API autenticada tampoco tiene `TGJ2`, investigar cuál es el código correcto (puede ser otro código SIC para Termoguajira 2).

### 6. Gráfica CEP: sin cambios

**Archivo:** `src/components/Chart.jsx`

La gráfica de control sigue usando datos PME en tiempo real (promedios por minuto del periodo actual). No requiere cambios con esta integración.

## Resumen de archivos a modificar

| Archivo | Cambio |
|---|---|
| `.env` (nuevo) | Credenciales XM autenticada |
| `vite.config.js` | Proxy con headers de auth |
| `src/hooks/useXmDispatch.js` | Agregar fetch de `Gene` con auth |
| `src/components/Table.jsx` | Usar `Gene` para periodos pasados, PME para actual |

## Prueba de validación

Después de los cambios, verificar:

1. La tabla muestra valores reales de generación para periodos pasados (no 0)
2. El periodo actual sigue mostrando el acumulado PME
3. Los periodos futuros muestran 0
4. Si la API autenticada falla, despacho y redespacho siguen funcionando (no se caen por el `.catch`)
5. La gráfica CEP sigue funcionando con datos PME
