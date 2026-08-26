# Qué ID usar: los dos bancos de registros de energía del ION8650

El medidor publica **las mismas magnitudes de energía dos veces**, en dos bancos con IDs y
codificación distintos. Este documento explica en qué se diferencian, cuál sirve, y cómo
volver a comprobarlo.

## Los dos bancos

**Banco A — bloque «kWh/kVArh», INT32 clásico (base 65536), 2 registros:**

| Magnitud | Registro |
| --- | --- |
| kWh del | 40230 |
| kWh rec | 40232 |
| kVARh del | 40234 |
| kVARh rec | 40236 |
| kVAh del+rec | 40238 |

**Banco B — bloque «Energy/THD», INT32-M10K (base 10000), 2 registros:**

| Magnitud | Registro |
| --- | --- |
| kWh del | 40091 |
| kWh rec | 40093 |
| kWh del+rec | 40095 |
| kWh del−rec | 40097 |
| kVARh del | 40099 |
| kVARh rec | 40101 |
| kVARh del+rec | 40103 |
| kVARh del−rec | 40105 |

Cuatro magnitudes están en los dos bancos: **kWh del, kWh rec, kVARh del y kVARh rec**. Esas
son las que se pueden poner lado a lado. `kVAh del+rec` solo existe en A; las combinaciones
`del+rec` y `del−rec` solo existen en B.

## Mod10K no es un INT32

El banco B declara `INT32-M10K`. **No es un entero binario**: cada registro de 16 bits lleva un
grupo de **4 dígitos decimales**, así que el valor es

```
valor = w0 · 10000 + w1        (no w0 · 65536 + w1)
```

El bit 15 de `w0` es el signo. El tope del formato con 2 registros es **327.679.999**.

Leer un registro Mod10K como si fuera INT32 da un número plausible y equivocado. Lo traicionero
es que **a veces acierta**: mientras `w0` no cambie, el *incremento* entre dos lecturas coincide
con el correcto, así que un cálculo basado en deltas parece funcionar y solo se rompe cuando
`w1` da la vuelta. Ejemplo real de GEC32:

| | palabras | decodificado |
| --- | --- | --- |
| 40091 leído como Mod10K | `[747, 6140]` | **7.476.140** ← coincide con 40230 del banco A |
| 40091 leído como INT32 | `[747, 6140]` | 48.961.532 ← equivocado |

## Cómo comprobarlo

Desde `server/`:

```bash
npm run shadow:registros              # captura 1 h de los dos bancos en los 6 medidores
npm run shadow:registros:analyze      # reporte y veredicto
python scripts/export-registros-xlsx.py   # el mismo resultado como Excel
```

La captura no toca producción. El Excel queda en
[`comparacion-registros-energia.xlsx`](./comparacion-registros-energia.xlsx).

Variables: `REGISTROS_DURATION_MIN` (60), `REGISTROS_POLL_MS` (5000).

## El método, y por qué está armado así

**Se guardan las palabras de 16 bits crudas**, no solo los valores decodificados. Si mañana hay
que probar otra decodificación, se hace sobre los datos ya capturados sin volver a medir.

**El orden de lectura de los dos bancos se alterna entre ticks.** Los bancos están en bloques
Modbus distintos: son dos peticiones FC03 separadas por unos milisegundos, y el contador sigue
subiendo entre una y otra. Con un orden fijo, esa diferencia tendría siempre el mismo signo y
se podría confundir con un sesgo real entre registros. Alternando `A→B` y `B→A`, una diferencia
causada por el desfase **cambia de signo con el orden** y una discrepancia real no. Convierte
"probablemente es desfase de lectura" en algo demostrable.

**Tres evidencias independientes**, de menos a más concluyente:

1. **Concordancia instantánea.** ¿Los dos bancos publican el mismo número en cada tick?
2. **Identidades internas del banco B.** `del+rec` tiene que ser exactamente `del` más `rec`. Es
   la mejor verificación posible porque no depende de ninguna referencia externa: compara el
   banco contra sí mismo, y por lo tanto valida de paso que la decodificación Mod10K es correcta.
3. **Contraste contra la energía real.** Se integra la potencia del registro 40204 (kW tot)
   sobre la ventana: eso dice cuánta energía hubo de verdad. El registro que sirve es el que la
   reproduce.

Una lectura saturada o malformada **no cuenta como medida**: el Δ de la ventana se calcula entre
la primera y la última lectura *utilizable*, y el motivo del descarte se informa. Si no, un
registro clavado en su tope parecería un contador que simplemente no se movió.

## Resultados — corrida de 1 h del 2026-07-21

Ventana `2026-07-21 14:26 → 15:26` hora Bogotá, 1.00 h exacta, **719 ticks sin un solo error de
lectura**, 5616 registros sobre los 6 medidores.

### Veredicto: usar el banco A (40230..40238)

| Magnitud | Banco A | Banco B | ¿Publican lo mismo? | Usar |
| --- | --- | --- | --- | --- |
| kWh del | 40230 | 40091 | sí, valor idéntico | **40230** |
| kWh rec | 40232 | 40093 | sí, valor idéntico | **40232** |
| kVARh del | 40234 | 40099 | sí, valor idéntico | **40234** |
| kVARh rec | 40236 | 40101 | sí, valor idéntico | **40236** |

**Los dos bancos llevan exactamente el mismo número.** No son mediciones distintas: es el mismo
acumulador publicado con dos codificaciones. En las 936 lecturas de cada medidor los valores
coinciden dígito a dígito.

**Pero el banco B ya está roto en dos medidores.** En `GEC3_1-prim` y `GEC3_2-prim` los
registros **40093, 40095 y 40097 están saturados en las 936 lecturas**: el acumulador real va en
460 millones y el techo del formato Mod10K es 327.679.999. El registro no da error — devuelve el
centinela `0x7FFF/0` y se ve como un contador congelado. El banco A los reporta sin problema.

**`40097` (kWh del−rec) no sirve en ninguno de los 6.** En los cuatro medidores donde no está
saturado, publica palabras que no son Mod10K válido (la palabra baja pasa de 9999).

**Los registros combinados dan la vuelta a los 10.000.000.** `40095` (kWh del+rec) y `40105`
(kVARh del−rec) fallan la identidad contra sus términos por exactamente ±10.000.000. Su valor
absoluto no sirve; la combinación hay que calcularla a partir de `del` y `rec`.

### Contraste contra la energía real

Integrando 40204 (kW tot) sobre la hora, `40232` reproduce la energía con un error de −0.06 % a
+0.04 % en los 6 medidores. `40230` (kWh *delivered*) no se mueve: la frontera de Gecelca es de
entrada, así que con la planta generando lo que avanza es *received*.

| Medidor | Δ 40232 (kWh) | vs. energía real |
| --- | --- | --- |
| GEC32-prim | 223 377 | −0.01 % |
| GEC32-res | 223 383 | −0.01 % |
| GEC3_1-prim | 26 592 | +0.04 % |
| GEC3_1-res | 26 576 | −0.00 % |
| GEC3_2-prim | 26 752 | −0.06 % |
| GEC3_2-res | 26 772 | −0.00 % |

### Dos detalles del medidor que salieron de paso

**El contador late una vez por segundo.** No sube de forma continua: avanza en escalones del
tamaño de un segundo de energía (62 cuentas a 223 MW). Por eso, cuando las dos peticiones Modbus
caen a los dos lados de un latido, los bancos difieren en exactamente un escalón — y el signo de
esa diferencia sigue al orden de lectura, como confirma la alternancia. Es la única causa de
desacuerdo observada, y no es del registro.

**Los registros combinados se actualizan un latido después que sus términos.** Las identidades
`del+rec` y `del−rec` fallan por uno o dos escalones en varios medidores. No es error de
decodificación ni de medición: es el orden interno de actualización del medidor.

Tras clasificar todo lo anterior, **no queda ninguna discrepancia sin explicar** en las 5616
lecturas.

## Archivos

| Archivo | Qué hace |
| --- | --- |
| `server/scripts/lib/regDecode.js` | Decodificadores INT32 y Mod10K, catálogo de registros, pares e identidades. |
| `server/scripts/shadow-registros-watch.js` | Captura. Lee los dos bancos alternando el orden y guarda las palabras crudas. |
| `server/scripts/analyze-registros.js` | Reporte y veredicto. Con `--json` emite el análisis como datos. |
| `server/scripts/export-registros-xlsx.py` | Excel comparativo. Consume el `--json`, no recalcula. |
| `server/scripts/lib/xlsxfmt.py` | Formato de Excel compartido con el exportador de la comparación de medidores. |
| `server/__tests__/regDecode.test.js` | Tests del decodificador, con lecturas reales de los medidores. |

Relacionado: [`comparacion-medidores-reserva.md`](./comparacion-medidores-reserva.md) (primaria
vs. reserva) y [`combo-modbus-ion8650.md`](./combo-modbus-ion8650.md) (el combo de potencia).
