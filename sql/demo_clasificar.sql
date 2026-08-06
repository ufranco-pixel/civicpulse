-- =============================================================================
-- Análisis de Sentimientos · sql/demo_clasificar.sql
--
-- Clasifica los contenidos que YA están en civic.contents usando un léxico de
-- polaridad en español, e inserta las inferencias correspondientes. Todo dentro
-- de PostgreSQL: sin red, sin Gemini, sin workers. Segundos, no minutos.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/demo_clasificar.sql
--
-- ── QUÉ ES Y QUÉ NO ES ──────────────────────────────────────────────────────
--
-- Esto es un clasificador por diccionario: cuenta palabras positivas y
-- negativas y calcula un puntaje. Es el modelo `rule-baseline` que ya está
-- registrado en civic.ai_models, y las inferencias quedan marcadas con
-- pipeline='rule' para que se sepa de dónde salieron.
--
-- Sirve para demostrar que la tubería completa funciona —ingesta, inferencia,
-- agregación, tablero— con datos reales suyos. NO sirve para tomar decisiones:
-- un léxico no entiende ironía, ni negación compuesta, ni contexto. Su exactitud
-- típica en español ronda el 60-70 % frente al 85-90 % de un LLM bien evaluado.
--
-- Cuando active Gemini, vuelva a clasificar con él: las inferencias nuevas
-- conviven con estas y se distinguen por model_name_snapshot. No hay que borrar
-- nada.
-- =============================================================================

\set ON_ERROR_STOP on
SET search_path = civic, civic_cat, civic_kpi, civic_ops, public;

\echo ''
\echo '── Clasificación por léxico (demo) ──'

-- =============================================================================
-- 1. LÉXICO DE POLARIDAD
--    Términos frecuentes en comentarios políticos en español de México.
--    El peso refleja intensidad: «pésimo» pesa más que «regular».
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_ops.demo_lexicon (
    term    TEXT PRIMARY KEY,
    weight  NUMERIC(4,2) NOT NULL CHECK (weight BETWEEN -3 AND 3)
);

TRUNCATE civic_ops.demo_lexicon;
INSERT INTO civic_ops.demo_lexicon (term, weight) VALUES
-- ── Negativos fuertes ───────────────────────────────────────────────────────
('corrupto',-3),('corrupcion',-3),('corrupta',-3),('ratero',-3),('ladron',-3),
('robo',-3),('roba',-3),('robar',-2.5),('fraude',-3),('estafa',-3),
('mentiroso',-2.5),('mentira',-2.5),('miente',-2.5),('traidor',-3),
('pesimo',-3),('pesima',-3),('horrible',-2.5),('asco',-2.5),('basura',-2.5),
('vergüenza',-2.5),('verguenza',-2.5),('indignante',-2.5),('inaceptable',-2.5),
('incapaz',-2.5),('inutil',-2.5),('fracaso',-2.5),('desastre',-2.5),
('impunidad',-2.5),('cinismo',-2.5),('descarado',-2.5),
-- ── Negativos moderados ─────────────────────────────────────────────────────
('malo',-2),('mala',-2),('mal',-1.5),('peor',-2),('terrible',-2),
('problema',-1.5),('problemas',-1.5),('falla',-1.5),('fallas',-1.5),
('critica',-1.2),('critico',-1.2),('queja',-1.5),('reclamo',-1.5),
('molesto',-1.5),('molesta',-1.5),('enojo',-1.8),('enojado',-1.8),
('coraje',-1.8),('harto',-2),('harta',-2),('cansado',-1.5),
('decepcion',-2),('decepcionado',-2),('preocupa',-1.2),('preocupante',-1.5),
('lento',-1.2),('caro',-1.2),('carisimo',-1.8),('injusto',-2),
('abandono',-2),('olvidado',-1.8),('nada',-1),('nunca',-1),
('inseguridad',-2),('violencia',-2),('miedo',-1.8),('crisis',-1.8),
('no cumple',-2.2),('no sirve',-2.2),('no funciona',-2.2),('sin resultados',-2),
-- ── Positivos fuertes ───────────────────────────────────────────────────────
('excelente',3),('excelentes',3),('extraordinario',3),('magnifico',2.8),
('felicidades',2.5),('felicito',2.5),('admirable',2.5),('ejemplar',2.5),
('honesto',2.5),('honesta',2.5),('honestidad',2.5),('transparente',2.3),
('gracias',2),('agradezco',2),('agradecido',2),
-- ── Positivos moderados ─────────────────────────────────────────────────────
('bueno',2),('buena',2),('bien',1.5),('mejor',1.8),('mejora',1.8),
('mejorando',1.8),('apoyo',1.8),('apoyamos',2),('respaldo',1.8),
('gran',1.5),('grande',1.2),('positivo',1.8),('positiva',1.8),
('funciona',1.5),('cumple',2),('cumplio',2),('cumplido',2),
('avance',1.8),('avances',1.8),('progreso',1.8),('logro',1.8),('logros',1.8),
('esperanza',1.8),('confianza',1.8),('confio',1.8),('orgullo',2),
('trabajo',1.2),('trabajando',1.5),('esfuerzo',1.5),('compromiso',1.5),
('util',1.5),('eficiente',2),('rapido',1.2),('atento',1.5),('amable',1.8),
('recomiendo',2),('felicidad',2),('contento',1.8),('satisfecho',1.8);

\echo '   léxico cargado'

-- =============================================================================
-- 2. FUNCIÓN DE CLASIFICACIÓN
-- =============================================================================
CREATE OR REPLACE FUNCTION civic_ops.demo_score(p_text TEXT)
RETURNS TABLE (score NUMERIC, hits INTEGER)
LANGUAGE sql
STABLE
AS $$
    WITH norm AS (
        -- Mismo normalizado que usa la deduplicación: minúsculas y sin acentos.
        SELECT ' ' || civic_ops.normalize_text(p_text) || ' ' AS t
    ),
    encontrados AS (
        SELECT l.weight
        FROM   civic_ops.demo_lexicon l, norm n
        -- Coincidencia por palabra completa: sin los espacios, «mal» casaría
        -- dentro de «formal» y «nada» dentro de «granada».
        WHERE  n.t LIKE '%' || ' ' || l.term || ' ' || '%'
    )
    SELECT
        -- tanh comprime la suma a [-1,1] sin saturar de golpe: un comentario
        -- con seis términos negativos no debe dar lo mismo que uno con dos.
        COALESCE(round(tanh(sum(weight) / 3.0)::numeric, 5), 0),
        COALESCE(count(*), 0)::int
    FROM encontrados;
$$;

-- =============================================================================
-- 3. CLASIFICAR LOS CONTENIDOS PENDIENTES
-- =============================================================================
DO $$
DECLARE
    v_model   UUID;
    v_total   INTEGER := 0;
    v_ya      INTEGER := 0;
    v_org     UUID;
    r         RECORD;
    v_score   NUMERIC;
    v_hits    INTEGER;
    v_label   TEXT;
    v_conf    NUMERIC;
    v_inf     UUID;
    v_emo     TEXT;
BEGIN
    -- El modelo de reglas ya viene registrado por 05_ai_models.sql.
    SELECT id INTO v_model FROM civic.ai_models WHERE code = 'rule-baseline' LIMIT 1;
    IF v_model IS NULL THEN
        RAISE EXCEPTION 'Falta el modelo rule-baseline. Ejecute sql/05_ai_models.sql.';
    END IF;
    UPDATE civic.ai_models SET status = 'active' WHERE id = v_model;

    SELECT count(*) INTO v_ya
    FROM   civic.contents c
    WHERE  EXISTS (SELECT 1 FROM civic.inferences i WHERE i.content_id = c.id);
    IF v_ya > 0 THEN
        RAISE NOTICE '  % contenidos YA tenían sentimiento: se respetan sin tocar', v_ya;
    END IF;

    FOR r IN
        SELECT c.id, c.published_at, c.organization_id, c.campaign_id,
               c.source_id, c.body
        FROM   civic.contents c
        WHERE  NOT c.is_duplicate AND NOT c.is_excluded
          -- Se salta TODO contenido que ya tenga inferencia, sea de este modelo
          -- o de cualquier otro (Gemini, una carga previa, lo que sea).
          --
          -- Antes el filtro miraba sólo `model_id = rule-baseline`, y eso metía
          -- una segunda inferencia de diccionario junto a una buena ya existente:
          -- el mismo comentario aparecía dos veces en el tablero y los conteos
          -- salían inflados. Un léxico no debe competir con una clasificación
          -- mejor: si ya hay sentimiento, este script no tiene nada que aportar.
          AND  NOT EXISTS (
                 SELECT 1 FROM civic.inferences i
                 WHERE i.content_id = c.id
               )
    LOOP
        SELECT s.score, s.hits INTO v_score, v_hits
        FROM civic_ops.demo_score(r.body) s;

        -- Umbrales deliberadamente anchos: con un léxico, los valores cercanos
        -- a cero son ruido y merecen quedar en «neutral», no forzar un signo.
        v_label := CASE
                     WHEN v_score >  0.20 THEN 'positive'
                     WHEN v_score < -0.20 THEN 'negative'
                     ELSE 'neutral'
                   END;

        -- La confianza crece con el número de términos reconocidos y se topa
        -- en 0.75: un diccionario nunca debería declarar más certeza que eso.
        v_conf := LEAST(0.75, 0.35 + (v_hits * 0.08));

        INSERT INTO civic.inferences (
            organization_id, campaign_id, source_id, content_id, published_at,
            analyzed_at, model_id, model_name_snapshot, model_version_snapshot,
            pipeline, sentiment_code, sentiment_score, sentiment_confidence,
            intent_code, intent_confidence, toxicity_score, sarcasm_score,
            overall_confidence, detected_language, needs_review, review_status
        ) VALUES (
            r.organization_id, r.campaign_id, r.source_id, r.id, r.published_at,
            NOW(), v_model, 'Línea base por léxico', 'lexicon-v1',
            'rule', v_label::civic.slug_code, v_score, v_conf,
            CASE WHEN v_score < -0.4 THEN 'criticism'
                 WHEN v_score >  0.4 THEN 'support'
                 ELSE 'opinion' END::civic.slug_code,
            0.40,
            -- Toxicidad aproximada: sólo la parte negativa del puntaje.
            GREATEST(0, -v_score) * 0.6,
            0,
            v_conf, 'es',
            -- Todo lo que da un léxico merece revisión humana. Marcarlo es
            -- honesto y además llena la cola de revisión del tablero.
            TRUE, 'pending'
        )
        RETURNING id INTO v_inf;

        -- Una emoción dominante derivada del signo, para que el radar y las
        -- barras de emociones tengan algo que mostrar.
        v_emo := CASE
                   WHEN v_score < -0.5 THEN 'indignation'
                   WHEN v_score < -0.2 THEN 'distrust'
                   WHEN v_score >  0.5 THEN 'hope'
                   WHEN v_score >  0.2 THEN 'trust'
                   ELSE 'anticipation'
                 END;

        INSERT INTO civic.inference_emotions (
            inference_id, analyzed_at, campaign_id, published_at,
            emotion_code, score, is_dominant
        )
        SELECT v_inf, i.analyzed_at, r.campaign_id, r.published_at,
               v_emo::civic.slug_code, LEAST(1.0, abs(v_score) + 0.3), TRUE
        FROM civic.inferences i WHERE i.id = v_inf;

        v_total := v_total + 1;
    END LOOP;

    RAISE NOTICE '   % contenidos clasificados', v_total;
END
$$;

-- =============================================================================
-- 4. REFRESCAR LAS VISTAS MATERIALIZADAS
--    Sin esto el tablero sigue vacío: lee de las MVs, no de las tablas.
-- =============================================================================
\echo '   refrescando vistas materializadas…'
SELECT view_name, rows, ok FROM civic_kpi.refresh_all(FALSE);

-- =============================================================================
-- 5. RESULTADO
-- =============================================================================
\echo ''
\echo '── Qué quedó cargado ──'

SELECT c.code AS campana,
       count(*)                                              AS inferencias,
       count(*) FILTER (WHERE i.sentiment_code = 'positive')  AS positivas,
       count(*) FILTER (WHERE i.sentiment_code = 'neutral')   AS neutrales,
       count(*) FILTER (WHERE i.sentiment_code = 'negative')  AS negativas,
       round(avg(i.sentiment_score), 3)                       AS puntaje_medio
FROM   civic.inferences i
JOIN   civic.campaigns  c ON c.id = i.campaign_id
GROUP  BY c.code;

\echo ''
\echo '── Comprobación de los indicadores del tablero ──'
SELECT code FROM civic.campaigns LIMIT 1 \gset campana_
\if :{?campana_code}
    SELECT total_mentions, positive_pct, negative_pct, net_sentiment,
           avg_sentiment_score, is_reliable
    FROM civic_kpi.campaign_overview(:'campana_code', 3650);
\endif

\echo ''
\echo 'Listo. Recargue el tablero.'
\echo ''
\echo 'RECORDATORIO: estas cifras vienen de un diccionario de palabras, no de un'
\echo 'modelo evaluado. Sirven para demostrar que el sistema funciona de extremo'
\echo 'a extremo. No las presente como medición definitiva.'
