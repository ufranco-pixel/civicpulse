-- =============================================================================
-- Análisis de Sentimientos · 05_ai_models.sql
-- Proveedores, modelos, plantillas de prompt y versionado.
--
-- El motor es "LLM con respaldo de modelos especializados": un prompt
-- estructurado clasifica el comentario y, si el LLM no está disponible o la
-- confianza es baja, se enruta a un modelo transformer registrado aquí.
--
-- El versionado de prompts NO es accesorio. Un prompt es un clasificador:
-- cambiarlo cambia las métricas. Sin versión trazable en cada inferencia,
-- la serie histórica deja de ser comparable y no hay forma de saber por qué.
-- =============================================================================

\set ON_ERROR_STOP on
SET search_path = civic, civic_cat, civic_ops, public;

-- =============================================================================
-- 1. PROVEEDORES
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.model_providers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            civic.slug_code NOT NULL UNIQUE,
    name            TEXT        NOT NULL,
    kind            TEXT        NOT NULL
                    CHECK (kind IN ('llm_api','self_hosted','managed_nlp','rule_engine','human')),
    base_url        TEXT,
    credentials_ref TEXT,       -- referencia al gestor de secretos, nunca la clave
    -- Región donde se procesan los datos. Relevante para transferencia
    -- internacional de datos personales.
    data_region     TEXT,
    -- El proveedor se compromete a no entrenar con los datos enviados.
    no_training_clause BOOLEAN  NOT NULL DEFAULT FALSE,
    default_timeout_ms INTEGER  NOT NULL DEFAULT 30000 CHECK (default_timeout_ms > 0),
    rate_limit_rpm  INTEGER     CHECK (rate_limit_rpm > 0),
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    settings        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN civic.model_providers.no_training_clause IS
    'Debe ser TRUE para procesar opinión política en un proveedor externo. Si es FALSE, exija el acuerdo antes de enviar datos.';

INSERT INTO civic.model_providers (code, name, kind, base_url, credentials_ref, data_region, no_training_clause, rate_limit_rpm, settings) VALUES
  ('gemini',      'Google Gemini',        'llm_api',     'https://generativelanguage.googleapis.com', 'env:GEMINI_API_KEY', NULL, FALSE, 1000,
   jsonb_build_object(
     'api_version', 'v1beta',
     'json_mode_field', 'responseMimeType',
     -- Los filtros de seguridad de Gemini bloquean discurso político agresivo,
     -- que es justamente lo que hay que clasificar. Se desactivan por llamada.
     'safety_threshold', 'BLOCK_NONE',
     -- AI Studio (clave gratuita) NO garantiza la cláusula de no entrenamiento.
     -- Vertex AI sí. Ver la nota de no_training_clause más abajo.
     'tier_note', 'AI Studio gratuito: los datos pueden usarse para mejorar el servicio. Use Vertex AI o el nivel de pago para opinión política.'
   )),
  ('vertex_ai',   'Google Vertex AI',     'llm_api',     NULL,                        'vault://oeste-sentimientos/vertex',     NULL, TRUE,  1200,
   jsonb_build_object('api_version','v1','note','Mismos modelos Gemini con cláusula de no entrenamiento y región de datos configurable.')),
  ('anthropic',   'Anthropic',            'llm_api',     'https://api.anthropic.com', 'vault://oeste-sentimientos/anthropic',  NULL, TRUE,  1000, '{}'::jsonb),
  ('openai',      'OpenAI',               'llm_api',     'https://api.openai.com',    'vault://oeste-sentimientos/openai',     NULL, TRUE,  1000, '{}'::jsonb),
  ('azure_openai','Azure OpenAI',         'llm_api',     NULL,                        'vault://oeste-sentimientos/azure',      NULL, TRUE,  1200, '{}'::jsonb),
  ('vllm_local',  'vLLM autoalojado',     'self_hosted', 'http://vllm.internal:8000', NULL,                            NULL, TRUE,  NULL, '{}'::jsonb),
  ('hf_inference','Hugging Face',         'managed_nlp', 'https://api-inference.huggingface.co', 'vault://oeste-sentimientos/hf', NULL, FALSE, 300, '{}'::jsonb),
  ('hf_local',    'Transformers local',   'self_hosted', 'http://ml.internal:8500',   NULL,                            NULL, TRUE,  NULL, '{}'::jsonb),
  ('internal',    'Motor de reglas',      'rule_engine', NULL,                        NULL,                            NULL, TRUE,  NULL, '{}'::jsonb),
  ('human',       'Anotación humana',     'human',       NULL,                        NULL,                            NULL, TRUE,  NULL, '{}'::jsonb)
ON CONFLICT (code) DO UPDATE
   SET name = EXCLUDED.name, kind = EXCLUDED.kind, base_url = EXCLUDED.base_url,
       settings = EXCLUDED.settings;

COMMENT ON COLUMN civic.model_providers.no_training_clause IS
    'TRUE si el proveedor se compromete contractualmente a no entrenar con los datos enviados. '
    'El nivel gratuito de Google AI Studio está marcado FALSE a propósito: sus términos permiten '
    'usar el contenido para mejorar el servicio. Para opinión política de personas identificables '
    'conviene el nivel de pago o Vertex AI, que sí lo excluyen. '
    'civic_ops.v_compliance_status cuenta los proveedores activos sin esta cláusula.';

-- =============================================================================
-- 2. MODELOS
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.ai_models (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id       UUID            NOT NULL REFERENCES civic.model_providers(id) ON DELETE RESTRICT,
    -- NULL = modelo compartido por todas las organizaciones.
    organization_id   UUID            REFERENCES civic.organizations(id) ON DELETE CASCADE,

    code              civic.slug_code NOT NULL,
    name              TEXT            NOT NULL,
    -- Identificador exacto que espera la API del proveedor.
    model_identifier  TEXT            NOT NULL,
    version           TEXT            NOT NULL DEFAULT 'v1',

    task_codes        civic.slug_code[] NOT NULL DEFAULT ARRAY[]::civic.slug_code[],
    language_codes    civic.lang_code[] NOT NULL DEFAULT ARRAY['es']::civic.lang_code[],

    -- Papel dentro del pipeline. Determina el orden de intento.
    role              TEXT            NOT NULL DEFAULT 'primary'
                      CHECK (role IN ('primary','fallback','specialist','shadow','baseline')),
    -- shadow: se ejecuta en paralelo sin afectar el tablero. Sirve para comparar
    -- un modelo candidato contra el vigente antes de promoverlo.
    priority          SMALLINT        NOT NULL DEFAULT 100,

    parameters        JSONB           NOT NULL DEFAULT '{}'::jsonb,
    -- Métricas de la última evaluación. Las históricas viven en 07_evaluation.
    evaluation_metrics JSONB          NOT NULL DEFAULT '{}'::jsonb,
    last_evaluated_at TIMESTAMPTZ,

    -- Economía del pipeline.
    cost_per_1k_input  NUMERIC(10,6)  CHECK (cost_per_1k_input  >= 0),
    cost_per_1k_output NUMERIC(10,6)  CHECK (cost_per_1k_output >= 0),
    avg_latency_ms     INTEGER        CHECK (avg_latency_ms >= 0),
    max_tokens         INTEGER        CHECK (max_tokens > 0),
    supports_json_mode BOOLEAN        NOT NULL DEFAULT FALSE,

    status            TEXT            NOT NULL DEFAULT 'inactive'
                      CHECK (status IN ('active','inactive','deprecated','testing')),
    is_default        BOOLEAN         NOT NULL DEFAULT FALSE,
    notes             TEXT,
    created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    created_by        TEXT,

    UNIQUE (provider_id, code, version)
);

COMMENT ON COLUMN civic.ai_models.role IS
    'primary: clasificador vigente. fallback: se usa si el primario falla. '
    'specialist: se invoca sólo para tareas concretas (p.ej. toxicidad). '
    'shadow: corre en paralelo sin afectar el tablero, para comparar candidatos. '
    'baseline: referencia fija contra la que se mide toda mejora.';
COMMENT ON COLUMN civic.ai_models.supports_json_mode IS
    'Si es FALSE, el parser debe tolerar texto alrededor del JSON. Afecta la tasa de fallo del prompt.';

CREATE INDEX IF NOT EXISTS ix_models_active   ON civic.ai_models (role, priority) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_models_tasks    ON civic.ai_models USING GIN (task_codes);
CREATE INDEX IF NOT EXISTS ix_models_org      ON civic.ai_models (organization_id) WHERE organization_id IS NOT NULL;

-- Un solo modelo por defecto por organización (NULL = ámbito global).
CREATE UNIQUE INDEX IF NOT EXISTS ux_models_one_default
    ON civic.ai_models (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE is_default;

-- La FK de inferences.model_id se declara aquí porque ai_models se crea después.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_inf_model'
    ) THEN
        ALTER TABLE civic.inferences
            ADD CONSTRAINT fk_inf_model FOREIGN KEY (model_id)
            REFERENCES civic.ai_models(id) ON DELETE RESTRICT;
    END IF;
END
$$;

-- =============================================================================
-- 3. PLANTILLAS DE PROMPT
--    Una plantilla es un clasificador. Se versiona con el mismo rigor que el
--    código: cada versión es inmutable y cada inferencia apunta a la suya.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.prompt_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID            REFERENCES civic.organizations(id) ON DELETE CASCADE,
    code            civic.slug_code NOT NULL,
    name            TEXT            NOT NULL,
    purpose         TEXT            NOT NULL
                    CHECK (purpose IN ('classification','evaluation','summarization',
                                       'extraction','moderation','report_narrative')),
    task_codes      civic.slug_code[] NOT NULL DEFAULT ARRAY[]::civic.slug_code[],
    description     TEXT,
    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- organization_id NULL = plantilla global compartida.
CREATE UNIQUE INDEX IF NOT EXISTS ux_prompt_templates_scope_code
    ON civic.prompt_templates (
        COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), code
    );

CREATE TABLE IF NOT EXISTS civic.prompt_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id     UUID        NOT NULL REFERENCES civic.prompt_templates(id) ON DELETE CASCADE,
    version         TEXT        NOT NULL,

    system_prompt   TEXT        NOT NULL,
    user_template   TEXT        NOT NULL,     -- con marcadores {{variable}}
    -- Esquema JSON que debe cumplir la salida. Se valida antes de persistir.
    output_schema   JSONB,
    -- Ejemplos few-shot. Se separan del prompt para poder medir su aporte.
    few_shot        JSONB       NOT NULL DEFAULT '[]'::jsonb,
    variables       TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],

    temperature     NUMERIC(3,2) NOT NULL DEFAULT 0.0 CHECK (temperature BETWEEN 0 AND 2),
    max_tokens      INTEGER     CHECK (max_tokens > 0),

    -- Huella del contenido: detecta ediciones no versionadas.
    content_hash    BYTEA       NOT NULL,

    status          TEXT        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','testing','active','deprecated')),
    -- Sólo se promueve a 'active' con una evaluación aprobada. Lo verifica un trigger.
    promoted_at     TIMESTAMPTZ,
    promoted_by     TEXT,
    deprecated_at   TIMESTAMPTZ,
    changelog       TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      TEXT,

    UNIQUE (template_id, version)
);

COMMENT ON TABLE  civic.prompt_versions IS
    'Versiones inmutables de prompt. Cada inferencia guarda prompt_version_id: sin eso la serie histórica no es comparable.';
COMMENT ON COLUMN civic.prompt_versions.content_hash IS
    'SHA-256 de system_prompt || user_template. Detecta ediciones in situ que romperían la trazabilidad.';

CREATE INDEX IF NOT EXISTS ix_promptver_template ON civic.prompt_versions (template_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_promptver_one_active
    ON civic.prompt_versions (template_id) WHERE status = 'active';

-- Calcula el hash e impide modificar una versión ya activa.
CREATE OR REPLACE FUNCTION civic.prompt_version_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.content_hash := sha256(convert_to(
        COALESCE(NEW.system_prompt,'') || E'\n---\n' || COALESCE(NEW.user_template,''), 'UTF8'));

    IF TG_OP = 'UPDATE' AND OLD.status = 'active' THEN
        IF NEW.system_prompt IS DISTINCT FROM OLD.system_prompt
           OR NEW.user_template IS DISTINCT FROM OLD.user_template
           OR NEW.output_schema IS DISTINCT FROM OLD.output_schema
           OR NEW.few_shot      IS DISTINCT FROM OLD.few_shot THEN
            RAISE EXCEPTION
                'La versión de prompt % está activa y es inmutable. Cree una versión nueva.', OLD.version
                USING ERRCODE = '25006',
                      HINT = 'INSERT una fila con version distinta y promuévala.';
        END IF;
    END IF;

    IF NEW.status = 'active' AND NEW.promoted_at IS NULL THEN
        NEW.promoted_at := NOW();
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_prompt_version_guard ON civic.prompt_versions;
CREATE TRIGGER tg_prompt_version_guard
    BEFORE INSERT OR UPDATE ON civic.prompt_versions
    FOR EACH ROW EXECUTE FUNCTION civic.prompt_version_guard();

-- FK diferida de inferences hacia prompt_versions.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inf_promptver') THEN
        ALTER TABLE civic.inferences
            ADD CONSTRAINT fk_inf_promptver FOREIGN KEY (prompt_version_id)
            REFERENCES civic.prompt_versions(id) ON DELETE SET NULL;
    END IF;
END
$$;

-- =============================================================================
-- 4. CONFIGURACIÓN DEL PIPELINE POR CAMPAÑA
--    Qué modelo y qué prompt usa cada campaña para cada tarea.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic.campaign_pipeline (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id       UUID            NOT NULL REFERENCES civic.campaigns(id) ON DELETE CASCADE,
    task_code         civic.slug_code NOT NULL REFERENCES civic_cat.nlp_tasks(code),
    model_id          UUID            NOT NULL REFERENCES civic.ai_models(id) ON DELETE RESTRICT,
    prompt_version_id UUID            REFERENCES civic.prompt_versions(id) ON DELETE SET NULL,
    fallback_model_id UUID            REFERENCES civic.ai_models(id) ON DELETE SET NULL,

    -- Por debajo de este umbral la inferencia se marca para revisión humana.
    min_confidence    civic.unit_score NOT NULL DEFAULT 0.60,
    -- Enrutar al fallback si la confianza del primario no alcanza este valor.
    fallback_threshold civic.unit_score NOT NULL DEFAULT 0.45,
    is_enabled        BOOLEAN         NOT NULL DEFAULT TRUE,
    settings          JSONB           NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    UNIQUE (campaign_id, task_code)
);

COMMENT ON TABLE civic.campaign_pipeline IS
    'Configuración por campaña y tarea. Permite que una campaña use un modelo distinto sin afectar a las demás.';

-- =============================================================================
-- 5. TRIGGERS DE updated_at
-- =============================================================================
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['model_providers','ai_models','prompt_templates','campaign_pipeline'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS tg_%s_updated_at ON civic.%I', t, t);
        EXECUTE format('CREATE TRIGGER tg_%s_updated_at BEFORE UPDATE ON civic.%I
                        FOR EACH ROW EXECUTE FUNCTION civic_ops.set_updated_at()', t, t);
    END LOOP;
END
$$;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['ai_models','prompt_versions','campaign_pipeline'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS tg_%s_audit ON civic.%I', t, t);
        EXECUTE format('CREATE TRIGGER tg_%s_audit AFTER INSERT OR UPDATE OR DELETE ON civic.%I
                        FOR EACH ROW EXECUTE FUNCTION civic_ops.audit_trigger()', t, t);
    END LOOP;
END
$$;

-- =============================================================================
-- 6. MODELOS DE REFERENCIA
--    Registrados como inactivos. Actívelos y ajuste model_identifier a lo que
--    su proveedor exponga realmente.
-- =============================================================================
INSERT INTO civic.ai_models (
    provider_id, code, name, model_identifier, version, task_codes, language_codes,
    role, priority, supports_json_mode, max_tokens, status, is_default, notes, parameters
)
SELECT p.id, v.code, v.name, v.ident, v.ver, v.tasks::civic.slug_code[], v.langs::civic.lang_code[],
       v.role, v.prio, v.json_mode, v.maxtok, 'inactive', FALSE, v.notes, v.params::jsonb
FROM (VALUES
  ('gemini','llm-classifier-primary','Clasificador Gemini (primario)','gemini-flash-lite-latest','v1',
   ARRAY['sentiment','stance','emotions','intent','topics','ner','risk_flags','sarcasm','summary'],
   ARRAY['es','en','pt'],'primary',10,TRUE,4096,
   'Clasificador principal. Usa la plantilla civic-comment-classifier v1 de prompts/. '
   'responseMimeType=application/json fuerza salida JSON: es la diferencia entre 96% y 99.9% '
   'de esquema válido, y schema_valid_rate es criterio de la puerta de promoción.',
   '{"json_mode":true,"response_mime_type":"application/json","use_response_schema":true,'
   '"safety_threshold":"BLOCK_NONE","stop_on_schema_violation":true}'),

  ('gemini','llm-classifier-quality','Clasificador Gemini (alta calidad)','gemini-flash-latest','v1',
   ARRAY['sentiment','stance','emotions','intent','topics','ner','risk_flags','sarcasm'],
   ARRAY['es','en','pt'],'shadow',15,TRUE,8192,
   'Modelo mayor para correr en sombra contra el primario y decidir si el salto de calidad '
   'justifica el costo. No afecta al tablero mientras esté en rol shadow.',
   '{"json_mode":true,"response_mime_type":"application/json","safety_threshold":"BLOCK_NONE"}'),

  ('openai','llm-classifier-fallback','Clasificador LLM (respaldo)','gpt-4.1-mini','v1',
   ARRAY['sentiment','stance','emotions','intent','topics','ner'],
   ARRAY['es','en','pt'],'fallback',20,TRUE,4096,
   'Proveedor DISTINTO al primario a propósito: un respaldo en la misma API cae con ella. '
   'Se invoca si el primario falla o su confianza baja de fallback_threshold.',
   '{"json_mode":true}'),

  ('hf_local','xlmr-sentiment-es','XLM-RoBERTa sentimiento','cardiffnlp/twitter-xlm-roberta-base-sentiment','v1',
   ARRAY['sentiment'], ARRAY['es','en','pt'],'specialist',30,FALSE,512,
   'Transformer especializado. Barato y rápido: absorbe el volumen alto donde el LLM sería caro.',
   '{"labels":{"0":"negative","1":"neutral","2":"positive"},"runtime":"onnx","quantization":"int8"}'),

  ('hf_local','toxicity-multilingual','Detector de toxicidad','textdetox/xlmr-large-toxicity-classifier','v1',
   ARRAY['toxicity','risk_flags'], ARRAY['es','en','pt'],'specialist',40,FALSE,512,
   'Toxicidad e incivilidad. Su salida alimenta las banderas de riesgo y las alertas de protección al equipo.',
   '{"threshold":0.5}'),

  ('hf_local','stance-detection-es','Detector de postura','stance-es-base','v1',
   ARRAY['stance'], ARRAY['es'],'specialist',35,FALSE,512,
   'Postura hacia un objetivo dado. Requiere fine-tuning con las anotaciones de la propia campaña.',
   '{"requires_target":true}'),

  ('internal','rule-baseline','Línea base por reglas','lexicon-v1','v1',
   ARRAY['sentiment'], ARRAY['es'],'baseline',900,FALSE,NULL,
   'Diccionario de polaridad. Existe para que toda mejora se mida contra algo, no contra el vacío.',
   '{"lexicon":"es-polarity-v1"}')
) AS v(prov, code, name, ident, ver, tasks, langs, role, prio, json_mode, maxtok, notes, params)
JOIN civic.model_providers p ON p.code = v.prov
ON CONFLICT (provider_id, code, version) DO NOTHING;

-- =============================================================================
-- VERIFICACIÓN
-- =============================================================================
DO $$
DECLARE v_p INTEGER; v_m INTEGER;
BEGIN
    SELECT count(*) INTO v_p FROM civic.model_providers;
    SELECT count(*) INTO v_m FROM civic.ai_models;
    RAISE NOTICE '── Capa de modelos: % proveedores, % modelos registrados (inactivos) ──', v_p, v_m;
    RAISE NOTICE '   Actívelos con: UPDATE civic.ai_models SET status = ''active'' WHERE code = ''...'';';
END
$$;
