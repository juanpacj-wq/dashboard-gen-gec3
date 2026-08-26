# Comparación 1-a-1: medidores de reserva vs. primarios (Modbus TCP)

Gecelca tiene un segundo juego de medidores ION8650 —los **de reserva**— en las fronteras de
GEC3 y GEC32. Este documento describe cómo se comprueba con datos que leen lo mismo que los
primarios, y guarda el resultado de la medición.

## Por qué importa

El 2026-07-19 hubo que reactivar `PME_ENABLED=1` porque los medidores de Gecelca dejaron de
responder Modbus desde producción. El problema es que **el PME no es un fallback
independiente**: lee los MISMOS ION8650, así que con los medidores caídos sirve un valor
congelado que el dashboard da por bueno y que contamina el acumulado.

Un juego de medidores **físicamente distinto** sí sería un fallback real. Antes de apoyarse en
él hay que demostrar que lee lo mismo — eso es lo que mide esta comparación.

## Mapa de pares

| Par | Unidad | Primario | Reserva |
| --- | --- | --- | --- |
| `GEC32` | GEC32 | `192.168.200.2` | `192.168.200.3` |
| `GEC3_1` | GEC3 | `192.168.200.5` | `192.168.200.7` |
| `GEC3_2` | GEC3 | `192.168.200.6` | `192.168.200.8` |

Las IPs de reserva viven en `.env` como `IP_<ID>_RESERVA`. **El sufijo es obligatorio**: si
reusan el nombre de la primaria, `node --env-file` se queda con la última definición y el
poller de producción pasa a leer la reserva sin dar ningún error. Estas variables no las usa
el poller — solo los scripts de comparación.

Modbus TCP no usa autenticación, así que las `PSW_*_RESERVA` no hacen falta para esto.

## Cómo correr la comparación

Desde `server/`:

```bash
npm run shadow:reserva                     # captura 1 h (auto-stop). RESERVA_DURATION_MIN=2 para un humo corto
npm run shadow:reserva:analyze             # reporte + veredicto en consola
python scripts/export-reserva-xlsx.py      # el mismo resultado como Excel
```

El Excel queda en [`comparacion-medidores-reserva.xlsx`](./comparacion-medidores-reserva.xlsx),
con 8 hojas: **Resumen** (veredicto y tabla por par), **Criterios** (los 7 criterios bloque por
bloque), una hoja de **detalle tick a tick** por par y otra para la suma de GEC3 (1792 filas
cada una, con gráficas de superposición y de residuo), **Energía** (contador crudo y avance) y
**Método**. Las cifras del resumen y de los criterios no se recalculan en el exportador: salen
de `analyze-reserva.js --json`, el mismo código que imprime el reporte de consola, así que el
Excel y el reporte no pueden divergir. Requiere `openpyxl`.

La captura escribe JSONL a `server/traces/reserva/` (ya ignorado por git) y **no toca
producción**: ni BD, ni orchestrator, ni `server.js`. Corre desde la máquina de desarrollo,
que alcanza los 6 medidores en `:502`.

Presupuesto de conexiones: 4 sockets por par (2 de potencia + 2 de energía). Sobre cada
medidor primario eso se suma al Node de producción y al sink Python → 4 de los 8 slots que
admite Modbus. Es la razón para no correrlo además en capibara.

Variables opcionales: `RESERVA_DURATION_MIN` (60), `RESERVA_ENERGY_POLL_MS` (60000, 0 apaga la
energía), `METER_MODBUS_ENERGY_REGISTER` (40232), `RESERVA_RAMP_KW_PER_S` (10),
`RESERVA_MIN_ENERGY_WINDOW_H` (0.5).

## Qué mide y por qué

Cada `METER_POLL_MS` se leen los dos medidores del par en paralelo (registro 40204, kW tot) y
se guardan ambos resultados con la diferencia **con signo**, `Δ = primaria − reserva`. El signo
importa: un sesgo sistemático es calibración y una dispersión simétrica es ruido, y un promedio
de valores absolutos los confunde.

Tres decisiones de método que no son obvias:

**Las tolerancias son relativas a la potencia media absoluta de la ventana**, no absolutas en
kW. A 224 MW un umbral fijo en kW sería trivial de pasar; con la unidad en reserva (~0.7 MW) el
error relativo punto a punto se dispara sin que el medidor tenga nada malo.

**Se descartan los ticks contaminados por el desfase de muestreo, no los que tienen rampa.**
Los dos medidores del par no se leen en el mismo instante; ese desfase produce una diferencia
aparente de `|dP/dt| · skew` que no es del medidor. Pero descartar por "hay rampa" a secas
tiraría casi toda la ventana (en una planta de 224 MW la potencia fluctúa decenas de kW entre
muestras de 2 s) y encima la rampa es justo lo que le da rango a la regresión. Lo que contamina
no es moverse: es moverse rápido *mientras* hay desfase.

**R² se imprime pero no decide.** `R² = 1 − SSE/SST`, y SST depende de cuánto se movió *la
planta*, no de la calidad del medidor: dos medidores idénticos sobre una planta perfectamente
constante darían R² ≈ 0. Es un número que mezcla calidad de medición con comportamiento de la
planta, y encima es redundante con C3, que ya mide la dispersión normalizada. Lo que sí aporta
la regresión es separar escala de offset — eso es C4.

**La regresión se reporta con el error estándar de su pendiente.** `reserva = a·primaria + b`
separa un error de escala (`a ≠ 1`, p. ej. relación de TC/TP distinta) de un offset constante
(`b ≠ 0`). Pero si la unidad se movió poco durante la ventana, `a` sale muy lejos de 1 con una
incertidumbre enorme, y el número impreso se lee igual de contundente. Con `±2·seSlope` se
puede decir "0.871 ± 0.088" y concluir que la ventana no alcanza para juzgar la escala, en vez
de reprobar un medidor sano.

Además, el análisis resuelve dos preguntas que no se pueden dar por sentadas:

- **Verificación del pareo de GEC3.** Que `.5↔.7` y `.6↔.8` era una suposición basada en el
  orden de las IPs. Se recalcula el acuerdo con el mapeo cruzado y gana el que dé menor Δ a lo
  largo de toda la ventana.
- **GEC3 a nivel de unidad.** `config.js` declara GEC3 con `combine:'sum'`, así que el
  dashboard consume `prim1+prim2`. Comparar las sumas es lo que de verdad importa, y además es
  inmune a que el pareo esté cruzado.

## El registro de energía acumulada es 40232, no 40230

`docs/combo-modbus-ion8650.md` dice "para la acumulada es 40230". **Está mal**: 40230 está
congelado en los 6 medidores (Δ = 0 con la planta a 224 MW).

El acumulador real se encontró por barrido de deriva: se leyeron los registros 40001–40360 con
90 s de separación y se buscó cuál avanzaba al ritmo de `|kW|·Δt`. **40232 acierta en los 6**
(error 0.3–2.2 % en una ventana de 2 min, que es resolución del contador y se diluye en una
hora), y cuenta en **kWh** (el contraste contra la integral trapezoidal de la potencia da
≈1.02×).

> **Corrección (2026-07-21, misma tarde).** Este documento afirmaba antes que «los mapas Modbus
> no son idénticos entre medidores», porque 40093 y 40095 avanzaban en unos medidores y estaban
> en cero en otros. **Esa conclusión era equivocada.** Los mapas sí son idénticos; el error era
> de decodificación: 40091..40105 son `INT32-M10K` (base 10000) y se estaban leyendo como INT32
> binario. El «cero» de algunos medidores era en realidad el centinela de saturación `0x7FFF/0`,
> que aparece cuando el acumulador pasa el techo del formato Mod10K (327.679.999). Análisis
> completo en [`comparacion-registros-energia.md`](./comparacion-registros-energia.md).
>
> Se mantiene la conclusión práctica —**40232 es la energía acumulada que sirve**— pero por otro
> motivo: 40230 es kWh *delivered*, que en una frontera de entrada no se mueve, y 40232 es kWh
> *received*, que es lo que avanza cuando la planta genera.

## Criterios de éxito

| # | Criterio | Umbral |
| --- | --- | --- |
| C1 | Nulls de la reserva | ≤ 0.1 % y no peor que la primaria en > 0.1 pp |
| C2 | Sesgo \|media(Δ)\| | ≤ 0.25 % de la potencia media absoluta |
| C3 | Dispersión p95(\|Δ\|), ticks limpios | ≤ 0.5 % de la potencia media absoluta |
| C4 | Escala y offset | pendiente ∈ [0.995, 1.005] y \|intercepto\| ≤ 0.25 % |
| C5 | Signo | 0 mismatches |
| C6 | Energía de la ventana | ≤ 0.5 % de diferencia entre los Δ de los contadores |
| C7 | Latencia p99 de la reserva | < `METER_TIMEOUT_MS` |

Un criterio puede salir **sin señal** (`·`) en vez de aprobado o reprobado: pocos ticks
limpios, potencia demasiado plana para resolver la escala, o ventana de energía menor a media
hora (por debajo de eso el desfase de latcheo entre los dos contadores domina el resultado). Un
criterio sin señal no reprueba, pero se cuenta y se informa: un "PASS" no debe leerse como
respaldado por datos cuando no lo está.

Veredicto por par:

- **INTERCAMBIABLE** — ningún criterio reprobado.
- **USABLE CON CORRECCIÓN CONOCIDA** — falla el sesgo o la escala, pero la reserva sigue
  fielmente a la primaria (R² alto), no tiene nulls propios y no invierte el signo. La
  pendiente y el intercepto de la regresión son el factor de calibración a aplicar.
- **NO INTERCAMBIABLE** — cualquier otro caso.

## Resultados — corrida de 1 h del 2026-07-21

Ventana `2026-07-21T16:45:49Z → 17:45:49Z` (11:45–12:45 Bogotá), 1 h exacta, **1792 ticks por
par** (5376 lecturas pareadas de potencia + 366 del contador de energía). Las dos plantas
estuvieron en carga durante toda la ventana: GEC32 en ~223.6 MW y cada medidor de GEC3 en
~25.4 MW.

### Veredicto: los 3 pares INTERCAMBIABLES

**Disponibilidad perfecta.** 0 nulls en los 6 medidores, en 10 752 lecturas. Ni un timeout, ni
una excepción Modbus, ni un episodio. Latencia p99 de la reserva entre 118 y 132 ms, contra un
timeout de 6000 ms.

| Par | \|P\| media | Sesgo (Δ = prim − res) | p95 \|Δ\| | Energía 1 h | p99 reserva |
| --- | --- | --- | --- | --- | --- |
| `GEC32` | 223 635 kW | **+6.29 kW (0.003 %)** | 170.7 kW (0.076 %) | **0.003 %** | 132 ms |
| `GEC3_1` | 25 361 kW | **−4.21 kW (−0.017 %)** | 116.3 kW (0.459 %) | **0.051 %** | 118 ms |
| `GEC3_2` | 25 516 kW | **+4.47 kW (0.018 %)** | 117.5 kW (0.461 %) | **0.063 %** | 127 ms |
| **UNIDAD GEC3 (suma)** | 50 877 kW | **+0.12 kW (0.000 %)** | 117.9 kW (0.232 %) | **0.006 %** | — |

El sesgo está tres órdenes de magnitud por debajo de la tolerancia y **cambia de signo entre
pares** (GEC32 y GEC3_2 positivos, GEC3_1 negativo), que es la firma de ruido de medición
independiente y no de un error de calibración sistemático.

**La energía acumulada es la evidencia más fuerte**, porque no depende del instante de muestreo:
en una hora GEC32 avanzó 223 634 kWh en la primaria contra 223 640 kWh en la reserva — **6 kWh
de diferencia sobre 223 MWh**. Y el contador validó su propia escala: avanzó 1.0008× la integral
trapezoidal de la potencia, confirmando que 40232 cuenta en kWh.

**El valor que consume el dashboard es el mejor de todos.** GEC3 se publica como
`combine:'sum'`, y la suma de los dos medidores da sesgo de 0.121 kW sobre 50.9 MW —
literalmente 0.000 %. Tiene sentido: sumar promedia el ruido independiente de los dos pares.
Ahí también la regresión sí resuelve, con pendiente **0.999733 ± 0.0044** y offset de −13.7 kW
(−0.027 %): sin error de escala ni offset apreciables.

**Pareo confirmado.** El mapeo asumido (`.5↔.7`, `.6↔.8`) da 79.0 kW de \|Δ\| p50 sumado contra
317.6 kW del cruzado — un factor 4 de margen. Las IPs de reserva corresponden a las primarias
en el mismo orden.

### Lo que quedó sin señal

En los tres pares individuales, **C4 no se pudo resolver**: la pendiente sale
0.971–0.988 con una incertidumbre de ±0.009 a ±0.010, muy por encima del ±0.005 que exige el
criterio. No es un problema de los medidores — es que cada unidad por separado varió poco
durante la hora, y sin recorrido en potencia no hay palanca para estimar una escala. A nivel de
unidad GEC3 sí resolvió, porque sumar reduce el ruido residual y estrecha el intervalo.

Para cerrar C4 por par individual haría falta una ventana con las unidades tomando y soltando
carga (una rampa de despacho, un arranque). No bloquea la conclusión: C2, C3 y C6 ya acotan
cualquier error de escala plausible por debajo del 0.1 %.

### Conclusión

Los medidores de reserva de GEC3 y GEC32 leen lo mismo que los primarios y están igual de
disponibles. Sirven como **fallback real** — un juego de instrumentos físicamente
independiente, a diferencia del PME, que lee los mismos ION8650 y por eso sirve un valor
congelado cuando estos se caen.

Esto habilita, como trabajo siguiente y todavía no hecho, evaluar una conmutación
primaria → reserva en el poller para el escenario del 2026-07-19.

## Archivos

| Archivo | Qué hace |
| --- | --- |
| `server/scripts/shadow-reserva-watch.js` | Captura. Reusa `ION8650ModbusClient` (incluye el self-heal de D-123). |
| `server/scripts/lib/reservaStats.js` | Estadística pura: regresión con error estándar, clasificación por desfase, integral trapezoidal, episodios de nulls. |
| `server/scripts/analyze-reserva.js` | Reporte, criterios y veredicto. Con `--json` emite el análisis como datos. |
| `server/scripts/export-reserva-xlsx.py` | Exporta a Excel. Consume el `--json` del analizador, no recalcula. |
| `server/__tests__/reservaStats.test.js` | Tests de la estadística (el veredicto sale de ahí). |

Metodología heredada de D-118 (`shadow-modbus-watch.js` + `analyze-shadow.js`), que validó
HTTP → Modbus con el mismo patrón de sombra + criterios medibles.
