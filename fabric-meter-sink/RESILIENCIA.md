# Resiliencia y auto-recuperación

¿Qué pasa con este servicio si Fabric, el endpoint o algo similar se cae?
¿Hay reintentos / autolevantamiento? ¿Hay que intervenir manualmente cuando
lo que falla vuelve?

Sí, la implementación tiene **tres capas de retries / auto-restart**
apilados. No hay que tocar nada cuando lo que falla vuelve.

## Capa 1 — Retry por ciclo (en proceso)

Cada 15 s el loop hace poll + write. Si el write falla, el loop **NO se
cae**: loggea el error, espera 15 s, y vuelve a intentar. Es el caso 99 % de
las fallas (blip de red, 5xx transitorio, token cerca de expirar).

```python
# src/service.py — write failure
except Exception as exc:
    self._consecutive_write_failures += 1
    logger.error("cycle X: write a Fabric falló (N consecutivos)...")
    write_ok = False
# loop sigue, próximo ciclo en 15s
```

## Capa 2 — Escalación a exit 1 después de N fallos

Después de `MAX_CONSECUTIVE_WRITE_FAILURES=5` ciclos consecutivos sin un
solo write OK (≈ 75 s de fallas seguidas), el proceso sale con código 1.
Esto es a propósito — si Fabric/red están realmente caídos, en vez de
log-spam sin parar, dejamos que systemd recicle el proceso para limpiar
cualquier estado corrupto en memoria.

## Capa 3 — Auto-restart por systemd

`deploy/fabric-meter-sink.service` tiene:

```ini
Restart=always
RestartSec=10
```

`Restart=always` significa: si el proceso sale (exit code 0 **o** 1 **o**
segfault), systemd lo levanta de nuevo a los 10 s. `systemctl enable`
además garantiza que arranca al boot del server.

## Línea de tiempo de un outage típico

Imaginá que Fabric tiene un outage de 30 minutos:

```
00:00  Outage empieza. Servicio escribiendo OK.
00:15  Cycle N → write FAIL (1)
00:30  Cycle N+1 → write FAIL (2)
00:45  Cycle N+2 → write FAIL (3)
01:00  Cycle N+3 → write FAIL (4)
01:15  Cycle N+4 → write FAIL (5) → exit 1
01:25  systemd reinicia el proceso (RestartSec=10)
01:25  Servicio arranca, buffer vacío
01:40  Cycle 1 → write FAIL (1)
... mismo patrón cada 85 s ...
30:00  Outage termina, Fabric responde
30:15  Cycle X → write OK ✓
30:30  Cycle X+1 → write OK ✓
```

**No hay intervención manual.** Cuando Fabric vuelve, el siguiente ciclo
escribe limpio.

## Escenarios concretos

| Falla | Detección | Recuperación | Pérdida de datos |
|---|---|---|---|
| Blip de red (1-2 ciclos) | Write timeout | Retry siguiente ciclo (15 s) | Ninguna — `overwrite` con buffer rotativo |
| Fabric API 5xx transitorio | Write retorna error | Igual que arriba | Ninguna |
| Fabric outage largo (horas) | 5 fallos → exit 1 | Cycle: exit 1 → restart → reintenta. Hasta que vuelva | Ninguna persistente. El "buffer en memoria" se pierde en cada restart pero `overwrite` con el siguiente ciclo válido lleva la tabla a estado correcto |
| Token expira (cada ~1 h) | n/a | `azure-identity` lo refresca solo, transparente | Ninguna |
| **Credenciales revocadas (CLIENT_SECRET expirado)** | Write falla con 401 | **Loop infinito de retries 401**. systemd restart no lo arregla | **Requiere intervención manual** — actualizar `CLIENT_SECRET` en `.env` y `systemctl restart` |
| SQL endpoint refresh falla | HTTP 404/etc. | Best-effort, log warn, sigue. El sync de Fabric en background sincroniza igual | Ninguna |
| VACUUM falla | Excepción en thread separado | Best-effort, log warn, sigue | Ninguna |
| 1 medidor cae | Poll devuelve `value_kw=None` | Esa unidad escribe `0.0`, las otras siguen normales | Ese medidor: 0.0 mientras dure |
| TODOS los medidores caen (split de red) | Todos `value_kw=None` | No push al buffer, no write. Loggea WARN/ERROR. Cuando vuelven, todo arranca solo | Ninguna a Fabric |
| Server reboota (corte eléctrico, kernel update) | n/a | systemd levanta el servicio al boot (`enable`d) | Ninguna |
| Proceso segfault / OOM | Exit code != 0 | systemd restart en 10 s | Ninguna |
| `.env` borrado / corrupto | Falla al arrancar (validación fail-fast) | Restart loop infinito hasta que se arregle | Requiere intervención |

## Lo único que NO se auto-recupera

Tres cosas requieren acción humana:

1. **Credenciales revocadas o vencidas.** Si IT revoca el `CLIENT_SECRET` o
   vence (Azure AD permite secrets con expiración configurable). El servicio
   reintenta para siempre con 401. El monitor del heartbeat eventualmente
   alertaría — `stat /var/run/fabric-meter-sink/heartbeat` sigue actualizando
   porque el loop sigue corriendo, pero la tabla en Fabric queda congelada.
2. **Service principal pierde permisos en el workspace.** Mismo síntoma
   (403 en lugar de 401).
3. **`.env` con valores incorrectos** (ej. typo en `FABRIC_LAKEHOUSE_NAME`).

Para los tres, el patrón es: arreglar el `.env` / re-otorgar permisos en
Azure → `sudo systemctl restart fabric-meter-sink`.

## Cómo monitorearlo en producción

Tres señales independientes:

```bash
# 1. ¿El proceso vive?
systemctl is-active fabric-meter-sink     # → "active"

# 2. ¿El loop está girando? (heartbeat actualizado en últimos 60s)
find /var/run/fabric-meter-sink/heartbeat -mmin -1   # debe imprimir el path; si no, está colgado

# 3. ¿Está escribiendo a Fabric? (último write OK en los últimos 2 min de logs)
sudo journalctl -u fabric-meter-sink --since "2 min ago" | grep "wrote .* rows to Fabric"
```

Las tres juntas son una buena alerta: si **process active** + **heartbeat
fresco** + **NO logs de "wrote ... rows"** durante varios minutos seguidos →
algo está mal con Fabric/credenciales y necesita intervención.
