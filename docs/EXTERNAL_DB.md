# Base de datos externa

CivicPulse no gestiona PostgreSQL. Se conecta a la instancia que usted indique en
`DATABASE_URL`. Este documento reúne lo que cambia respecto a un despliegue con la base en
un contenedor propio, y lo que hay que ajustar en el servidor.

---

## 1. Las dos cadenas de conexión

Se necesitan las dos formas de la misma cadena. No es duplicación por descuido:

| Variable | Driver | La usan |
|---|---|---|
| `DATABASE_URL` | `pg` (síncrono) | alerts-api, reports-api, whatsapp-bot, `db-preflight` |
| `DATABASE_URL_ASYNC` | `asyncpg` | sentiment-api |

```bash
DATABASE_URL=postgresql://usuario:clave@host:5432/base?sslmode=require
DATABASE_URL_ASYNC=postgresql+asyncpg://usuario:clave@host:5432/base
DATABASE_SSL=true
```

Dos detalles que provocan casi todos los fallos de arranque al migrar:

**El prefijo.** Una URL con `+asyncpg` rompe a los servicios Node; una sin él bloquea el
bucle de eventos de sentiment-api en la primera consulta. Son variables distintas a
propósito.

**`sslmode` no va en la cadena asíncrona.** asyncpg falla con
`unexpected keyword argument 'sslmode'`, y ese es justo el parámetro que traen las cadenas
que dan RDS, Neon, Supabase y compañía. Copiar y pegar esa URL rompe el arranque con un
error que no menciona TLS por ningún lado. El TLS se declara aparte, en `DATABASE_SSL`, y
`app/core/database.py` lo traduce a un `SSLContext`.

sentiment-api valida ambas condiciones al construir la configuración y falla con un mensaje
que dice qué corregir, en lugar de reventar más tarde con un error de driver.

---

## 2. Ajuste obligatorio del servidor

### `max_locks_per_transaction ≥ 256`

El contenedor que se retiró lo fijaba. Una base externa trae el valor por defecto: **64**.

El esquema crea unas 1900 particiones mensuales entre `contents`, `inferences` y sus seis
tablas de detalle. Una consulta que abarque muchos meses, un `REFRESH MATERIALIZED VIEW` o
un `VACUUM` sobre la tabla padre toman **un lock por partición**. Con 64 se agota la tabla
de locks compartida y la operación aborta:

```
ERROR: out of shared memory
HINT: You might need to increase max_locks_per_transaction.
```

No es un riesgo teórico: aparece la primera vez que alguien pide el histórico completo o
cuando corre el refresco nocturno de KPIs. Requiere **reinicio de la instancia**.

| Proveedor | Cómo |
|---|---|
| Autoalojado | `ALTER SYSTEM SET max_locks_per_transaction = 256;` + `pg_ctl restart` |
| RDS / Aurora | Parameter group → `max_locks_per_transaction` → reinicio |
| Cloud SQL | Flags de la instancia |
| Neon, Supabase | Panel de configuración; en algunos planes hay que pedirlo a soporte |

`db-preflight` lo comprueba en cada arranque y avisa si se quedó corto.

### Recomendados

| Parámetro | Valor | Motivo |
|---|---|---|
| `max_connections` | ≥ 100 | Cuatro servicios × `DB_POOL_SIZE` × réplicas |
| `statement_timeout` | 0 (global) | Cada servicio fija el suyo en la conexión |
| `idle_in_transaction_session_timeout` | 60 s | Evita que una transacción colgada retenga locks de partición |

---

## 3. Pool de conexiones

Con la base fuera, cada servicio abre su propio grupo de conexiones a través de la red. El
total es `DB_POOL_SIZE × servicios × réplicas` y debe caber en `max_connections` menos lo
que consuma el resto de su infraestructura.

```bash
DB_POOL_SIZE=10          # 4 servicios × 10 = 40 conexiones base
DB_MAX_OVERFLOW=20       # sólo sentiment-api, en picos
DB_POOL_RECYCLE_SEC=1800 # por debajo del corte de inactividad del proveedor
```

`pool_pre_ping` está activo: con una base externa deja de ser opcional, porque entre la
aplicación y el servidor hay red, NAT y probablemente un balanceador que corta conexiones
inactivas sin avisar.

**Si usa pgbouncer en modo transacción**, ya está contemplado: `statement_cache_size=0` en
asyncpg, porque el cacheo de sentencias preparadas es incompatible con ese modo.

---

## 4. TLS

```bash
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=false   # Node
DATABASE_SSL_ROOT_CERT=                  # ruta a la CA, si verifica
```

| Modo | Qué hace | Cuándo |
|---|---|---|
| `sslmode=require` / `REJECT_UNAUTHORIZED=false` | Cifra sin validar la cadena | Por defecto. Funciona sin más con cualquier proveedor gestionado |
| `sslmode=verify-full` / `REJECT_UNAUTHORIZED=true` | Cifra y valida certificado y nombre de host | Producción, con la CA del proveedor montada en el contenedor |

La diferencia importa: `require` protege contra escucha pasiva, no contra suplantación. Si
la base está en otra red o atraviesa internet, vale la pena montar la CA y verificar.

---

## 5. Privilegios

**El usuario de conexión no debe ser superusuario.** PostgreSQL no aplica RLS a los
superusuarios ni a los roles con `BYPASSRLS`: con uno de ellos, la RLS está activa y no
aísla nada — cada organización vería los datos de todas.

```sql
CREATE ROLE civicpulse_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '…';
GRANT USAGE ON SCHEMA civic, civic_cat, civic_api, civic_kpi, civic_ops TO civicpulse_app;
GRANT SELECT ON ALL TABLES IN SCHEMA civic_api, civic_cat, civic_kpi TO civicpulse_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA civic TO civicpulse_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA civic_kpi, civic_ops TO civicpulse_app;
```

Compruébelo:

```sql
SELECT * FROM civic_ops.check_isolation();
```

`db-preflight` lo ejecuta en cada arranque y lo reporta.

### Si el proveedor restringe DDL

`install.sql` está escrito para degradar con elegancia:

| Sentencia | Si falla |
|---|---|
| `CREATE EXTENSION` | Se registra como no disponible y se usa la ruta alterna |
| `CREATE ROLE` | Avisa y continúa; cree los roles a mano |
| `ALTER ROLE … BYPASSRLS` | Avisa y continúa |
| `ALTER DATABASE … SET author_pepper` | `db-preflight` prueba `ALTER ROLE … IN DATABASE` y, si tampoco, deja que la aplicación lo fije por sesión |

Lo único que no se puede sortear es `CREATE` sobre la base: sin él no hay esquema.

---

## 6. Mantenimiento

Sin `pg_cron` en la base externa —lo habitual en servicios gestionados— hay que programar
las tareas desde fuera. Un contenedor con cron, un job de Kubernetes o el planificador del
sistema:

```cron
*/15 * * * *  psql "$DATABASE_URL" -c "SELECT civic_kpi.refresh_all(true)"
30 3   * * *  psql "$DATABASE_URL" -c "SELECT civic_ops.ensure_partitions(true)"
0  4   * * *  psql "$DATABASE_URL" -c "SELECT civic_ops.purge_raw_payloads(30)"
0  5   * * 0  psql "$DATABASE_URL" -c "SELECT * FROM civic_ops.purge_expired_contents(50000,false)"
```

**El más crítico es `ensure_partitions`.** Si nadie lo ejecuta, llega un mes en que no
existe la partición correspondiente y toda la ingesta cae en la partición por defecto.
Funciona —no se pierde nada— pero el rendimiento se degrada y, peor, después ya no se
pueden crear las particiones de ese rango sin vaciar la default primero.

Vigile:

```sql
SELECT * FROM civic_ops.v_default_partition_health;   -- orphan_rows debe ser 0
```

---

## 7. Respaldos

Al gestionar usted la base, los respaldos también son suyos. Dos apuntes propios de este
esquema:

**El volumen está en `contents` e `inferences`.** El resto es configuración y cabe en unos
pocos megabytes. Para un respaldo ligero de la configuración:

```bash
pg_dump "$DATABASE_URL" \
  --schema=civic_cat --schema=civic_kpi \
  --table='civic.organizations' --table='civic.campaigns' \
  --table='civic.contenders'    --table='civic.topics' \
  --table='civic.sources'       --table='civic.alert_rules' \
  --table='civic.ai_models'     --table='civic.prompt_*' \
  --table='civic.eval_*' \
  -f civicpulse-config.sql
```

**Las vistas materializadas no necesitan respaldo**: se reconstruyen con
`civic_kpi.refresh_all(false)`. Excluirlas con `--exclude-table='civic_kpi.mv_*'` acelera
mucho la restauración.

**El pepper de seudonimización no está en el volcado** si se fijó con `ALTER DATABASE`:
`pg_dump` no incluye la configuración de la base. Guárdelo aparte. Sin él, restaurar y
seguir ingiriendo genera hashes distintos para el mismo autor, y el conteo de autores
únicos se duplica en silencio.

---

## 8. Diagnóstico rápido

```bash
DATABASE_URL='postgresql://…' sh scripts/db-preflight.sh
```

| Síntoma | Causa habitual |
|---|---|
| `unexpected keyword argument 'sslmode'` | `sslmode` en `DATABASE_URL_ASYNC`. Quítelo, use `DATABASE_SSL=true` |
| `out of shared memory` | `max_locks_per_transaction` en 64 |
| Consultas vacías con datos en la base | Falta el contexto RLS. La aplicación debe llamar a `civic_ops.set_session_context()` por transacción |
| Un tenant ve datos de otro | El usuario de conexión es superusuario |
| `server closed the connection unexpectedly` | `DB_POOL_RECYCLE_SEC` por encima del corte de inactividad del proveedor |
| `connection refused` desde el contenedor | La base está en el host: use `host.docker.internal`, no `localhost` |
| `too many connections` | `DB_POOL_SIZE × servicios × réplicas` supera `max_connections` |
