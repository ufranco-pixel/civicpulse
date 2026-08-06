# Análisis de Sentimientos

Plataforma de análisis de sentimiento sobre **comentarios acerca de campañas políticas**.

Instancia nueva y autocontenida, construida sobre la arquitectura del sistema de análisis de
sentimiento existente. **No modifica nada del proyecto original**: vive en su propia carpeta,
con su propia base de datos, sus propios servicios y su propio esquema.

---

## Qué mide y qué no

Esta advertencia no es un descargo legal: es la premisa de diseño de todo el sistema, y está
implementada en el código.

**Mide** la conversación pública digital sobre actores y temas de campaña: volumen,
sentimiento, postura hacia cada contendiente, emociones, agenda de temas, riesgo de crisis.

**No mide** intención de voto. Quien publica en redes no es una muestra representativa del
electorado: sobre-representa a los muy motivados, a los urbanos y a los conectados.

Consecuencias concretas en el producto:

- Cada indicador lleva un `caveat` en `civic_kpi.metric_registry` que la API devuelve junto
  al número y el frontend muestra obligatoriamente.
- Cada indicador tiene `min_sample_size`. Por debajo, la respuesta marca `is_reliable = false`,
  el widget se atenúa y no dibuja tendencia.
- Los rankings competitivos se ordenan por la cota inferior de Wilson, no por el porcentaje
  crudo, para que un actor con 5 menciones y 100 % de apoyo no encabece la tabla.
- `contenders.baseline_support_pct` guarda la encuesta probabilística de referencia y el
  tablero la muestra al lado del dato digital.
- Los informes PDF incluyen una sección de nota metodológica obligatoria.

---

## Diferencias con el sistema base

| | Sistema base | Análisis de Sentimientos |
|---|---|---|
| Actor medido | Una marca | N contendientes en competencia |
| Ejes de clasificación | Sentimiento | Sentimiento **y postura**, separados |
| Esquema | Sólo seeds, sin DDL | DDL completo, particionado, con RLS |
| Modelo de datos | Dos modelos incompatibles (`project_id` vs `project_code`) | Uno normalizado + vistas de compatibilidad |
| Motor de reglas | Reglas guardadas, nada las evaluaba | `civic.evaluate_alert_rules()` con 4 guardas contra ruido |
| SSE | Sin autenticar | Token validado, aislamiento por organización |
| Persistencia Node | Memoria y JSON en disco | PostgreSQL |
| Informes | Inventaba datos si el cuerpo venía vacío | Consulta la BD; nunca fabrica cifras |
| Frontend | Componentes con datos simulados codificados | Cableado a la API real |
| Evaluación | Métricas estáticas en un JSON | Conjunto dorado, corridas, métricas por corte, puerta de promoción |
| Multi-tenant | Sin aislamiento | RLS por organización |
| Prompts | — | Versionados e inmutables en BD, con trazabilidad por inferencia |

---

## Puesta en marcha

**La base de datos es externa.** El proyecto no levanta PostgreSQL ni lo gestiona: se
conecta a la instancia que usted indique. Detalle completo en [`docs/EXTERNAL_DB.md`](docs/EXTERNAL_DB.md).

```bash
cd oeste-sentimientos
cp .env.example .env
# Edite: DATABASE_URL, DATABASE_URL_ASYNC, GEMINI_API_KEY,
#        CIVICPULSE_AUTHOR_PEPPER (openssl rand -hex 32)

docker compose up -d --build
docker compose logs -f db-preflight     # verificación de la base
```

| Servicio | URL |
|---|---|
| Frontend | http://localhost:8090 |
| API principal | http://localhost:8000/docs |
| Alertas (SSE) | http://localhost:8003/health |
| Informes | http://localhost:8002/health |
| Keycloak | http://localhost:8080 |

El bot de WhatsApp es opcional: `docker compose --profile whatsapp up -d`.

### Las dos cadenas de conexión

No se pueden unificar: los servicios Node usan `pg` (síncrono) y sentiment-api usa
`asyncpg`. Una URL con `+asyncpg` rompe a los Node, y `asyncpg` rechaza el `sslmode` que
traen las cadenas de los proveedores gestionados.

```bash
DATABASE_URL=postgresql://usuario:clave@host:5432/base?sslmode=require
DATABASE_URL_ASYNC=postgresql+asyncpg://usuario:clave@host:5432/base   # sin sslmode
DATABASE_SSL=true                                                      # el TLS va aquí
```

sentiment-api valida ambas al arrancar y falla con un mensaje explícito si se pegó la
cadena equivocada, en lugar de reventar más tarde con un error de driver.

### Instalar el esquema en una base vacía

```bash
cd sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f install.sql
psql "$DATABASE_URL" -f ../prompts/load_prompts.sql
psql "$DATABASE_URL" -c "ALTER DATABASE <base> SET civicpulse.author_pepper = '$(openssl rand -hex 32)';"

# Prueba de humo: crea datos, ejercita todos los indicadores y hace ROLLBACK
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f smoke_test.sql
```

O bien arranque una vez con `DB_AUTO_INSTALL=true` y deje que `db-preflight` lo haga.

**Requisitos:** PostgreSQL 14 o superior. **Ninguna extensión es obligatoria.** El
instalador detecta `pg_trgm`, `unaccent`, `citext` y `pg_cron`, y activa la ruta
correspondiente; sin ellas el esquema funciona igual, con búsqueda difusa algo peor y
mantenimiento programado desde fuera.

> **Un ajuste de servidor sí es obligatorio: `max_locks_per_transaction ≥ 256`.**
> El esquema crea ~1900 particiones mensuales. Con el valor por defecto (64), una consulta
> que abarque muchos meses, un `REFRESH MATERIALIZED VIEW` o un `VACUUM` sobre la tabla
> padre agotan la tabla de locks y abortan con *out of shared memory*. Requiere reinicio de
> la instancia. `db-preflight` lo comprueba en cada arranque y avisa si se quedó corto.

### `db-preflight`

Al no haber contenedor de base de datos se perdió el `healthcheck` que encadenaba el
arranque: sin él los servicios levantan aunque la base no responda y fallan en la primera
petición con un error opaco. Lo sustituye este servicio, que corre una vez y verifica:

1. conectividad, con reintentos y diagnóstico si falla;
2. versión de PostgreSQL;
3. `max_locks_per_transaction`;
4. privilegios y si el usuario es superusuario (lo que anularía la RLS);
5. extensiones disponibles frente a instaladas;
6. presencia y completitud del esquema;
7. particiones del mes siguiente — las crea si faltan;
8. pepper de seudonimización, con dos rutas alternativas si el proveedor veta `ALTER DATABASE`;
9. `civic_ops.check_isolation()`.

Los demás servicios esperan a `service_completed_successfully`: si algo bloquea, el
despliegue se detiene ahí en lugar de quedar a medias. También corre suelto:

```bash
DATABASE_URL='postgresql://…' sh scripts/db-preflight.sh
```

---

## Estructura

```
oeste-sentimientos/
├── sql/                        Capa de datos — 13 archivos, orden de dependencias
│   ├── install.sql             Instalador completo
│   ├── 00_bootstrap.sql        Esquemas, roles, dominios, utilidades, particiones
│   ├── 01_catalogs.sql         16 catálogos de referencia
│   ├── 02_core.sql             Organizaciones, campañas, contendientes, fuentes
│   ├── 03_content.sql          Contenidos (particionado mensual)
│   ├── 04_inference.sql        Inferencias y sus 6 tablas de detalle
│   ├── 05_ai_models.sql        Proveedores, modelos, versionado de prompts
│   ├── 06_jobs_alerts.sql      Trabajos, reglas, alertas, entregas
│   ├── 07_evaluation.sql       Conjunto dorado, corridas, métricas
│   ├── 08_materialized_views.sql  7 MVs de agregación diaria
│   ├── 09_indicators.sql       27 indicadores + evaluador de reglas
│   ├── 10_api_views.sql        Contrato de la API + compatibilidad
│   ├── 11_security_rls.sql     RLS, retención, cumplimiento
│   ├── seed_example.sql        Plantilla de alta comentada (no inserta nada)
│   └── smoke_test.sql          Prueba end-to-end con ROLLBACK
├── prompts/
│   ├── 01_clasificador.md      Prompt de clasificación, comentado
│   ├── 02_evaluacion.md        Los tres prompts de evaluación
│   ├── 03_output_schema.json   Esquema JSON de salida
│   └── load_prompts.sql        Carga las plantillas en la BD
├── backend/
│   ├── sentiment-api/          FastAPI · KPIs, inferencias, evaluación · 8000
│   ├── alerts-api/             Express · SSE + evaluador periódico · 8003
│   ├── reports-api/            Express · informes PDF · 8002
│   └── whatsapp-bot/           Express · notificaciones · 8001
├── frontend/                   React 18 + Vite 5
├── scripts/db-init.sh
├── docs/
├── docker-compose.yml
└── .env.example
```

---

## Modelo de datos

Cinco esquemas con responsabilidades separadas:

| Esquema | Contenido |
|---|---|
| `civic` | Dominio: 36 tablas |
| `civic_cat` | 16 catálogos de referencia, compartidos entre organizaciones |
| `civic_kpi` | 7 vistas materializadas, registro de indicadores, funciones de KPI |
| `civic_api` | **Contrato de la aplicación.** Los servicios sólo leen de aquí |
| `civic_ops` | Auditoría, particiones, retención, cumplimiento |

**Regla de arquitectura:** ningún microservicio consulta `civic.*` para leer. Lee de
`civic_api.*`. Así el modelo interno puede evolucionar sin romper la API.

### Decisiones que conviene conocer

**Particionado mensual** de `contents`, `inferences` y sus 6 tablas de detalle. Un ciclo
electoral genera decenas de millones de filas; particionar permite purgar por retención con
`DROP TABLE` en lugar de un `DELETE` masivo, y limita el tamaño de cada índice.
`civic_ops.ensure_partitions()` las crea por adelantado y poda las vencidas.

**Postura normalizada, no en JSONB.** Todos los indicadores competitivos agregan por
contendiente; con JSONB cada consulta tendría que desanidar. `inference_stances` denormaliza
`campaign_id` y `published_at` para agregar sin JOIN.

**Sentimiento continuo además de la etiqueta.** Los promedios se calculan sobre
`sentiment_score` en `[-1,1]`, no sobre la etiqueta. Un trigger rechaza la escritura si
etiqueta y puntaje se contradicen: vale más fallar al escribir que contaminar meses de KPIs.

**La ironía se declara, no se resuelve.** El clasificador reporta `sarcasm_score`; el umbral
de exclusión (`> 0.6`) vive en las vistas materializadas para poder recalibrarlo sin
reprocesar.

---

## Los 27 indicadores

Definidos en `civic_kpi.metric_registry` con su fórmula, unidad, rango, dirección deseable,
muestra mínima y advertencia de interpretación.

```sql
SELECT code, label_es, family, unit, min_sample_size, caveat
FROM civic_kpi.metric_registry ORDER BY family, sort_order;
```

| Familia | Indicadores |
|---|---|
| Volumen | `mention_volume`, `volume_zscore`, `unique_authors`, `amplification_ratio` |
| Sentimiento | `net_sentiment`, `avg_sentiment_score`, `negative_pct`, `polarization_index`, `sentiment_momentum` |
| Competitivo | `share_of_voice`, `net_support`, `support_wilson_lb`, `competitive_momentum`, `attention_share` |
| Agenda | `topic_share`, `topic_growth`, `issue_ownership`, `agenda_alignment` |
| Riesgo | `toxicity_avg`, `crisis_risk_index`, `threat_count`, `disinfo_count`, `coordination_score` |
| Operación | `source_lag_minutes` |
| Calidad | `confidence_avg`, `review_backlog`, `human_agreement` |

Tres merecen explicación:

- **`polarization_index`** — proporción de opiniones extremas menos moderadas. Un sentimiento
  neto de cero con polarización alta describe dos bloques enfrentados, no indiferencia. Son
  situaciones opuestas que el promedio confunde.
- **`support_wilson_lb`** — cota inferior de Wilson al 95 %. Es el criterio de orden de los
  rankings, y por eso el tablero competitivo no baila con cada mención nueva.
- **`crisis_risk_index`** — compuesto de volumen anómalo (30 %), caída de sentimiento (30 %),
  toxicidad (20 %) y banderas graves (20 %). Devuelve el desglose por componente y una
  explicación en texto, no sólo el número.

Funciones principales:

```sql
SELECT * FROM civic_kpi.campaign_overview('CAMP-2027-01', 30);
SELECT * FROM civic_kpi.sentiment_timeseries('CAMP-2027-01', 30, 'day');
SELECT * FROM civic_kpi.contender_scoreboard('CAMP-2027-01', 14);
SELECT * FROM civic_kpi.topic_agenda('CAMP-2027-01', 14, 20);
SELECT * FROM civic_kpi.crisis_risk('CAMP-2027-01', 24);
SELECT * FROM civic_kpi.coordination_signals('CAMP-2027-01', 24, 3);
```

---

## Alertas sin ruido

El sistema base guardaba reglas que nada evaluaba. Aquí el evaluador vive en la base de
datos, que es donde están los datos:

```sql
SELECT * FROM civic.evaluate_alert_rules('CAMP-2027-01', TRUE);   -- simulación
SELECT * FROM civic.evaluate_alert_rules('CAMP-2027-01', FALSE);  -- real
```

`alerts-api` lo invoca cada 60 s (con *advisory lock* para que sólo una réplica evalúe) y
difunde por SSE.

Cuatro guardas contra la avalancha que hace que un equipo silencie las notificaciones:

1. **`min_sample_size`** — la más importante. Sin ella, 2 comentarios negativos de 2 dan
   100 % de negatividad y disparan una alerta crítica.
2. **`consecutive_hits`** — histéresis: exige N evaluaciones seguidas en condición.
3. **`cooldown_minutes`** — silencio tras disparar.
4. **`max_per_day`** — tope diario por regla.

Además respeta la **veda electoral** y el **horario silencioso**: la alerta se registra pero
no se notifica, y la supresión queda auditada en `civic.alert_deliveries`.

Cada alerta guarda el valor observado, el umbral, el tamaño de muestra y hasta 5 contenidos
de evidencia. Sin eso una alerta es un número sin contexto sobre el que no se puede actuar.

---

## Clasificación y evaluación

### Motor: Google Gemini

`gemini-flash-lite-latest` como clasificador primario, con respaldo opcional en otro
proveedor y transformers especializados para tareas concretas. La configuración por campaña
y tarea vive en `civic.campaign_pipeline`: si la confianza del primario cae por debajo de
`fallback_threshold`, la inferencia se reenruta.

```bash
GEMINI_API_KEY=...                       # https://aistudio.google.com/apikey
GEMINI_MODEL=gemini-flash-lite-latest
GEMINI_API_VERSION=v1beta                # única versión con responseMimeType
GEMINI_SAFETY_THRESHOLD=BLOCK_NONE
CLASSIFIER_BATCH_LIMIT=30                # contenidos por corrida
CLASSIFIER_MIN_CONFIDENCE=0.6            # lo sobrescribe campaign_pipeline
```

Dos detalles de Gemini que condicionan la implementación:

**Salida JSON forzada.** El adaptador envía `responseMimeType: application/json` y una
versión podada del esquema en `responseSchema`. El esquema de Gemini es un subconjunto de
OpenAPI 3.0 que no admite `additionalProperties`, `pattern`, `minimum`, `maximum` ni tipos
unión; `_gemini_response_schema()` los quita antes de enviarlo, porque el esquema completo
devuelve 400 y tumba la corrida. Los rangos los sigue validando `jsonschema` en local.

**Filtros de seguridad.** Con el umbral por defecto Gemini se niega a procesar insultos,
amenazas y discurso de odio — precisamente lo que este sistema debe detectar. El adaptador
manda `safetySettings` en las cuatro categorías y convierte `blockReason` y
`finishReason: SAFETY` en error explícito. Si esos comentarios se descartaran en silencio,
el sentimiento agregado se desplazaría hacia lo positivo y las alertas de toxicidad nunca
dispararían: un tablero que no ve los ataques es peor que no tener tablero. `BLOCK_NONE` no
hace que el modelo genere contenido dañino; sólo le permite clasificarlo.

> **Sobre la clave de AI Studio.** El nivel gratuito de Google AI Studio permite, según sus
> términos, usar el contenido enviado para mejorar el servicio. Por eso el proveedor `gemini`
> está registrado con `no_training_clause = FALSE` y `civic_ops.v_compliance_status` lo
> cuenta en `active_providers_without_no_training_clause`. Para opinión política de personas
> identificables conviene el nivel de pago o Vertex AI (proveedor `vertex_ai`, ya registrado),
> que sí excluyen el entrenamiento y permiten fijar la región de datos.

**Los prompts se versionan como código.** Un prompt es un clasificador: cambiarlo cambia las
métricas. Cada inferencia guarda `prompt_version_id`, y una versión promovida a `active` es
inmutable (lo impide un trigger). Sin eso la serie histórica deja de ser comparable y no hay
forma de explicar por qué el sentimiento cambió de un día para otro.

### Los tres prompts de evaluación

En `prompts/02_evaluacion.md`, cargados en BD por `load_prompts.sql`:

| Prompt | Función |
|---|---|
| **Juez de clasificación** | Dictamina caso por caso y atribuye el fenómeno lingüístico causante del error. Prioriza la revisión humana; no la sustituye |
| **Auditor de corrida** | Convierte métricas por corte y matriz de confusión en un dictamen explicado |
| **Auditor de equidad** | Verifica que todos los contendientes se midan con la misma precisión |

### Ciclo

```
muestrear → juez propone → revisión humana de los casos marcados → congelar conjunto
→ correr candidato → compute_eval_metrics() → evaluate_promotion_gate()  ← DECIDE
→ prompt auditor                                                          ← EXPLICA
→ prompt de equidad → promover o rechazar
```

La puerta determinista decide; el LLM explica y propone acciones. **Si discrepan, manda la
puerta.** Un sistema donde un LLM decide qué modelo va a producción no tiene control de
calidad: tiene otra capa de opinión.

La puerta exige F1 macro mínimo, tasa de esquema válido ≥ 0.98, brecha de calibración
acotada y que **ningún corte quede muy por debajo del global** — es la comprobación de
equidad entre fuentes, idiomas y actores.

```sql
SELECT * FROM civic_kpi.compute_eval_metrics('<run-uuid>');
SELECT * FROM civic_kpi.compare_eval_runs('<run>', '<baseline>');
SELECT * FROM civic_kpi.evaluate_promotion_gate('<run>');
```

---

## Privacidad y cumplimiento

Implementado, no declarativo:

- **Seudonimización por defecto.** `author_hash = SHA-256(pepper || id)`. Permite contar
  autores únicos y detectar coordinación sin conservar identidades.
- **Redacción de PII** en el texto según `organizations.pii_policy`, aplicada por trigger
  en la escritura.
- **Base legal obligatoria** en canales privados: un trigger rechaza dar de alta una fuente
  de WhatsApp o CRM sin `legal_basis`.
- **Consentimiento obligatorio** en suscripciones de WhatsApp y correo.
- **Retención automática:** `purge_after` se fija al insertar; `purge_expired_contents()`
  purga por lotes, en simulación por defecto.
- **Derecho de supresión:** `civic_ops.erase_author()` borra todo lo de un autor y deja
  constancia en la bitácora.
- **RLS multi-tenant.** Cada transacción debe fijar el contexto:
  ```sql
  SELECT civic_ops.set_session_context('<org-uuid>', '<sub>', '<username>');
  ```
  Con `SET LOCAL`, para que no se filtre entre peticiones que reutilizan conexión del pool.
  Es el fallo silencioso clásico de RLS detrás de un pool.

> **La aplicación NO debe conectarse como superusuario.** PostgreSQL no aplica RLS a los
> superusuarios ni a los roles con `BYPASSRLS`: con `postgres` como usuario de conexión, la
> RLS está «activa» y no aísla nada. Cree un rol con `NOSUPERUSER NOBYPASSRLS`, otórguele
> permisos sobre `civic_api` y `civic_cat`, y conéctese con él.
>
> ```sql
> SELECT * FROM civic_ops.check_isolation();
> ```
>
> Cinco comprobaciones: rol sin bypass, RLS habilitada, vistas `security_invoker`, contexto
> de sesión y pepper configurado. Ejecútela al arrancar cada servicio y aborte si algo sale
> `FALLO`. El `docker-compose` de este repositorio usa el superusuario del contenedor por
> simplicidad de arranque: **cámbielo antes de producción.**
- **Vista redactada** para el rol auditor: metadatos completos, texto truncado y enmascarado.

Panel de estado, todas las columnas deben ser 0:

```sql
SELECT * FROM civic_ops.v_compliance_status;
```

**Las banderas de riesgo existen para proteger al equipo y priorizar respuesta.** No deben
usarse para perfilar, segmentar ni tomar represalias contra autores individuales.

---

## Mantenimiento

Con `pg_cron` se programa solo. Sin él:

```cron
*/15 * * * *  psql -d oeste-sentimientos -c "SELECT civic_kpi.refresh_all(true)"
30 3   * * *  psql -d oeste-sentimientos -c "SELECT civic_ops.ensure_partitions(true)"
0  4   * * *  psql -d oeste-sentimientos -c "SELECT civic_ops.purge_raw_payloads(30)"
0  5   * * 0  psql -d oeste-sentimientos -c "SELECT * FROM civic_ops.purge_expired_contents(50000,false)"
```

Comprobaciones periódicas:

```sql
SELECT * FROM civic_ops.v_default_partition_health;  -- orphan_rows debe ser 0
SELECT * FROM civic_kpi.mv_source_health WHERE health <> 'healthy';
SELECT view_name, duration_ms, success FROM civic_ops.mv_refresh_log ORDER BY started_at DESC LIMIT 10;
```

---

## Primeros pasos tras instalar

1. Dé de alta su organización y campaña con `sql/seed_example.sql` (plantilla comentada).
2. **Registre bien los alias de cada contendiente.** Es la configuración que más determina
   la calidad del tablero competitivo: un actor con pocos alias aparece artificialmente
   poco y su *share of voice* queda subestimado, lo que invalida toda comparación.
3. Configure las fuentes con su `legal_basis`.
4. Deje `CLASSIFIER_ENABLED=false` hasta haber evaluado el prompt.
5. Construya un conjunto dorado de al menos 300 casos anotados por personas.
6. Evalúe, revise la equidad entre fuentes y entre actores, y sólo entonces promueva.
7. Ajuste los umbrales de alerta tras dos semanas de operación, cuando conozca la línea base
   real de sus canales. Los valores por defecto son conservadores, no universales.

No muestre el tablero a quien tome decisiones antes del paso 6. Sin evaluación, los números
tienen apariencia de dato y origen desconocido.
