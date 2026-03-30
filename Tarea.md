# Bug Fix: Tabla muestra generación incorrecta en periodos futuros

## Contexto del sistema

El dashboard muestra una tabla de generación eléctrica dividida en **24 periodos horarios** (1–24) del día actual. Los datos reales provienen de la base de datos y se van completando conforme transcurre el día.

Archivo afectado: `src/components/Table.jsx`

---

## Descripción del bug

**Los periodos que aún no han ocurrido (futuros al periodo actual) muestran valores incorrectos — datos del día anterior — en la columna GENERACIÓN (MW).**

### Comportamiento esperado

| Situación del periodo | Columna GENERACIÓN (MW) |
|---|---|
| Periodos **pasados** (ya ocurrieron) | Valor real de la BD |
| Periodo **actual** (en curso) | Valor real de la BD (parcial) |
| Periodos **futuros** (aún no ocurren) | `0` o vacío, **nunca datos históricos** |

### Comportamiento actual (incorrecto)

Los periodos futuros al periodo actual están mostrando valores de generación que corresponden al día anterior. Ejemplo observado con hora actual ~16:36 (UTC-5, Colombia), periodo actual = 17:

```
Periodo 18 → muestra 60.9 MW   ← INCORRECTO (debería ser 0)
Periodo 19 → muestra 128.2 MW  ← INCORRECTO (debería ser 0)
Periodo 20 → muestra 128.3 MW  ← INCORRECTO (debería ser 0)
... y así hasta el periodo 24
```

---

## Datos reales en la BD (día de hoy)

La BD contiene registros **solo hasta el periodo 17** (hora en curso). No hay filas para periodos 18–24 de hoy:

```
id | planta | fecha      | periodo | generacion_mw
1  | TGJ1   | 2026-03-30 | 0       | 72.13
2  | TGJ2   | 2026-03-30 | 0       | 129.04
...
14 | TGJ1   | 2026-03-30 | 16      | 36.9   (periodo 16 = hora 16 = 4pm)
...
(hasta periodo 17, que es el actual en curso)
```

**No existen filas para periodos 18 en adelante → la tabla no debería mostrar nada en esas celdas.**

---

## Causa probable

En `Table.jsx`, al hacer el join o lookup entre los periodos del día (1–24) y los datos de la BD, probablemente se está haciendo un fallback o merge con datos del día anterior cuando no se encuentra un registro para ese periodo en el día actual. Esto provoca que periodos futuros hereden valores históricos.

---

## Fix requerido

En `src/components/Table.jsx`, al mapear los 24 periodos del día:

1. **Determinar el periodo actual** (hora local Colombia, UTC-5).
2. **Para cada periodo de la tabla:**
   - Si el periodo **≤ periodo actual**: mostrar el valor real de la BD (o `—` si por alguna razón no hay dato).
   - Si el periodo **> periodo actual**: mostrar `0` o celda vacía. **Nunca usar datos de días anteriores como fallback.**
3. **Asegurarse de que el filtro de datos de la BD sea estrictamente por fecha de hoy**, sin mezclar registros de fechas anteriores.

### Pseudocódigo orientativo

```js
const currentPeriod = getCurrentPeriodColombia(); // hora actual en UTC-5

periods.map((period) => {
  if (period.numero > currentPeriod) {
    return { ...period, generacion: 0 }; // futuro → cero, sin fallback
  }
  const dbRecord = todayData.find(r => r.periodo === period.numero);
  return { ...period, generacion: dbRecord?.generacion ?? null };
});
```

---

## Notas adicionales

- La zona horaria es **America/Bogota (UTC-5)**, sin cambio de horario de verano.
- El "periodo actual" se calcula como la **hora entera actual** (ej: si son las 16:36, el periodo actual es el 16 o 17 dependiendo de cómo estén indexados — verificar si los periodos van de 0–23 o de 1–24).
- Revisar también si el endpoint/query de la BD filtra correctamente `WHERE fecha = today` para no traer registros de ayer.

---

## Archivos a revisar

- `src/components/Table.jsx` → lógica principal del bug
- El hook o servicio que consulta los datos (buscar `useGeneracion`, `fetchPeriodos`, o similar)
- El query SQL o endpoint de API que alimenta la tabla