"""Sign convention for ION8650 meter readings.

Las plantas con `frontier_type='output'` (Guajiras) tienen el medidor instalado en
la frontera de **salida** de energía: cuando la unidad genera, energía sale → el
medidor reporta positivo. Coincide con la convención canónica del PME.

Las plantas con `frontier_type='input'` (Gecelcas) tienen el medidor en la frontera
de **entrada** (donde la planta toma auxiliares de la red): cuando la unidad genera
neto, el medidor reporta negativo. Hay que **invertir** para devolver la convención
canónica (positivo = generación neta).

La inversión se aplica siempre **a nivel de unidad** (después de combinar todos sus
medidores), no a cada medidor por separado. Para GEC3 con dos medidores en suma:
suma primero, invierte después; matemáticamente equivalente, pero un solo punto
de aplicación.

`-0.0` se normaliza a `+0.0` para evitar sorpresas con `math.copysign` o con
serializadores estrictos.
"""

from __future__ import annotations


def aplicar_signo(frontier_type: str, kw: float) -> float:
    """Aplica la convención de signos al valor combinado de una unidad.

    - `frontier_type='input'`: invierte el signo (`kw → -kw`).
    - `frontier_type='output'`: pasa el valor tal cual.
    - Cualquier otro valor: pasa tal cual (defensa en profundidad; la validación
      del tipo de frontera vive en `config.py`).

    Normaliza `-0.0 → 0.0` después de la inversión.
    """
    if frontier_type == "input":
        kw = -kw
    if kw == 0.0:
        kw = 0.0
    return kw
