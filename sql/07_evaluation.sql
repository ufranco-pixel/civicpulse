-- =============================================================================
-- CivicPulse · 07_evaluation.sql
-- Evaluación de clasificadores: conjunto dorado, corridas, predicciones y métricas.
--
-- Por qué esto existe: un tablero de sentimiento sin evaluación es un generador
-- de opiniones con apariencia de dato. Antes de que nadie tome una decisión de
-- campaña con estos números hay que poder responder tres preguntas:
--   1. ¿Qué tan bien clasifica el modelo, medido contra qué?
--   2. ¿Mejoró o empeoró respecto a la versión anterior?
--   3. ¿En qué subgrupos falla — qué fuente, qué idioma, qué actor?
--
-- Las métricas se calculan en SQL (civic_kpi.compute_eval_metrics) para que
-- sean reproducibles y auditables, no dependientes del script de turno.
-- =============================================================================

\set ON_ERROR_STOP on
SET search_path = civic, civic_cat, civic_kpi, civic_ops, public;

-- =============================================================================
-- 1. CONJUNTOS DE EVALUACIÓN
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.eval_datasets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID            NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    campaign_id     UUID            REFERENCES civic.campaigns(id) ON DELETE CASCADE,
    code            civic.slug_code NOT NULL,
    name            TEXT            NOT NULL,
    description     TEXT,

    split           TEXT            NOT NULL DEFAULT 'test'
                    CHECK (split IN ('train','dev','test','holdout','adversarial')),
    -- adversarial: casos difíciles seleccionados a propósito (ironía, negación,
    -- mezcla de idiomas). El desempeño aquí predice el comportamiento real
    -- mucho mejor que una muestra aleatoria.

    task_codes      civic.slug_code[] NOT NULL DEFAULT ARRAY['sentiment']::civic.slug_code[],
    languages       civic.lang_code[] NOT NULL DEFAULT ARRAY['es']::civic.lang_code[],

    -- Trazabilidad del muestreo. Sin esto no se sabe si el conjunto representa
    -- algo o si alguien eligió a mano los casos fáciles.
    sampling_method TEXT            CHECK (sampling_method IN
                    ('random','stratified','uncertainty','disagreement','manual','adversarial')),
    sampling_notes  TEXT,
    -- Semilla del muestreo: hace el conjunto reproducible.
    random_seed     BIGINT,

    item_count      INTEGER         NOT NULL DEFAULT 0 CHECK (item_count >= 0),
    -- Número de anotadores por caso. Con 1 no hay forma de medir acuerdo.
    annotators_per_item SMALLINT    NOT NULL DEFAULT 1 CHECK (annotators_per_item >= 1),
    -- Acuerdo entre anotadores (Krippendorff o Cohen). Es el techo de exactitud
    -- alcanzable: ningún modelo puede superar de forma fiable el acuerdo humano.
    inter_annotator_agreement NUMERIC(5,4) CHECK (inter_annotator_agreement BETWEEN -1 AND 1),

    is_frozen       BOOLEAN         NOT NULL DEFAULT FALSE,
    frozen_at       TIMESTAMPTZ,
    version         TEXT            NOT NULL DEFAULT 'v1',
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    created_by      TEXT,

    UNIQUE (organization_id, code, version)
);

COMMENT ON COLUMN civic.eval_datasets.inter_annotator_agreement IS
    'Acuerdo entre anotadores humanos. Es el techo realista del modelo: si dos personas coinciden 0.72, '
    'un modelo con exactitud 0.85 contra una sola anotación está sobreajustado a ese anotador.';
COMMENT ON COLUMN civic.eval_datasets.is_frozen IS
    'Un conjunto congelado no admite altas ni bajas. Sin congelar, comparar corridas no significa nada.';

CREATE INDEX IF NOT EXISTS ix_evalds_org ON civic.eval_datasets (organization_id, split);

-- =============================================================================
-- 2. CASOS DEL CONJUNTO
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.eval_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_id      UUID        NOT NULL REFERENCES civic.eval_datasets(id) ON DELETE CASCADE,

    -- Vínculo con el contenido real, si el caso proviene de la operación.
    content_id      UUID,
    content_published_at TIMESTAMPTZ,
    -- Copia del texto: el conjunto debe sobrevivir a la purga por retención.
    text            TEXT        NOT NULL,
    language_code   civic.lang_code NOT NULL DEFAULT 'es',
    source_type     civic.slug_code,

    -- ── Verdad de referencia ────────────────────────────────────────────────
    gold_sentiment  civic.slug_code REFERENCES civic_cat.sentiment_types(code),
    gold_stance     civic.slug_code REFERENCES civic_cat.stance_types(code),
    gold_stance_target UUID     REFERENCES civic.contenders(id) ON DELETE SET NULL,
    gold_intent     civic.slug_code REFERENCES civic_cat.intent_types(code),
    gold_emotions   civic.slug_code[] NOT NULL DEFAULT ARRAY[]::civic.slug_code[],
    gold_topics     civic.slug_code[] NOT NULL DEFAULT ARRAY[]::civic.slug_code[],
    gold_risk_flags civic.slug_code[] NOT NULL DEFAULT ARRAY[]::civic.slug_code[],
    gold_entities   JSONB       NOT NULL DEFAULT '[]'::jsonb,

    -- ── Metadatos que hacen útil el análisis de errores ─────────────────────
    -- Dificultad declarada: permite reportar exactitud por nivel.
    difficulty      TEXT        CHECK (difficulty IN ('easy','medium','hard')),
    -- Fenómenos lingüísticos presentes. Son las causas típicas de error en
    -- discurso político: ironía, negación, jerga local, cambio de código.
    phenomena       TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Los anotadores no coincidieron: caso genuinamente ambiguo.
    is_contested    BOOLEAN     NOT NULL DEFAULT FALSE,
    annotator_notes TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ck_evalitem_text CHECK (btrim(text) <> '')
);

COMMENT ON COLUMN civic.eval_items.phenomena IS
    'Etiquetas como sarcasm, negation, code_switching, local_slang, quoted_speech, emoji_only, '
    'multi_target. Permiten responder "¿dónde falla?" en lugar de sólo "¿cuánto falla?".';

CREATE INDEX IF NOT EXISTS ix_evalitems_dataset   ON civic.eval_items (dataset_id);
CREATE INDEX IF NOT EXISTS ix_evalitems_phenomena ON civic.eval_items USING GIN (phenomena);
CREATE INDEX IF NOT EXISTS ix_evalitems_contested ON civic.eval_items (dataset_id) WHERE is_contested;

-- Impide alterar un conjunto congelado.
CREATE OR REPLACE FUNCTION civic.guard_frozen_dataset()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE v_frozen BOOLEAN;
BEGIN
    SELECT is_frozen INTO v_frozen
      FROM civic.eval_datasets
     WHERE id = COALESCE(NEW.dataset_id, OLD.dataset_id);

    IF v_frozen THEN
        RAISE EXCEPTION 'El conjunto de evaluación está congelado: no admite cambios.'
            USING ERRCODE = '25006',
                  HINT = 'Cree una versión nueva del dataset en lugar de modificar esta.';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS tg_evalitems_frozen ON civic.eval_items;
CREATE TRIGGER tg_evalitems_frozen
    BEFORE INSERT OR UPDATE OR DELETE ON civic.eval_items
    FOR EACH ROW EXECUTE FUNCTION civic.guard_frozen_dataset();

-- Mantiene el contador de casos.
CREATE OR REPLACE FUNCTION civic.sync_dataset_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE civic.eval_datasets d
       SET item_count = (SELECT count(*) FROM civic.eval_items WHERE dataset_id = d.id)
     WHERE d.id = COALESCE(NEW.dataset_id, OLD.dataset_id);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tg_evalitems_count ON civic.eval_items;
CREATE TRIGGER tg_evalitems_count
    AFTER INSERT OR DELETE ON civic.eval_items
    FOR EACH STATEMENT EXECUTE FUNCTION civic.sync_dataset_count();

-- =============================================================================
-- 3. CORRIDAS DE EVALUACIÓN
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.eval_runs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID        NOT NULL REFERENCES civic.organizations(id) ON DELETE CASCADE,
    dataset_id        UUID        NOT NULL REFERENCES civic.eval_datasets(id) ON DELETE CASCADE,
    model_id          UUID        NOT NULL REFERENCES civic.ai_models(id)     ON DELETE CASCADE,
    prompt_version_id UUID        REFERENCES civic.prompt_versions(id) ON DELETE SET NULL,

    name              TEXT,
    -- Corrida contra la que se compara. Habilita el reporte de regresión.
    baseline_run_id   UUID        REFERENCES civic.eval_runs(id) ON DELETE SET NULL,

    status_code       civic.slug_code NOT NULL DEFAULT 'queued'
                      REFERENCES civic_cat.job_statuses(code),
    tasks_evaluated   civic.slug_code[] NOT NULL DEFAULT ARRAY['sentiment']::civic.slug_code[],

    items_total       INTEGER     NOT NULL DEFAULT 0 CHECK (items_total     >= 0),
    items_predicted   INTEGER     NOT NULL DEFAULT 0 CHECK (items_predicted >= 0),
    items_failed      INTEGER     NOT NULL DEFAULT 0 CHECK (items_failed    >= 0),
    -- Salidas que no cumplieron el esquema JSON: métrica de fiabilidad del prompt
    -- tan importante como la exactitud.
    schema_violations INTEGER     NOT NULL DEFAULT 0 CHECK (schema_violations >= 0),

    total_cost_usd    NUMERIC(12,6) NOT NULL DEFAULT 0,
    avg_latency_ms    INTEGER,
    p95_latency_ms    INTEGER,

    -- Veredicto de promoción. La regla de decisión se documenta en notes.
    verdict           TEXT        CHECK (verdict IN ('pass','fail','inconclusive')),
    verdict_reason    TEXT,

    started_at        TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,
    config            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    notes             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by        TEXT
);

COMMENT ON COLUMN civic.eval_runs.schema_violations IS
    'Respuestas que no cumplieron el esquema. Un prompt exacto pero que rompe el formato 5 % de las veces '
    'es inservible en producción: esas inferencias se pierden.';

CREATE INDEX IF NOT EXISTS ix_evalruns_dataset ON civic.eval_runs (dataset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_evalruns_model   ON civic.eval_runs (model_id, created_at DESC);

-- =============================================================================
-- 4. PREDICCIONES
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.eval_predictions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id            UUID        NOT NULL REFERENCES civic.eval_runs(id)  ON DELETE CASCADE,
    item_id           UUID        NOT NULL REFERENCES civic.eval_items(id) ON DELETE CASCADE,

    pred_sentiment    civic.slug_code REFERENCES civic_cat.sentiment_types(code),
    pred_sentiment_score civic.polarity_score,
    pred_stance       civic.slug_code REFERENCES civic_cat.stance_types(code),
    pred_intent       civic.slug_code REFERENCES civic_cat.intent_types(code),
    pred_emotions     civic.slug_code[] NOT NULL DEFAULT ARRAY[]::civic.slug_code[],
    pred_topics       civic.slug_code[] NOT NULL DEFAULT ARRAY[]::civic.slug_code[],
    pred_risk_flags   civic.slug_code[] NOT NULL DEFAULT ARRAY[]::civic.slug_code[],
    pred_entities     JSONB       NOT NULL DEFAULT '[]'::jsonb,

    confidence        civic.unit_score,
    latency_ms        INTEGER,
    -- La salida no cumplió el esquema declarado.
    schema_valid      BOOLEAN     NOT NULL DEFAULT TRUE,
    raw_output        JSONB,
    error_message     TEXT,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (run_id, item_id)
);

-- El acierto no se materializa aquí: una columna generada no puede referenciar
-- otra tabla. Se resuelve en la vista civic_kpi.v_eval_prediction_detail.

CREATE INDEX IF NOT EXISTS ix_evalpred_run  ON civic.eval_predictions (run_id);
CREATE INDEX IF NOT EXISTS ix_evalpred_item ON civic.eval_predictions (item_id);
CREATE INDEX IF NOT EXISTS ix_evalpred_bad  ON civic.eval_predictions (run_id) WHERE NOT schema_valid;

-- =============================================================================
-- 5. MÉTRICAS
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.eval_metrics (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id        UUID        NOT NULL REFERENCES civic.eval_runs(id) ON DELETE CASCADE,
    task_code     civic.slug_code NOT NULL,
    -- 'overall' o el código de una clase concreta.
    class_code    TEXT        NOT NULL DEFAULT 'overall',
    -- Corte del análisis: 'all', 'lang:es', 'source:x_twitter', 'phenom:sarcasm'...
    -- Es donde se descubre que el modelo funciona bien en promedio y pésimo en TikTok.
    slice         TEXT        NOT NULL DEFAULT 'all',

    metric_name   TEXT        NOT NULL,
    metric_value  NUMERIC(10,6) NOT NULL,
    support       INTEGER     CHECK (support >= 0),
    -- Intervalo de confianza por bootstrap. Sin él, una diferencia de 0.01
    -- entre dos modelos se lee como mejora cuando es ruido.
    ci_lower      NUMERIC(10,6),
    ci_upper      NUMERIC(10,6),

    computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (run_id, task_code, class_code, slice, metric_name)
);

COMMENT ON COLUMN civic.eval_metrics.slice IS
    'Corte de la métrica. El promedio global esconde los fallos que importan: mida por idioma, '
    'fuente, fenómeno lingüístico y contendiente.';

CREATE INDEX IF NOT EXISTS ix_evalmetrics_run ON civic.eval_metrics (run_id, task_code, slice);

-- Matriz de confusión: la tabla que realmente explica qué está fallando.
CREATE TABLE IF NOT EXISTS civic.eval_confusion (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id      UUID        NOT NULL REFERENCES civic.eval_runs(id) ON DELETE CASCADE,
    task_code   civic.slug_code NOT NULL,
    slice       TEXT        NOT NULL DEFAULT 'all',
    gold_class  TEXT        NOT NULL,
    pred_class  TEXT        NOT NULL,
    count       INTEGER     NOT NULL CHECK (count >= 0),
    UNIQUE (run_id, task_code, slice, gold_class, pred_class)
);

-- =============================================================================
-- 6. VISTA DE DETALLE DE PREDICCIONES
--    Une predicción y verdad para el análisis de errores caso por caso.
-- =============================================================================
CREATE OR REPLACE VIEW civic_kpi.v_eval_prediction_detail AS
SELECT
    p.run_id,
    p.id                       AS prediction_id,
    i.id                       AS item_id,
    i.dataset_id,
    i.text,
    i.language_code,
    i.source_type,
    i.difficulty,
    i.phenomena,
    i.is_contested,
    i.gold_sentiment,
    p.pred_sentiment,
    (i.gold_sentiment IS NOT NULL AND p.pred_sentiment = i.gold_sentiment) AS sentiment_correct,
    i.gold_stance,
    p.pred_stance,
    (i.gold_stance IS NOT NULL AND p.pred_stance = i.gold_stance)          AS stance_correct,
    i.gold_intent,
    p.pred_intent,
    (i.gold_intent IS NOT NULL AND p.pred_intent = i.gold_intent)          AS intent_correct,
    i.gold_emotions,
    p.pred_emotions,
    -- Jaccard para multietiqueta: la coincidencia exacta castiga de más cuando
    -- el modelo acierta 3 de 4 emociones.
    civic_ops.jaccard(i.gold_emotions::text[], p.pred_emotions::text[])     AS emotions_jaccard,
    i.gold_topics,
    p.pred_topics,
    civic_ops.jaccard(i.gold_topics::text[], p.pred_topics::text[])         AS topics_jaccard,
    p.confidence,
    p.schema_valid,
    p.latency_ms,
    p.error_message
FROM civic.eval_predictions p
JOIN civic.eval_items      i ON i.id = p.item_id;

COMMENT ON VIEW civic_kpi.v_eval_prediction_detail IS
    'Predicción contra verdad, caso por caso. Es la vista que se consulta para el análisis de errores.';

-- =============================================================================
-- 7. CÁLCULO DE MÉTRICAS
--    Una sola función que llena eval_metrics y eval_confusion para una corrida.
--    Cubre las tareas de etiqueta única (sentimiento, postura, intención) y
--    reporta por clase y por corte.
-- =============================================================================
CREATE OR REPLACE FUNCTION civic_kpi.compute_eval_metrics(p_run_id UUID)
RETURNS TABLE (task TEXT, slice TEXT, metric TEXT, value NUMERIC)
LANGUAGE plpgsql
AS $$
-- Los OUT parameters (task, slice, metric, value) coinciden con nombres de
-- columna dentro de las CTE. Ante la ambigüedad, resolver como columna.
#variable_conflict use_column
DECLARE
    v_task   TEXT;
    v_tasks  TEXT[];
BEGIN
    SELECT tasks_evaluated::TEXT[] INTO v_tasks FROM civic.eval_runs WHERE id = p_run_id;
    IF v_tasks IS NULL THEN
        RAISE EXCEPTION 'Corrida % inexistente.', p_run_id USING ERRCODE = '23503';
    END IF;

    DELETE FROM civic.eval_metrics   WHERE run_id = p_run_id;
    DELETE FROM civic.eval_confusion WHERE run_id = p_run_id;

    -- ── Tareas de etiqueta única ────────────────────────────────────────────
    FOREACH v_task IN ARRAY ARRAY['sentiment','stance','intent'] LOOP
        CONTINUE WHEN NOT (v_task = ANY (v_tasks));

        -- Base común: verdad, predicción y cortes.
        CREATE TEMP TABLE tmp_base ON COMMIT DROP AS
        SELECT
            CASE v_task WHEN 'sentiment' THEN d.gold_sentiment::text
                        WHEN 'stance'    THEN d.gold_stance::text
                        ELSE d.gold_intent::text END               AS gold,
            CASE v_task WHEN 'sentiment' THEN d.pred_sentiment::text
                        WHEN 'stance'    THEN d.pred_stance::text
                        ELSE d.pred_intent::text END               AS pred,
            d.language_code, d.source_type, d.phenomena, d.difficulty, d.is_contested
        FROM civic_kpi.v_eval_prediction_detail d
        WHERE d.run_id = p_run_id AND d.schema_valid;

        DELETE FROM tmp_base WHERE gold IS NULL;

        -- Cortes: global, por idioma, por fuente, por dificultad y por fenómeno.
        CREATE TEMP TABLE tmp_sliced ON COMMIT DROP AS
        SELECT 'all'::text AS slice, gold, pred FROM tmp_base
        UNION ALL SELECT 'lang:'   || language_code, gold, pred FROM tmp_base WHERE language_code IS NOT NULL
        UNION ALL SELECT 'source:' || source_type,   gold, pred FROM tmp_base WHERE source_type   IS NOT NULL
        UNION ALL SELECT 'diff:'   || difficulty,    gold, pred FROM tmp_base WHERE difficulty    IS NOT NULL
        UNION ALL SELECT 'phenom:' || ph,            gold, pred FROM tmp_base, unnest(phenomena) AS ph
        UNION ALL SELECT 'contested', gold, pred FROM tmp_base WHERE is_contested;

        -- Matriz de confusión.
        INSERT INTO civic.eval_confusion (run_id, task_code, slice, gold_class, pred_class, count)
        SELECT p_run_id, v_task::civic.slug_code, s.slice, s.gold, COALESCE(s.pred,'<null>'), count(*)
        FROM tmp_sliced s GROUP BY s.slice, s.gold, s.pred;

        -- Exactitud por corte, con cota inferior de Wilson como intervalo.
        INSERT INTO civic.eval_metrics (run_id, task_code, class_code, slice, metric_name, metric_value, support, ci_lower)
        SELECT p_run_id, v_task::civic.slug_code, 'overall', s.slice, 'accuracy',
               round(avg(CASE WHEN s.pred = s.gold THEN 1 ELSE 0 END)::numeric, 6),
               count(*),
               civic_ops.wilson_lower_bound(count(*) FILTER (WHERE s.pred = s.gold), count(*))
        FROM tmp_sliced s GROUP BY s.slice;

        -- Precisión, exhaustividad y F1 por clase.
        INSERT INTO civic.eval_metrics (run_id, task_code, class_code, slice, metric_name, metric_value, support)
        WITH per_class AS (
            SELECT s.slice, c.cls,
                   count(*) FILTER (WHERE s.gold = c.cls AND s.pred = c.cls) AS tp,
                   count(*) FILTER (WHERE s.gold <> c.cls AND s.pred = c.cls) AS fp,
                   count(*) FILTER (WHERE s.gold = c.cls AND s.pred IS DISTINCT FROM c.cls) AS fn,
                   count(*) FILTER (WHERE s.gold = c.cls) AS support
            FROM tmp_sliced s
            CROSS JOIN (SELECT DISTINCT gold AS cls FROM tmp_sliced WHERE gold IS NOT NULL) c
            GROUP BY s.slice, c.cls
        ), scored AS (
            SELECT slice, cls, support,
                   CASE WHEN tp+fp = 0 THEN 0 ELSE tp::numeric/(tp+fp) END AS precision,
                   CASE WHEN tp+fn = 0 THEN 0 ELSE tp::numeric/(tp+fn) END AS recall
            FROM per_class
        )
        SELECT p_run_id, v_task::civic.slug_code, cls, slice, m.name, round(m.val, 6), support
        FROM scored,
        LATERAL (VALUES
            ('precision', precision),
            ('recall',    recall),
            ('f1',        CASE WHEN precision + recall = 0 THEN 0
                               ELSE 2 * precision * recall / (precision + recall) END)
        ) AS m(name, val);

        -- F1 macro: promedio no ponderado. Es la métrica correcta cuando las
        -- clases están desbalanceadas, que es siempre en sentimiento político.
        INSERT INTO civic.eval_metrics (run_id, task_code, class_code, slice, metric_name, metric_value, support)
        SELECT p_run_id, v_task::civic.slug_code, 'overall', slice, 'f1_macro',
               round(avg(metric_value), 6), sum(support)
        FROM civic.eval_metrics
        WHERE run_id = p_run_id AND task_code = v_task::civic.slug_code
          AND metric_name = 'f1' AND class_code <> 'overall'
        GROUP BY slice;

        -- F1 ponderado por soporte.
        INSERT INTO civic.eval_metrics (run_id, task_code, class_code, slice, metric_name, metric_value, support)
        SELECT p_run_id, v_task::civic.slug_code, 'overall', slice, 'f1_weighted',
               round(sum(metric_value * support) / NULLIF(sum(support), 0), 6), sum(support)
        FROM civic.eval_metrics
        WHERE run_id = p_run_id AND task_code = v_task::civic.slug_code
          AND metric_name = 'f1' AND class_code <> 'overall'
        GROUP BY slice;

        DROP TABLE tmp_base;
        DROP TABLE tmp_sliced;
    END LOOP;

    -- ── Tareas multietiqueta: Jaccard medio ─────────────────────────────────
    IF 'emotions' = ANY (v_tasks) THEN
        INSERT INTO civic.eval_metrics (run_id, task_code, class_code, slice, metric_name, metric_value, support)
        SELECT p_run_id, 'emotions', 'overall', 'all', 'jaccard_mean',
               round(avg(emotions_jaccard), 6), count(*)
        FROM civic_kpi.v_eval_prediction_detail WHERE run_id = p_run_id AND schema_valid;
    END IF;

    IF 'topics' = ANY (v_tasks) THEN
        INSERT INTO civic.eval_metrics (run_id, task_code, class_code, slice, metric_name, metric_value, support)
        SELECT p_run_id, 'topics', 'overall', 'all', 'jaccard_mean',
               round(avg(topics_jaccard), 6), count(*)
        FROM civic_kpi.v_eval_prediction_detail WHERE run_id = p_run_id AND schema_valid;
    END IF;

    -- ── Fiabilidad operativa del prompt ─────────────────────────────────────
    INSERT INTO civic.eval_metrics (run_id, task_code, class_code, slice, metric_name, metric_value, support)
    SELECT p_run_id, 'sentiment', 'overall', 'all', 'schema_valid_rate',
           round(avg(CASE WHEN schema_valid THEN 1 ELSE 0 END)::numeric, 6), count(*)
    FROM civic_kpi.v_eval_prediction_detail WHERE run_id = p_run_id;

    -- Calibración: brecha entre la confianza declarada y el acierto real.
    -- Un modelo que dice 0.95 y acierta 0.70 es peligroso: sus umbrales mienten.
    INSERT INTO civic.eval_metrics (run_id, task_code, class_code, slice, metric_name, metric_value, support)
    SELECT p_run_id, 'sentiment', 'overall', 'all', 'calibration_gap',
           round(abs(avg(confidence) - avg(CASE WHEN sentiment_correct THEN 1 ELSE 0 END))::numeric, 6),
           count(*)
    FROM civic_kpi.v_eval_prediction_detail
    WHERE run_id = p_run_id AND schema_valid AND confidence IS NOT NULL AND gold_sentiment IS NOT NULL;

    RETURN QUERY
    SELECT m.task_code::text, m.slice, m.metric_name, m.metric_value
    FROM   civic.eval_metrics m
    WHERE  m.run_id = p_run_id AND m.class_code = 'overall'
    ORDER  BY m.task_code, m.slice, m.metric_name;
END;
$$;

COMMENT ON FUNCTION civic_kpi.compute_eval_metrics IS
    'Calcula exactitud, precisión, exhaustividad, F1 (macro y ponderado), Jaccard, tasa de esquema válido '
    'y brecha de calibración, por clase y por corte. Llena eval_metrics y eval_confusion.';

-- =============================================================================
-- 8. COMPARACIÓN CONTRA LÍNEA BASE
-- =============================================================================
CREATE OR REPLACE FUNCTION civic_kpi.compare_eval_runs(
    p_run_id      UUID,
    p_baseline_id UUID
)
RETURNS TABLE (
    task        TEXT,
    slice       TEXT,
    metric      TEXT,
    baseline    NUMERIC,
    candidate   NUMERIC,
    delta       NUMERIC,
    delta_pct   NUMERIC,
    verdict     TEXT
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        c.task_code::text,
        c.slice,
        c.metric_name,
        b.metric_value AS baseline,
        c.metric_value AS candidate,
        round(c.metric_value - b.metric_value, 6) AS delta,
        CASE WHEN b.metric_value = 0 THEN NULL
             ELSE round(100 * (c.metric_value - b.metric_value) / abs(b.metric_value), 2) END AS delta_pct,
        -- Umbral de 0.01 absoluto: por debajo, la diferencia no se distingue
        -- del ruido de muestreo en conjuntos de unos pocos cientos de casos.
        CASE
            WHEN c.metric_name = 'calibration_gap' THEN
                 CASE WHEN c.metric_value < b.metric_value - 0.01 THEN 'mejora'
                      WHEN c.metric_value > b.metric_value + 0.01 THEN 'regresión'
                      ELSE 'sin cambio' END
            WHEN c.metric_value > b.metric_value + 0.01 THEN 'mejora'
            WHEN c.metric_value < b.metric_value - 0.01 THEN 'regresión'
            ELSE 'sin cambio'
        END AS verdict
    FROM civic.eval_metrics c
    JOIN civic.eval_metrics b
      ON b.run_id     = p_baseline_id
     AND b.task_code  = c.task_code
     AND b.class_code = c.class_code
     AND b.slice      = c.slice
     AND b.metric_name= c.metric_name
    WHERE c.run_id = p_run_id AND c.class_code = 'overall'
    ORDER BY c.task_code, c.slice, c.metric_name;
$$;

COMMENT ON FUNCTION civic_kpi.compare_eval_runs IS
    'Compara dos corridas métrica a métrica y por corte. Es el reporte que debe revisarse antes de promover un prompt o modelo.';

-- =============================================================================
-- 9. PUERTA DE PROMOCIÓN
--    Regla explícita para decidir si una versión candidata puede pasar a activa.
-- =============================================================================
CREATE OR REPLACE FUNCTION civic_kpi.evaluate_promotion_gate(
    p_run_id            UUID,
    p_min_f1_macro      NUMERIC DEFAULT 0.70,
    p_min_schema_rate   NUMERIC DEFAULT 0.98,
    p_max_calibration   NUMERIC DEFAULT 0.15,
    p_max_slice_drop    NUMERIC DEFAULT 0.15
)
RETURNS TABLE (passed BOOLEAN, reason TEXT)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_f1        NUMERIC;
    v_schema    NUMERIC;
    v_calib     NUMERIC;
    v_worst     RECORD;
    v_reasons   TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT metric_value INTO v_f1
      FROM civic.eval_metrics
     WHERE run_id = p_run_id AND task_code = 'sentiment'
       AND metric_name = 'f1_macro' AND slice = 'all';

    SELECT metric_value INTO v_schema
      FROM civic.eval_metrics
     WHERE run_id = p_run_id AND metric_name = 'schema_valid_rate' AND slice = 'all';

    SELECT metric_value INTO v_calib
      FROM civic.eval_metrics
     WHERE run_id = p_run_id AND metric_name = 'calibration_gap' AND slice = 'all';

    IF v_f1 IS NULL THEN
        RETURN QUERY SELECT FALSE, 'Sin métricas calculadas. Ejecute compute_eval_metrics primero.';
        RETURN;
    END IF;

    IF v_f1 < p_min_f1_macro THEN
        v_reasons := v_reasons || format('F1 macro %s por debajo del mínimo %s', round(v_f1,4), round(p_min_f1_macro,2));
    END IF;

    IF COALESCE(v_schema, 0) < p_min_schema_rate THEN
        v_reasons := v_reasons || format('Tasa de esquema válido %s por debajo de %s', round(COALESCE(v_schema,0),4), round(p_min_schema_rate,2));
    END IF;

    IF COALESCE(v_calib, 0) > p_max_calibration THEN
        v_reasons := v_reasons || format('Brecha de calibración %s supera %s', round(v_calib,4), round(p_max_calibration,2));
    END IF;

    -- Ningún corte puede quedar muy por debajo del promedio global: es la
    -- comprobación de equidad entre fuentes, idiomas y actores.
    SELECT slice, metric_value INTO v_worst
      FROM civic.eval_metrics
     WHERE run_id = p_run_id AND task_code = 'sentiment'
       AND metric_name = 'accuracy' AND slice <> 'all' AND support >= 30
     ORDER BY metric_value ASC LIMIT 1;

    IF v_worst.metric_value IS NOT NULL THEN
        DECLARE v_overall NUMERIC;
        BEGIN
            SELECT metric_value INTO v_overall FROM civic.eval_metrics
             WHERE run_id = p_run_id AND task_code = 'sentiment'
               AND metric_name = 'accuracy' AND slice = 'all';
            IF v_overall - v_worst.metric_value > p_max_slice_drop THEN
                v_reasons := v_reasons || format(
                    'El corte "%s" queda %s por debajo del global: desempeño desigual entre subgrupos',
                    v_worst.slice, round(v_overall - v_worst.metric_value, 4));
            END IF;
        END;
    END IF;

    IF cardinality(v_reasons) = 0 THEN
        RETURN QUERY SELECT TRUE, format('Aprobado. F1 macro %s, esquema válido %s, calibración %s',
                                          round(v_f1,4), round(COALESCE(v_schema,0),4), round(COALESCE(v_calib,0),4));
    ELSE
        RETURN QUERY SELECT FALSE, array_to_string(v_reasons, ' | ');
    END IF;
END;
$$;

COMMENT ON FUNCTION civic_kpi.evaluate_promotion_gate IS
    'Criterio de promoción: F1 macro, fiabilidad de formato, calibración y equidad entre cortes. '
    'Devuelve el motivo del rechazo, no sólo un booleano.';

-- =============================================================================
-- 10. TRIGGERS
-- =============================================================================
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['eval_datasets'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS tg_%s_updated_at ON civic.%I', t, t);
        EXECUTE format('CREATE TRIGGER tg_%s_updated_at BEFORE UPDATE ON civic.%I
                        FOR EACH ROW EXECUTE FUNCTION civic_ops.set_updated_at()', t, t);
    END LOOP;
END
$$;

-- =============================================================================
-- VERIFICACIÓN
-- =============================================================================
DO $$
BEGIN
    RAISE NOTICE '── Capa de evaluación lista ──';
    RAISE NOTICE '   Flujo: crear dataset → cargar items dorados → congelar → correr modelo →';
    RAISE NOTICE '          compute_eval_metrics() → compare_eval_runs() → evaluate_promotion_gate()';
END
$$;
