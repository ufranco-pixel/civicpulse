-- =============================================================================
-- CivicPulse · smoke_test.sql
-- Prueba de humo end-to-end. Crea una organización efímera, inyecta datos
-- sintéticos, ejercita todos los indicadores y hace ROLLBACK al final.
--
-- No deja rastro en la base. Ejecutar tras cada despliegue:
--   psql -d civicpulse -v ON_ERROR_STOP=1 -f sql/smoke_test.sql
--
-- Si algún ASSERT falla, el script aborta señalando qué se rompió.
-- =============================================================================

\set ON_ERROR_STOP on
SET search_path = civic, civic_cat, civic_kpi, civic_api, civic_ops, public;

BEGIN;

-- El pepper y el contexto se fijan como en producción.
SET LOCAL civicpulse.author_pepper = 'smoke-test-pepper';

\echo '── 1. Alta de organización y campaña ──'

DO $$
DECLARE
    v_org       UUID;
    v_camp      UUID;
    v_src       UUID;
    v_own       UUID;
    v_rival     UUID;
    v_model     UUID;
    v_content   UUID;
    v_inf       UUID;
    v_pub       TIMESTAMPTZ;
    i           INTEGER;
    v_sent      TEXT;
    v_score     NUMERIC;
BEGIN
    INSERT INTO civic.organizations (name, slug, org_type, timezone, pii_policy, dpo_contact)
    VALUES ('Consultora Smoke', 'consultora-smoke', 'consultancy', 'UTC', 'pseudonymize', 'dpo@smoke.test')
    RETURNING id INTO v_org;

    PERFORM civic_ops.set_session_context(v_org, 'smoke-runner', 'smoke');

    INSERT INTO civic.campaigns (organization_id, code, name, slug, campaign_kind,
                                 contest_label, status, starts_on, election_date, timezone)
    VALUES (v_org, 'SMOKE-01', 'Campaña de prueba', 'campana-prueba', 'electoral',
            'Cargo de prueba', 'active', CURRENT_DATE - 60, CURRENT_DATE + 45, 'UTC')
    RETURNING id INTO v_camp;

    INSERT INTO civic.contenders (organization_id, campaign_id, type_code, name, slug, is_own,
                                  aliases, baseline_support_pct, baseline_source, baseline_date)
    VALUES (v_org, v_camp, 'candidate', 'Actor Propio', 'actor-propio', TRUE,
            ARRAY['Propio','A. Propio'], 34.5, 'Encuesta de referencia', CURRENT_DATE - 10)
    RETURNING id INTO v_own;

    INSERT INTO civic.contenders (organization_id, campaign_id, type_code, name, slug, is_own, aliases)
    VALUES (v_org, v_camp, 'candidate', 'Actor Rival', 'actor-rival', FALSE, ARRAY['Rival'])
    RETURNING id INTO v_rival;

    INSERT INTO civic.sources (organization_id, campaign_id, type_code, name, slug,
                               status, collection_mode, legal_basis)
    VALUES (v_org, v_camp, 'x_twitter', 'X — monitoreo', 'x-monitoreo',
            'active', 'streaming', 'public_interest')
    RETURNING id INTO v_src;

    SELECT id INTO v_model FROM civic.ai_models WHERE code = 'llm-classifier-primary' LIMIT 1;

    -- ── 2. Datos sintéticos: 20 días × 12 contenidos ────────────────────────
    FOR i IN 1..240 LOOP
        v_pub := NOW() - ((i % 20) || ' days')::interval - ((i % 24) || ' hours')::interval;

        -- Distribución deliberadamente desbalanceada, como en la realidad.
        v_sent  := CASE WHEN i % 5 = 0 THEN 'negative'
                        WHEN i % 3 = 0 THEN 'positive'
                        WHEN i % 7 = 0 THEN 'mixed'
                        ELSE 'neutral' END;
        v_score := CASE v_sent WHEN 'negative' THEN -0.4 - (i % 5) * 0.1
                               WHEN 'positive' THEN  0.4 + (i % 5) * 0.1
                               ELSE 0.05 - (i % 3) * 0.02 END;

        INSERT INTO civic.contents (
            published_at, organization_id, campaign_id, source_id, content_type_code,
            body, external_id, language_code, fingerprint, author_hash,
            author_followers, likes_count, shares_count, reach_estimate, amplification_weight
        ) VALUES (
            v_pub, v_org, v_camp, v_src, 'comment',
            format('Comentario sintético %s sobre la propuesta de %s en materia de seguridad publica.',
                   i, CASE WHEN i % 2 = 0 THEN 'Actor Propio' ELSE 'Actor Rival' END),
            'smoke-' || i, 'es', ''::bytea,
            civic_ops.pseudonymize_author('autor-' || (i % 40)),
            (i * 37) % 5000, i % 50, i % 12, ((i * 137) % 20000), 1.0
        ) RETURNING id INTO v_content;

        INSERT INTO civic.inferences (
            organization_id, campaign_id, source_id, content_id, published_at,
            analyzed_at, model_id, model_name_snapshot, pipeline,
            sentiment_code, sentiment_score, sentiment_confidence,
            intent_code, intent_confidence, toxicity_score, sarcasm_score,
            overall_confidence, detected_language
        ) VALUES (
            v_org, v_camp, v_src, v_content, v_pub,
            v_pub + INTERVAL '3 minutes', v_model, 'smoke-model', 'llm',
            v_sent::civic.slug_code, v_score, 0.80 + (i % 15) * 0.01,
            CASE WHEN i % 4 = 0 THEN 'criticism' ELSE 'opinion' END, 0.75,
            CASE WHEN i % 11 = 0 THEN 0.7 ELSE 0.08 END,
            0.05,
            0.75 + (i % 20) * 0.01, 'es'
        ) RETURNING id INTO v_inf;

        INSERT INTO civic.inference_emotions (inference_id, analyzed_at, campaign_id, published_at,
                                              emotion_code, score, is_dominant)
        VALUES (v_inf, v_pub + INTERVAL '3 minutes', v_camp, v_pub,
                CASE WHEN v_sent = 'negative' THEN 'indignation'
                     WHEN v_sent = 'positive' THEN 'hope' ELSE 'anticipation' END,
                0.60 + (i % 30) * 0.01, TRUE);

        INSERT INTO civic.inference_stances (inference_id, analyzed_at, campaign_id, published_at,
                                             contender_id, stance_code, stance_score, confidence,
                                             match_method, evidence_span)
        VALUES (v_inf, v_pub + INTERVAL '3 minutes', v_camp, v_pub,
                CASE WHEN i % 2 = 0 THEN v_own ELSE v_rival END,
                CASE WHEN v_sent = 'positive' THEN 'favor'
                     WHEN v_sent = 'negative' THEN 'against' ELSE 'neutral' END,
                v_score, 0.78, 'alias', 'fragmento sintético');

        INSERT INTO civic.inference_topics (inference_id, analyzed_at, campaign_id, published_at,
                                            category_code, relevance, topic_sentiment, is_primary)
        VALUES (v_inf, v_pub + INTERVAL '3 minutes', v_camp, v_pub,
                CASE WHEN i % 3 = 0 THEN 'security' WHEN i % 3 = 1 THEN 'economy' ELSE 'health' END,
                0.85, v_score, TRUE);

        INSERT INTO civic.inference_entities (inference_id, analyzed_at, campaign_id, published_at,
                                              entity_type_code, entity_text, entity_norm,
                                              contender_id, entity_sentiment, confidence)
        VALUES (v_inf, v_pub + INTERVAL '3 minutes', v_camp, v_pub, 'PERSON',
                CASE WHEN i % 2 = 0 THEN 'Actor Propio' ELSE 'Actor Rival' END,
                CASE WHEN i % 2 = 0 THEN 'actor propio' ELSE 'actor rival' END,
                CASE WHEN i % 2 = 0 THEN v_own ELSE v_rival END, v_score, 0.82);
    END LOOP;

    RAISE NOTICE 'Datos sintéticos: 240 contenidos con inferencia completa.';
END
$$;

\echo '── 2. Refresco de vistas materializadas ──'
SELECT view_name, rows, ok FROM civic_kpi.refresh_all(FALSE);

\echo '── 3. Resumen de campaña ──'
SELECT total_mentions, unique_authors, positive_pct, negative_pct,
       net_sentiment, avg_sentiment_score, polarization_index,
       days_to_election, is_reliable
FROM civic_kpi.campaign_overview('SMOKE-01', 30);

\echo '── 4. Serie temporal (últimos 7 días) ──'
SELECT period, total_count, net_sentiment, avg_score, rolling_avg_7, volume_zscore, is_spike
FROM civic_kpi.sentiment_timeseries('SMOKE-01', 7, 'day')
ORDER BY period DESC LIMIT 5;

\echo '── 5. Tablero competitivo ──'
SELECT contender_name, is_own, mentions, share_of_voice, net_support,
       support_wilson_lb, competitive_momentum, baseline_support_pct, rank_by_wilson
FROM civic_kpi.contender_scoreboard('SMOKE-01', 14);

\echo '── 6. Agenda pública ──'
SELECT label_es, mentions, topic_share, avg_sentiment, negative_pct, is_emerging
FROM civic_kpi.topic_agenda('SMOKE-01', 14, 5);

\echo '── 7. Índice de riesgo de crisis ──'
SELECT risk_index, risk_level, volume_component, sentiment_component,
       toxicity_component, flags_component, is_reliable, explanation
FROM civic_kpi.crisis_risk('SMOKE-01', 48);

\echo '── 8. Regla de alerta: simulación y disparo ──'
DO $$
DECLARE
    v_camp UUID; v_org UUID; v_rule UUID;
BEGIN
    SELECT id, organization_id INTO v_camp, v_org FROM civic.campaigns WHERE code = 'SMOKE-01';

    INSERT INTO civic.alert_rules (
        organization_id, campaign_id, campaign_code, name, alert_type_code, severity_code,
        metric, operator, threshold, window_minutes, min_sample_size,
        cooldown_minutes, consecutive_hits, channels
    ) VALUES (
        v_org, v_camp, 'SMOKE-01', 'Negatividad por encima del 15%',
        'negative_spike', 'high', 'negative_pct', 'gt', 15, 60*24*30, 30, 0, 1,
        ARRAY['sse','email']
    ) RETURNING id INTO v_rule;

    -- Regla que NO debe disparar: exige más muestra de la disponible.
    INSERT INTO civic.alert_rules (
        organization_id, campaign_id, campaign_code, name, alert_type_code, severity_code,
        metric, operator, threshold, window_minutes, min_sample_size, channels
    ) VALUES (
        v_org, v_camp, 'SMOKE-01', 'Regla con muestra insuficiente',
        'negative_spike', 'medium', 'negative_pct', 'gt', 1, 5, 100000,
        ARRAY['sse']
    );
END
$$;

\echo '   → simulación (no escribe):'
SELECT rule_name, observed, threshold, sample_size, condition_met, fired, skip_reason
FROM civic.evaluate_alert_rules('SMOKE-01', TRUE);

\echo '   → ejecución real:'
SELECT rule_name, observed, sample_size, fired, skip_reason, alert_id IS NOT NULL AS alerta_creada
FROM civic.evaluate_alert_rules('SMOKE-01', FALSE);

\echo '── 9. Alerta generada con evidencia ──'
SELECT title, severity_label, observed_value, threshold_value, sample_size,
       jsonb_array_length(evidence) AS evidencias, during_blackout
FROM civic_api.alerts WHERE campaign_code = 'SMOKE-01';

\echo '── 10. Vista de inferencias enriquecida ──'
SELECT left(text, 55) AS texto, sentiment_label, sentiment_score,
       jsonb_array_length(emotions) AS n_emo,
       jsonb_array_length(stances)  AS n_stance,
       jsonb_array_length(topics)   AS n_topic
FROM civic_api.inferences WHERE campaign_code = 'SMOKE-01' LIMIT 3;

\echo '── 11. Compatibilidad con la API heredada ──'
SELECT project_code, day, positive_count, negative_count, total_count, avg_score
FROM civic_api.mv_sentiment_daily WHERE project_code = 'SMOKE-01'
ORDER BY day DESC LIMIT 3;

\echo '── 12. Evaluación de clasificador ──'
DO $$
DECLARE
    v_org UUID; v_ds UUID; v_run UUID; v_model UUID; v_item UUID;
    i INTEGER; v_gold TEXT; v_pred TEXT;
BEGIN
    SELECT id INTO v_org FROM civic.organizations WHERE slug = 'consultora-smoke';
    SELECT id INTO v_model FROM civic.ai_models WHERE code = 'llm-classifier-primary' LIMIT 1;

    INSERT INTO civic.eval_datasets (organization_id, code, name, split, task_codes,
                                     sampling_method, annotators_per_item, inter_annotator_agreement)
    VALUES (v_org, 'smoke-gold', 'Conjunto dorado de prueba', 'test',
            ARRAY['sentiment']::civic.slug_code[], 'stratified', 3, 0.78)
    RETURNING id INTO v_ds;

    INSERT INTO civic.eval_runs (organization_id, dataset_id, model_id, name,
                                 status_code, tasks_evaluated, items_total)
    VALUES (v_org, v_ds, v_model, 'corrida smoke', 'completed',
            ARRAY['sentiment']::civic.slug_code[], 60)
    RETURNING id INTO v_run;

    FOR i IN 1..60 LOOP
        v_gold := CASE WHEN i % 3 = 0 THEN 'negative' WHEN i % 3 = 1 THEN 'positive' ELSE 'neutral' END;
        -- 80 % de acierto simulado.
        v_pred := CASE WHEN i % 5 = 0 THEN 'neutral' ELSE v_gold END;

        INSERT INTO civic.eval_items (dataset_id, text, language_code, source_type,
                                      gold_sentiment, difficulty, phenomena)
        VALUES (v_ds, 'Texto dorado ' || i, 'es', 'x_twitter', v_gold::civic.slug_code,
                CASE WHEN i % 4 = 0 THEN 'hard' ELSE 'easy' END,
                CASE WHEN i % 7 = 0 THEN ARRAY['sarcasm'] ELSE ARRAY[]::TEXT[] END)
        RETURNING id INTO v_item;

        INSERT INTO civic.eval_predictions (run_id, item_id, pred_sentiment, confidence,
                                            schema_valid, latency_ms)
        VALUES (v_run, v_item, v_pred::civic.slug_code, 0.85, i % 30 <> 0, 120 + i);
    END LOOP;

    PERFORM civic_kpi.compute_eval_metrics(v_run);
END
$$;

SELECT task_code, slice, class_code, metric_name, metric_value, support
FROM civic.eval_metrics
WHERE class_code = 'overall' AND slice IN ('all','diff:hard','phenom:sarcasm')
ORDER BY slice, metric_name;

\echo '   → puerta de promoción:'
SELECT passed, reason
FROM civic_kpi.evaluate_promotion_gate(
    (SELECT id FROM civic.eval_runs WHERE name = 'corrida smoke'));

\echo '── 13. Cumplimiento ──'
SELECT organization, pii_policy, sources_missing_legal_basis,
       contents_past_retention, contents_with_author_identity,
       subscriptions_without_consent
FROM civic_ops.v_compliance_status
WHERE organization = 'Consultora Smoke';

\echo '── 14. Aserciones ──'
DO $$
DECLARE
    v_n        BIGINT;
    v_reliable BOOLEAN;
    v_alerts   BIGINT;
    v_acc      NUMERIC;
    v_orphans  BIGINT;
BEGIN
    SELECT total_mentions, is_reliable INTO v_n, v_reliable
      FROM civic_kpi.campaign_overview('SMOKE-01', 30);
    ASSERT v_n = 240,  format('Se esperaban 240 menciones, hay %s', v_n);
    ASSERT v_reliable, 'La campaña debería marcarse como confiable con 240 menciones';

    -- Debe haberse creado exactamente una alerta: la segunda regla se descarta
    -- por muestra insuficiente. Es la guarda más importante del motor.
    SELECT count(*) INTO v_alerts FROM civic.alerts WHERE campaign_code = 'SMOKE-01';
    ASSERT v_alerts = 1, format('Se esperaba 1 alerta, hay %s', v_alerts);

    SELECT metric_value INTO v_acc FROM civic.eval_metrics
     WHERE metric_name = 'accuracy' AND slice = 'all' AND task_code = 'sentiment';
    ASSERT v_acc BETWEEN 0.70 AND 0.90, format('Exactitud fuera de rango esperado: %s', v_acc);

    SELECT orphan_rows INTO v_orphans FROM civic_ops.v_default_partition_health;
    ASSERT v_orphans = 0, format('Hay %s filas en la partición por defecto: faltan particiones', v_orphans);

    RAISE NOTICE '';
    RAISE NOTICE '════════════════════════════════════════';
    RAISE NOTICE '  TODAS LAS ASERCIONES PASARON';
    RAISE NOTICE '════════════════════════════════════════';
END
$$;

ROLLBACK;

\echo ''
\echo 'ROLLBACK ejecutado: la base queda como estaba.'
