# Convención de signos — fronteras de medición de salida vs entrada

> Detalle de dominio crítico descubierto durante la migración del PME → medidores directos. **Si los signos no se manejan, el dashboard mostrará GEC3/GEC32 invertido respecto al PME.**

## El problema

El PME centralizado (que se reemplazó) reporta `kW total` con una **convención unificada**: positivo = la planta genera, negativo = la planta consume (auxiliares en reserva, arranque, etc.).

Los medidores Schneider PowerLogic ION8650 que ahora consultamos directamente reportan `kW total` desde la perspectiva del **punto físico donde están instalados** — y ese punto no es el mismo en todas las plantas:

| Planta | Frontera de medición | Convención del medidor | Coincide con PME |
|---|---|---|---|
| **Guajira 1 (TGJ1)** | **Salida** de energía | + cuando la planta genera | ✓ Sí |
| **Guajira 2 (TGJ2)** | **Salida** de energía | + cuando la planta genera | ✓ Sí |
| **Gecelca 3 (GEC3)** | **Entrada** de energía | − cuando la planta genera | ✗ Invertido |
| **Gecelca 32 (GEC32)** | **Entrada** de energía | − cuando la planta genera | ✗ Invertido |

En las Guajiras el medidor está donde la planta **inyecta energía a la red** (frontera de salida): cuando la unidad genera, energía sale → el medidor la cuenta positiva. Cuando la unidad está parada y consume auxiliares, la energía entra → el medidor la cuenta negativa.

En los Gecelca el medidor está donde la planta **toma energía de la red** (frontera de entrada): cuando la unidad genera, la energía sale por el lado contrario (no por este medidor) y los servicios auxiliares se compensan, así que la lectura del medidor sale **negativa**. Cuando la unidad está en reserva consumiendo auxiliares, la energía sí entra por aquí → el medidor la cuenta **positiva**.

Resultado: **GEC3 y GEC32 reportan con signo opuesto al de generación neta convencional**. Sin corrección, el resto del sistema (acumulador, proyección, dashboard) interpretaría aux como generación y viceversa.

## Verificación con datos reales

El día de la migración, ambos sistemas leyendo en paralelo (planta en reserva sin generar):

```
PME centralizado:
  GUAJIRA 1: 72.8 MW   GUAJIRA 2: 72.1 MW   GECELCA 3: -0.7 MW   GECELCA 32: -5.4 MW

Medidores directos (sin corrección):
  TGJ1=72.8 MW         TGJ2=72.1 MW         GEC3=+0.7 MW         GEC32=+5.4 MW
                                            ↑ signo invertido    ↑ signo invertido
```

Las Guajiras coinciden. Los Gecelca aparecen con signo opuesto — exactamente lo predicho por la diferencia de fronteras.

## Cómo lo resuelve el extractor

`config.js` declara explícitamente el tipo de frontera por unidad:

```js
unit({ id: 'TGJ1',  …, frontierType: 'output' }),
unit({ id: 'TGJ2',  …, frontierType: 'output' }),
unit({ id: 'GEC3',  …, frontierType: 'input'  }),
unit({ id: 'GEC32', …, frontierType: 'input'  }),
```

`meterPoller.js` aplica la inversión a nivel de **unidad** (no de medidor) después de combinar. La lógica está en `#readUnit`:

```js
let valueMW = total / 1000
if (unit.frontierType === 'input') valueMW = -valueMW
if (Object.is(valueMW, -0)) valueMW = 0   // normaliza −0 → 0
```

Hacerlo a nivel unidad (no medidor) tiene una propiedad útil: para GEC3 con 2 medidores en suma, primero suma y después invierte una sola vez. Matemáticamente equivalente a invertir cada medidor y luego sumar — pero un solo punto de aplicación, más fácil de auditar.

La normalización de `−0 → 0` es por estética: `Object.is(-0, 0)` retorna `false` en JS, así que un broadcast con `−0.00 MW` podría confundir a un test estricto o a un consumidor que use `Object.is`.

## Impacto sobre otros componentes

- **`accumulator.js`** ya está en convención PME (positivo = generación). Como el poller ya invierte antes de emitir, el acumulador no necesita saber de fronteras. Cero cambios.
- **`projectionCalculator.js`** opera sobre `valueMW` en convención PME → cero cambios.
- **`db.js`** persiste `valueMW` ya corregido → cero cambios.
- **Frontend (dashboard, gauges)** asume convención PME → cero cambios.

La inversión es un **concern del extractor solamente**. Lo demás del pipeline ve los datos en la misma convención que veía cuando leía del PME.

## Si en el futuro aparece un nuevo medidor

Para una unidad nueva, identificar la frontera física:

1. **¿En qué punto está instalado físicamente el CT/PT del medidor?**
   - Si está en la salida del transformador elevador hacia la red → `frontierType: 'output'`.
   - Si está en la entrada de servicios auxiliares (la línea por donde la planta toma energía cuando no genera) → `frontierType: 'input'`.
2. **Validar con un caso conocido.** Mirar el PME y el medidor en el mismo instante:
   - Si **coinciden en signo** (ambos + o ambos −): `'output'`.
   - Si están **invertidos**: `'input'`.
3. Configurar el `frontierType` correcto en `config.js` y correr `npm test` (los tests de convención cubren ambos casos).

## Edge cases

- **Cero exacto:** El medidor reporta `0.00 kW`. Después de invertir → `−0`. La normalización lo lleva a `0`. ✓
- **Valores negativos en frontera output:** Posible cuando una Guajira está parada y consume auxiliares por la línea de salida. El medidor reporta negativo, no se invierte → llega negativo al dashboard, igual que el PME. ✓
- **Frontera mixta (un medidor por dirección):** No es nuestro caso hoy. Si llega a aparecer (poco probable en una planta), la solución es campos `frontierType` por medidor en lugar de por unidad. No vale la pena complicar la API hasta que aparezca.

## Tests

Tres casos en `__tests__/meterPoller.test.js` bajo `MeterPoller — convención de signos`:

1. `frontierType:'output'` no toca el valor del medidor (positivo o negativo, pasa tal cual).
2. `frontierType:'input'` invierte: medidor +740 → `−0.74 MW`; medidor −150000 → `+150 MW`.
3. `frontierType:'input' + combine:'sum'` (GEC3 con 2 medidores): suma primero, invierte después.

Con los valores reales observados de GEC3 (398.05 kW + 347.01 kW = 745.06 kW), el test verifica que el resultado emitido es `−0.745 MW` — coincidente con el `−0.7 MW` del PME en el mismo instante.
