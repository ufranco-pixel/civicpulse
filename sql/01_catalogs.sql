-- =============================================================================
-- Análisis de Sentimientos · 01_catalogs.sql
-- Catálogos de referencia (esquema civic_cat) + carga inicial.
--
-- Criterio de diseño: catálogos como TABLAS, no como ENUM nativos.
--   · Se pueden extender sin ALTER TYPE ni bloqueo de tabla.
--   · Admiten etiquetas multilingües, colores de UI y orden de despliegue.
--   · Permiten desactivar valores sin romper el histórico (is_active).
--
-- Neutralidad: ningún catálogo asume un país, sistema electoral ni partido.
-- La taxonomía es genérica y se especializa por organización en 02_core.sql.
-- =============================================================================

\set ON_ERROR_STOP on
SET search_path = civic, civic_cat, civic_ops, public;

-- -----------------------------------------------------------------------------
-- Plantilla común de catálogo:
--   id           SMALLINT identidad
--   code         slug estable — es lo que viaja por la API, nunca el id
--   label_es/en  etiqueta para UI
--   color_token  variable CSS del design system (no un hex, para respetar temas)
--   sort_order   orden de despliegue
--   is_active    baja lógica
-- -----------------------------------------------------------------------------

-- =============================================================================
-- 1. SENTIMIENTO
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_cat.sentiment_types (
    id           SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code         civic.slug_code NOT NULL UNIQUE,
    label_es     TEXT     NOT NULL,
    label_en     TEXT     NOT NULL,
    -- Valor numérico canónico usado para promediar sentimiento agregado.
    polarity     SMALLINT NOT NULL CHECK (polarity BETWEEN -1 AND 1),
    color_token  TEXT     NOT NULL,
    sort_order   SMALLINT NOT NULL DEFAULT 0,
    is_active    BOOLEAN  NOT NULL DEFAULT TRUE,
    description  TEXT
);

COMMENT ON TABLE  civic_cat.sentiment_types IS 'Clases de sentimiento. polarity alimenta los promedios agregados.';
COMMENT ON COLUMN civic_cat.sentiment_types.polarity IS
    '-1 negativo, 0 neutral/mixto, 1 positivo. "mixed" vale 0 porque no debe sesgar la media.';

INSERT INTO civic_cat.sentiment_types (code, label_es, label_en, polarity, color_token, sort_order, description) VALUES
  ('positive', 'Positivo', 'Positive',  1, '--c-positive', 1, 'Valoración favorable explícita.'),
  ('neutral',  'Neutral',  'Neutral',   0, '--c-neutral',  2, 'Informativo o sin carga valorativa.'),
  ('negative', 'Negativo', 'Negative', -1, '--c-negative', 3, 'Valoración desfavorable explícita.'),
  ('mixed',    'Mixto',    'Mixed',     0, '--c-mixed',    4, 'Coexisten valoraciones opuestas en el mismo texto.')
ON CONFLICT (code) DO UPDATE
   SET label_es = EXCLUDED.label_es, label_en = EXCLUDED.label_en,
       polarity = EXCLUDED.polarity, color_token = EXCLUDED.color_token;

-- =============================================================================
-- 2. EMOCIONES
--    Base: rueda de Plutchik (8 primarias) + 4 emociones de alta relevancia
--    en discurso político que Plutchik no captura con precisión.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_cat.emotion_types (
    id            SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code          civic.slug_code NOT NULL UNIQUE,
    label_es      TEXT     NOT NULL,
    label_en      TEXT     NOT NULL,
    family        TEXT     NOT NULL CHECK (family IN ('plutchik','civic')),
    -- Valencia esperada: orienta la lectura del tablero.
    valence       SMALLINT NOT NULL CHECK (valence BETWEEN -1 AND 1),
    -- Activación: emociones de alta activación predicen movilización y viralidad.
    arousal       TEXT     NOT NULL CHECK (arousal IN ('low','medium','high')),
    color_token   TEXT     NOT NULL,
    sort_order    SMALLINT NOT NULL DEFAULT 0,
    is_active     BOOLEAN  NOT NULL DEFAULT TRUE,
    description   TEXT
);

COMMENT ON TABLE civic_cat.emotion_types IS
    'Emociones detectables. arousal alto + valencia negativa es el mejor predictor temprano de crisis.';

INSERT INTO civic_cat.emotion_types (code, label_es, label_en, family, valence, arousal, color_token, sort_order, description) VALUES
  ('joy',          'Alegría',      'Joy',          'plutchik',  1, 'high',   '--c-joy',          1,  'Entusiasmo, celebración.'),
  ('trust',        'Confianza',    'Trust',        'plutchik',  1, 'medium', '--c-trust',        2,  'Credibilidad atribuida al actor.'),
  ('fear',         'Miedo',        'Fear',         'plutchik', -1, 'high',   '--c-fear',         3,  'Temor ante un escenario o actor.'),
  ('surprise',     'Sorpresa',     'Surprise',     'plutchik',  0, 'high',   '--c-surprise',     4,  'Reacción ante lo inesperado.'),
  ('sadness',      'Tristeza',     'Sadness',      'plutchik', -1, 'low',    '--c-sadness',      5,  'Desánimo, resignación.'),
  ('disgust',      'Asco',         'Disgust',      'plutchik', -1, 'medium', '--c-disgust',      6,  'Rechazo moral.'),
  ('anger',        'Enojo',        'Anger',        'plutchik', -1, 'high',   '--c-anger',        7,  'Ira dirigida a un actor o hecho.'),
  ('anticipation', 'Expectativa',  'Anticipation', 'plutchik',  0, 'medium', '--c-anticipation', 8,  'Espera de un resultado futuro.'),
  -- Extensiones cívicas
  ('indignation',  'Indignación',  'Indignation',  'civic',    -1, 'high',   '--c-anger',        9,  'Enojo con componente moral por injusticia percibida. Precede a la movilización.'),
  ('hope',         'Esperanza',    'Hope',         'civic',     1, 'medium', '--c-joy',          10, 'Expectativa positiva de cambio. Correlaciona con intención de voto.'),
  ('distrust',     'Desconfianza', 'Distrust',     'civic',    -1, 'medium', '--c-disgust',      11, 'Sospecha sistemática. Distinta del miedo: no teme, descree.'),
  ('apathy',       'Apatía',       'Apathy',       'civic',     0, 'low',    '--c-neutral',      12, 'Desafección. Señal temprana de abstencionismo.')
ON CONFLICT (code) DO UPDATE
   SET label_es = EXCLUDED.label_es, label_en = EXCLUDED.label_en,
       valence = EXCLUDED.valence, arousal = EXCLUDED.arousal;

-- =============================================================================
-- 3. INTENCIÓN COMUNICATIVA
--    Qué está *haciendo* el autor con el comentario, no qué siente.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_cat.intent_types (
    id           SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code         civic.slug_code NOT NULL UNIQUE,
    label_es     TEXT    NOT NULL,
    label_en     TEXT    NOT NULL,
    -- Intenciones accionables generan tarea para el equipo de campaña.
    is_actionable BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order   SMALLINT NOT NULL DEFAULT 0,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    description  TEXT
);

INSERT INTO civic_cat.intent_types (code, label_es, label_en, is_actionable, sort_order, description) VALUES
  ('opinion',        'Opinión',            'Opinion',         FALSE, 1,  'Postura sin demanda explícita.'),
  ('support',        'Apoyo',              'Support',         FALSE, 2,  'Adhesión declarada.'),
  ('criticism',      'Crítica',            'Criticism',       FALSE, 3,  'Cuestionamiento sustantivo.'),
  ('question',       'Pregunta',           'Question',        TRUE,  4,  'Solicita información. Requiere respuesta.'),
  ('demand',         'Demanda',            'Demand',          TRUE,  5,  'Exige una acción o compromiso concreto.'),
  ('complaint',      'Queja',              'Complaint',       TRUE,  6,  'Reporta un problema o mal servicio.'),
  ('report',         'Denuncia',           'Report',          TRUE,  7,  'Señala una irregularidad. Escalamiento prioritario.'),
  ('mobilization',   'Convocatoria',       'Mobilization',    TRUE,  8,  'Llama a actuar: votar, marchar, difundir.'),
  ('disinformation', 'Desinformación',     'Disinformation',  TRUE,  9,  'Difunde afirmación verificablemente falsa.'),
  ('humor',          'Humor / sátira',     'Humor',           FALSE, 10, 'Ironía o meme. Alto riesgo de mala clasificación de sentimiento.'),
  ('spam',           'Spam',               'Spam',            FALSE, 11, 'Contenido irrelevante o comercial.'),
  ('threat',         'Amenaza',            'Threat',          TRUE,  12, 'Amenaza de daño. Escalamiento inmediato a seguridad y legal.'),
  ('other',          'Otro',               'Other',           FALSE, 99, 'No encaja en las categorías anteriores.')
ON CONFLICT (code) DO UPDATE
   SET label_es = EXCLUDED.label_es, is_actionable = EXCLUDED.is_actionable;

-- =============================================================================
-- 4. POSTURA (STANCE)
--    Eje independiente del sentimiento. Un comentario puede tener sentimiento
--    negativo ("qué rabia que lo ataquen así") y postura de apoyo.
--    Confundir ambos es el error de medición más caro en analítica política.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_cat.stance_types (
    id           SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code         civic.slug_code NOT NULL UNIQUE,
    label_es     TEXT     NOT NULL,
    label_en     TEXT     NOT NULL,
    -- Peso para el índice de apoyo neto.
    weight       NUMERIC(3,2) NOT NULL CHECK (weight BETWEEN -1 AND 1),
    color_token  TEXT     NOT NULL,
    sort_order   SMALLINT NOT NULL DEFAULT 0,
    is_active    BOOLEAN  NOT NULL DEFAULT TRUE,
    description  TEXT
);

COMMENT ON TABLE civic_cat.stance_types IS
    'Posición del autor respecto a un contendiente o propuesta. Ortogonal al sentimiento del texto.';

INSERT INTO civic_cat.stance_types (code, label_es, label_en, weight, color_token, sort_order, description) VALUES
  ('favor',       'A favor',      'In favor',    1.00, '--c-positive', 1, 'Apoya al actor o propuesta.'),
  ('lean_favor',  'Inclinado a favor','Leaning favor', 0.50, '--c-positive', 2, 'Apoyo condicionado o tibio.'),
  ('neutral',     'Neutral',      'Neutral',     0.00, '--c-neutral',  3, 'Menciona sin tomar posición.'),
  ('lean_against','Inclinado en contra','Leaning against', -0.50, '--c-mixed', 4, 'Reservas sin rechazo pleno.'),
  ('against',     'En contra',    'Against',    -1.00, '--c-negative', 5, 'Se opone al actor o propuesta.'),
  ('undecided',   'Indeciso',     'Undecided',   0.00, '--c-mixed',    6, 'Manifiesta duda explícita. Segmento objetivo de persuasión.'),
  ('unclear',     'No determinable','Unclear',   0.00, '--c-neutral',  7, 'El texto no permite inferir postura con confianza.')
ON CONFLICT (code) DO UPDATE
   SET label_es = EXCLUDED.label_es, weight = EXCLUDED.weight;

-- =============================================================================
-- 5. TIPOS DE ENTIDAD (NER)
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_cat.entity_types (
    id           SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code         VARCHAR(24) NOT NULL UNIQUE CHECK (code ~ '^[A-Z_]{2,24}$'),
    label_es     TEXT    NOT NULL,
    label_en     TEXT    NOT NULL,
    color_token  TEXT    NOT NULL,
    sort_order   SMALLINT NOT NULL DEFAULT 0,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    description  TEXT
);

INSERT INTO civic_cat.entity_types (code, label_es, label_en, color_token, sort_order, description) VALUES
  ('PERSON',      'Persona',         'Person',        '--c-mixed',    1,  'Individuo nombrado.'),
  ('PARTY',       'Partido',         'Party',         '--c-accent',   2,  'Organización político-partidista.'),
  ('COALITION',   'Coalición',       'Coalition',     '--c-accent',   3,  'Alianza electoral.'),
  ('ORG',         'Organización',    'Organization',  '--c-info',     4,  'Institución, empresa u ONG.'),
  ('GOV_BODY',    'Órgano público',  'Public body',   '--c-info',     5,  'Dependencia o poder del Estado.'),
  ('LOCATION',    'Lugar',           'Location',      '--c-positive', 6,  'Territorio o punto geográfico.'),
  ('POLICY',      'Política pública','Policy',        '--c-brand-600',7,  'Programa, ley o iniciativa.'),
  ('EVENT',       'Evento',          'Event',         '--c-anticipation', 8, 'Debate, mitin, comicio, escándalo.'),
  ('MEDIA',       'Medio',           'Media outlet',  '--c-surprise', 9,  'Medio de comunicación o canal.'),
  ('SLOGAN',      'Lema',            'Slogan',        '--c-pop',      10, 'Consigna o hashtag de campaña.'),
  ('MONEY',       'Monto',           'Money',         '--c-trust',    11, 'Cifra monetaria.'),
  ('PERCENT',     'Porcentaje',      'Percent',       '--c-trust',    12, 'Cifra porcentual, típica en encuestas.'),
  ('DATE',        'Fecha',           'Date',          '--c-neutral',  13, 'Referencia temporal.'),
  ('MISC',        'Otro',            'Miscellaneous', '--c-neutral',  99, 'Entidad no clasificada.')
ON CONFLICT (code) DO UPDATE SET label_es = EXCLUDED.label_es, color_token = EXCLUDED.color_token;

-- =============================================================================
-- 6. TEMAS / AGENDA PÚBLICA
--    Taxonomía de dos niveles, deliberadamente genérica y transnacional.
--    Cada organización puede añadir subtemas propios en civic.topics (02_core).
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_cat.topic_categories (
    id           SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code         civic.slug_code NOT NULL UNIQUE,
    label_es     TEXT    NOT NULL,
    label_en     TEXT    NOT NULL,
    -- Los temas de "proceso" hablan de la campaña; los de "sustancia", de políticas.
    dimension    TEXT    NOT NULL CHECK (dimension IN ('substance','process','image')),
    color_token  TEXT    NOT NULL DEFAULT '--c-brand-600',
    sort_order   SMALLINT NOT NULL DEFAULT 0,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    description  TEXT
);

COMMENT ON COLUMN civic_cat.topic_categories.dimension IS
    'substance = política pública; process = mecánica electoral; image = atributos del actor.';

INSERT INTO civic_cat.topic_categories (code, label_es, label_en, dimension, sort_order, description) VALUES
  ('security',        'Seguridad',              'Security',            'substance', 1,  'Delincuencia, violencia, policía, justicia penal.'),
  ('economy',         'Economía',               'Economy',             'substance', 2,  'Precios, crecimiento, impuestos, moneda.'),
  ('employment',      'Empleo',                 'Employment',          'substance', 3,  'Trabajo, salarios, informalidad.'),
  ('health',          'Salud',                  'Health',              'substance', 4,  'Sistema sanitario, medicamentos, cobertura.'),
  ('education',       'Educación',              'Education',           'substance', 5,  'Escuelas, docentes, becas, currículo.'),
  ('corruption',      'Corrupción',             'Corruption',          'substance', 6,  'Desvío de recursos, opacidad, impunidad.'),
  ('infrastructure',  'Infraestructura',        'Infrastructure',      'substance', 7,  'Obra pública, transporte, agua, vivienda.'),
  ('environment',     'Medio ambiente',         'Environment',         'substance', 8,  'Clima, contaminación, agua, conservación.'),
  ('social_programs', 'Programas sociales',     'Social programs',     'substance', 9,  'Transferencias, pensiones, apoyos.'),
  ('human_rights',    'Derechos humanos',       'Human rights',        'substance', 10, 'Libertades, discriminación, desapariciones.'),
  ('gender',          'Género',                 'Gender',              'substance', 11, 'Igualdad, violencia de género, paridad.'),
  ('migration',       'Migración',              'Migration',           'substance', 12, 'Flujos migratorios, frontera, refugio.'),
  ('energy',          'Energía',                'Energy',              'substance', 13, 'Electricidad, combustibles, transición.'),
  ('agriculture',     'Campo',                  'Agriculture',         'substance', 14, 'Producción agropecuaria, precios de garantía.'),
  ('technology',      'Tecnología',             'Technology',          'substance', 15, 'Conectividad, digitalización, datos.'),
  ('foreign_policy',  'Política exterior',      'Foreign policy',      'substance', 16, 'Relaciones internacionales, comercio exterior.'),
  ('fiscal',          'Finanzas públicas',      'Public finance',      'substance', 17, 'Presupuesto, deuda, gasto.'),
  -- Dimensión de proceso electoral
  ('electoral_process','Proceso electoral',     'Electoral process',   'process',   30, 'Autoridad electoral, reglas, cómputo, confianza en el voto.'),
  ('campaign_events', 'Actos de campaña',       'Campaign events',     'process',   31, 'Mítines, giras, debates, spots.'),
  ('polls',           'Encuestas',              'Polls',               'process',   32, 'Sondeos y su discusión pública.'),
  ('alliances',       'Alianzas',               'Alliances',           'process',   33, 'Coaliciones, rupturas, candidaturas.'),
  ('campaign_finance','Financiamiento',         'Campaign finance',    'process',   34, 'Recursos de campaña, topes, fiscalización.'),
  -- Dimensión de imagen
  ('integrity',       'Honestidad',             'Integrity',           'image',     50, 'Percepción de honradez del actor.'),
  ('competence',      'Capacidad',              'Competence',          'image',     51, 'Percepción de preparación y eficacia.'),
  ('empathy',         'Cercanía',               'Empathy',             'image',     52, 'Percepción de que entiende a la gente.'),
  ('leadership',      'Liderazgo',              'Leadership',          'image',     53, 'Percepción de firmeza y conducción.'),
  ('trajectory',      'Trayectoria',            'Track record',        'image',     54, 'Antecedentes y desempeño previo.'),
  ('personal_life',   'Vida personal',          'Personal life',       'image',     55, 'Familia, salud, patrimonio, escándalos personales.'),
  ('other',           'Otro',                   'Other',               'substance', 99, 'Sin categoría asignada.')
ON CONFLICT (code) DO UPDATE
   SET label_es = EXCLUDED.label_es, dimension = EXCLUDED.dimension;

-- =============================================================================
-- 7. TIPOS DE CONTENDIENTE
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_cat.contender_types (
    id          SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        civic.slug_code NOT NULL UNIQUE,
    label_es    TEXT    NOT NULL,
    label_en    TEXT    NOT NULL,
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    description TEXT
);

INSERT INTO civic_cat.contender_types (code, label_es, label_en, sort_order, description) VALUES
  ('candidate',   'Candidatura',    'Candidate',   1, 'Persona que compite por un cargo.'),
  ('party',       'Partido',        'Party',       2, 'Organización partidista registrada.'),
  ('coalition',   'Coalición',      'Coalition',   3, 'Alianza de dos o más partidos.'),
  ('movement',    'Movimiento',     'Movement',    4, 'Colectivo sin registro partidista.'),
  ('incumbent',   'Gobierno actual','Incumbent',   5, 'Administración en funciones evaluada como actor.'),
  ('institution', 'Institución',    'Institution', 6, 'Autoridad electoral u órgano relevante.'),
  ('spokesperson','Vocería',        'Spokesperson',7, 'Figura que habla por un contendiente.'),
  ('influencer',  'Figura pública', 'Public figure',8,'Actor con influencia sin candidatura.')
ON CONFLICT (code) DO UPDATE SET label_es = EXCLUDED.label_es;

-- =============================================================================
-- 8. TIPOS DE FUENTE Y DE CONTENIDO
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_cat.source_types (
    id             SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code           civic.slug_code NOT NULL UNIQUE,
    label_es       TEXT    NOT NULL,
    label_en       TEXT    NOT NULL,
    family         TEXT    NOT NULL CHECK (family IN ('social','news','messaging','survey','crm','custom')),
    -- Si el contenido es público, el tratamiento de datos personales cambia.
    is_public_data BOOLEAN NOT NULL DEFAULT TRUE,
    -- Requiere consentimiento explícito del titular para su análisis.
    requires_consent BOOLEAN NOT NULL DEFAULT FALSE,
    icon           TEXT,
    color_token    TEXT    NOT NULL DEFAULT '--c-neutral',
    sort_order     SMALLINT NOT NULL DEFAULT 0,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    description    TEXT
);

COMMENT ON COLUMN civic_cat.source_types.requires_consent IS
    'TRUE en canales privados (mensajería, CRM). La ingesta debe verificar base legal antes de persistir.';

INSERT INTO civic_cat.source_types (code, label_es, label_en, family, is_public_data, requires_consent, icon, color_token, sort_order) VALUES
  ('x_twitter',   'X / Twitter',        'X / Twitter',       'social',    TRUE,  FALSE, 'Twitter',       '--c-accent',   1),
  ('facebook',    'Facebook',           'Facebook',          'social',    TRUE,  FALSE, 'Facebook',      '--c-info',     2),
  ('instagram',   'Instagram',          'Instagram',         'social',    TRUE,  FALSE, 'Instagram',     '--c-mixed',    3),
  ('tiktok',      'TikTok',             'TikTok',            'social',    TRUE,  FALSE, 'Music',         '--c-surprise', 4),
  ('youtube',     'YouTube',            'YouTube',           'social',    TRUE,  FALSE, 'Youtube',       '--c-negative', 5),
  ('reddit',      'Reddit / foros',     'Reddit / forums',   'social',    TRUE,  FALSE, 'MessageSquare', '--c-anticipation', 6),
  ('threads',     'Threads',            'Threads',           'social',    TRUE,  FALSE, 'AtSign',        '--c-neutral',  7),
  ('news_web',    'Medios digitales',   'Online news',       'news',      TRUE,  FALSE, 'Newspaper',     '--c-info',     10),
  ('news_comment','Comentarios de nota','News comments',     'news',      TRUE,  FALSE, 'MessagesSquare','--c-info',     11),
  ('blog',        'Blogs',              'Blogs',             'news',      TRUE,  FALSE, 'PenLine',       '--c-neutral',  12),
  ('radio_tv',    'Radio y TV',         'Radio & TV',        'news',      TRUE,  FALSE, 'Radio',         '--c-brand-600',13),
  ('whatsapp',    'WhatsApp',           'WhatsApp',          'messaging', FALSE, TRUE,  'MessageCircle', '--c-positive', 20),
  ('telegram',    'Telegram',           'Telegram',          'messaging', FALSE, TRUE,  'Send',          '--c-accent',   21),
  ('sms',         'SMS',                'SMS',               'messaging', FALSE, TRUE,  'Smartphone',    '--c-neutral',  22),
  ('survey',      'Encuestas',          'Surveys',           'survey',    FALSE, TRUE,  'ClipboardList', '--c-trust',    30),
  ('field_report','Reporte de campo',   'Field report',      'survey',    FALSE, TRUE,  'MapPin',        '--c-positive', 31),
  ('call_center', 'Centro de contacto', 'Call center',       'crm',       FALSE, TRUE,  'Headphones',    '--c-mixed',    40),
  ('email',       'Correo',             'Email',             'crm',       FALSE, TRUE,  'Mail',          '--c-neutral',  41),
  ('crm',         'CRM',                'CRM',               'crm',       FALSE, TRUE,  'Database',      '--c-info',     42),
  ('manual',      'Carga manual',       'Manual upload',     'custom',    TRUE,  FALSE, 'Upload',        '--c-neutral',  90),
  ('api_custom',  'API propia',         'Custom API',        'custom',    TRUE,  FALSE, 'Plug',          '--c-neutral',  91)
ON CONFLICT (code) DO UPDATE
   SET label_es = EXCLUDED.label_es, family = EXCLUDED.family,
       requires_consent = EXCLUDED.requires_consent;

CREATE TABLE IF NOT EXISTS civic_cat.content_types (
    id          SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        civic.slug_code NOT NULL UNIQUE,
    label_es    TEXT    NOT NULL,
    label_en    TEXT    NOT NULL,
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO civic_cat.content_types (code, label_es, label_en, sort_order) VALUES
  ('post',        'Publicación',   'Post',        1),
  ('comment',     'Comentario',    'Comment',     2),
  ('reply',       'Respuesta',     'Reply',       3),
  ('quote',       'Cita',          'Quote',       4),
  ('repost',      'Reenvío',       'Repost',      5),
  ('review',      'Reseña',        'Review',      6),
  ('article',     'Nota',          'Article',     7),
  ('transcript',  'Transcripción', 'Transcript',  8),
  ('message',     'Mensaje',       'Message',     9),
  ('survey_open', 'Respuesta abierta','Open-ended response', 10),
  ('caption',     'Descripción',   'Caption',     11)
ON CONFLICT (code) DO UPDATE SET label_es = EXCLUDED.label_es;

-- =============================================================================
-- 9. NIVELES GEOGRÁFICOS
--    Genéricos por diseño: sirven para cualquier país sin renombrar nada.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_cat.geo_levels (
    id          SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        civic.slug_code NOT NULL UNIQUE,
    label_es    TEXT     NOT NULL,
    label_en    TEXT     NOT NULL,
    -- Profundidad jerárquica: 0 es el nivel más agregado.
    depth       SMALLINT NOT NULL,
    is_active   BOOLEAN  NOT NULL DEFAULT TRUE,
    description TEXT
);

INSERT INTO civic_cat.geo_levels (code, label_es, label_en, depth, description) VALUES
  ('country',      'País',              'Country',        0, 'Nivel nacional.'),
  ('region',       'Región',            'Region',         1, 'Agrupación supra-estatal o macrozona.'),
  ('state',        'Estado / provincia','State/Province', 2, 'Primera división administrativa.'),
  ('district',     'Distrito',          'District',       3, 'Circunscripción electoral.'),
  ('municipality', 'Municipio',         'Municipality',   4, 'Segunda división administrativa.'),
  ('city',         'Ciudad',            'City',           4, 'Localidad urbana.'),
  ('ward',         'Sección / barrio',  'Ward',           5, 'Unidad territorial fina.'),
  ('precinct',     'Casilla / centro',  'Precinct',       6, 'Punto de votación.'),
  ('custom',       'Personalizado',     'Custom',         9, 'Agrupación definida por la organización.')
ON CONFLICT (code) DO UPDATE SET label_es = EXCLUDED.label_es, depth = EXCLUDED.depth;

-- =============================================================================
-- 10. IDIOMAS
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_cat.languages (
    code        civic.lang_code PRIMARY KEY,
    label_es    TEXT    NOT NULL,
    label_en    TEXT    NOT NULL,
    native_name TEXT    NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO civic_cat.languages (code, label_es, label_en, native_name) VALUES
  ('es', 'Español',   'Spanish',    'Español'),
  ('en', 'Inglés',    'English',    'English'),
  ('pt', 'Portugués', 'Portuguese', 'Português'),
  ('fr', 'Francés',   'French',     'Français'),
  ('de', 'Alemán',    'German',     'Deutsch'),
  ('it', 'Italiano',  'Italian',    'Italiano'),
  ('ca', 'Catalán',   'Catalan',    'Català'),
  ('eu', 'Euskera',   'Basque',     'Euskara'),
  ('gl', 'Gallego',   'Galician',   'Galego'),
  ('qu', 'Quechua',   'Quechua',    'Runa Simi'),
  ('gn', 'Guaraní',   'Guarani',    'Avañeẽ'),
  ('nah','Náhuatl',   'Nahuatl',    'Nāhuatl'),
  ('und','Indeterminado','Undetermined','—')
ON CONFLICT (code) DO UPDATE SET label_es = EXCLUDED.label_es;

-- =============================================================================
-- 11. SEVERIDADES, ESTADOS Y TIPOS DE ALERTA
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_cat.severity_levels (
    id          SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        civic.slug_code NOT NULL UNIQUE,
    label_es    TEXT     NOT NULL,
    label_en    TEXT     NOT NULL,
    -- Escala ordinal: permite comparaciones (>=) sin CASE.
    rank        SMALLINT NOT NULL UNIQUE,
    color_token TEXT     NOT NULL,
    -- Minutos objetivo de atención. Alimenta el SLA del tablero.
    sla_minutes INTEGER,
    is_active   BOOLEAN  NOT NULL DEFAULT TRUE
);

INSERT INTO civic_cat.severity_levels (code, label_es, label_en, rank, color_token, sla_minutes) VALUES
  ('info',     'Informativa', 'Info',     1, '--c-info',     NULL),
  ('low',      'Baja',        'Low',      2, '--c-neutral',  1440),
  ('medium',   'Media',       'Medium',   3, '--c-warning',  240),
  ('high',     'Alta',        'High',     4, '--c-negative', 60),
  ('critical', 'Crítica',     'Critical', 5, '--c-danger',   15)
ON CONFLICT (code) DO UPDATE SET rank = EXCLUDED.rank, sla_minutes = EXCLUDED.sla_minutes;

CREATE TABLE IF NOT EXISTS civic_cat.alert_types (
    id           SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code         civic.slug_code NOT NULL UNIQUE,
    label_es     TEXT    NOT NULL,
    label_en     TEXT    NOT NULL,
    -- Métrica que evalúa el motor de reglas (alerts-api).
    default_metric TEXT,
    sort_order   SMALLINT NOT NULL DEFAULT 0,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    description  TEXT
);

INSERT INTO civic_cat.alert_types (code, label_es, label_en, default_metric, sort_order, description) VALUES
  ('negative_spike',   'Pico de negativos',     'Negative spike',    'negative_pct',      1, 'El porcentaje negativo supera el umbral.'),
  ('volume_spike',     'Pico de volumen',       'Volume spike',      'volume_zscore',     2, 'Volumen muy por encima de la media móvil.'),
  ('sentiment_drop',   'Caída de sentimiento',  'Sentiment drop',    'net_sentiment_delta',3,'El sentimiento neto cae respecto al periodo previo.'),
  ('toxicity',         'Toxicidad',             'Toxicity',          'toxicity_avg',      4, 'Nivel de agresión por encima del umbral.'),
  ('threat_detected',  'Amenaza detectada',     'Threat detected',   'threat_count',      5, 'Se detectaron mensajes con intención de amenaza.'),
  ('disinformation',   'Desinformación',        'Disinformation',    'disinfo_count',     6, 'Circula una afirmación marcada como falsa.'),
  ('coordinated',      'Actividad coordinada',  'Coordinated activity','coordination_score',7,'Patrón de publicación no orgánico.'),
  ('share_of_voice',   'Pérdida de conversación','Share of voice drop','sov_pct',         8, 'La participación en la conversación cae.'),
  ('topic_emergence',  'Tema emergente',        'Emerging topic',    'topic_growth',      9, 'Un tema crece aceleradamente.'),
  ('competitor_surge', 'Avance de contrincante','Competitor surge',  'competitor_net_delta',10,'Un contendiente mejora rápidamente.'),
  ('ingestion_failure','Falla de ingesta',      'Ingestion failure', 'source_lag_minutes',20,'Una fuente dejó de reportar.'),
  ('model_drift',      'Deriva del modelo',     'Model drift',       'confidence_avg',    21, 'La confianza promedio del clasificador cae.'),
  ('job_failed',       'Trabajo fallido',       'Job failed',        NULL,                22, 'Un trabajo de análisis terminó en error.')
ON CONFLICT (code) DO UPDATE
   SET label_es = EXCLUDED.label_es, default_metric = EXCLUDED.default_metric;

CREATE TABLE IF NOT EXISTS civic_cat.job_statuses (
    id          SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        civic.slug_code NOT NULL UNIQUE,
    label_es    TEXT    NOT NULL,
    label_en    TEXT    NOT NULL,
    is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
    color_token TEXT    NOT NULL DEFAULT '--c-neutral',
    sort_order  SMALLINT NOT NULL DEFAULT 0
);

INSERT INTO civic_cat.job_statuses (code, label_es, label_en, is_terminal, color_token, sort_order) VALUES
  ('queued',    'En cola',    'Queued',    FALSE, '--c-neutral',  1),
  ('running',   'Ejecutando', 'Running',   FALSE, '--c-info',     2),
  ('paused',    'Pausado',    'Paused',    FALSE, '--c-warning',  3),
  ('completed', 'Completado', 'Completed', TRUE,  '--c-positive', 4),
  ('partial',   'Parcial',    'Partial',   TRUE,  '--c-warning',  5),
  ('failed',    'Fallido',    'Failed',    TRUE,  '--c-negative', 6),
  ('cancelled', 'Cancelado',  'Cancelled', TRUE,  '--c-neutral',  7)
ON CONFLICT (code) DO UPDATE SET label_es = EXCLUDED.label_es, is_terminal = EXCLUDED.is_terminal;

-- =============================================================================
-- 12. BANDERAS DE MODERACIÓN Y RIESGO
--     Se detectan pero NO se usan para tomar acción sobre personas; su fin es
--     proteger al equipo y priorizar respuesta, no perfilar autores.
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_cat.risk_flags (
    id          SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        civic.slug_code NOT NULL UNIQUE,
    label_es    TEXT     NOT NULL,
    label_en    TEXT     NOT NULL,
    -- Severidad sugerida al dispararse.
    default_severity civic.slug_code NOT NULL REFERENCES civic_cat.severity_levels(code),
    requires_human_review BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    is_active   BOOLEAN  NOT NULL DEFAULT TRUE,
    description TEXT
);

INSERT INTO civic_cat.risk_flags (code, label_es, label_en, default_severity, requires_human_review, sort_order, description) VALUES
  ('insult',            'Insulto',                'Insult',              'low',      FALSE, 1, 'Descalificación personal sin amenaza.'),
  ('hate_speech',       'Discurso de odio',       'Hate speech',         'high',     TRUE,  2, 'Ataque por identidad protegida.'),
  ('threat_violence',   'Amenaza de violencia',   'Violent threat',      'critical', TRUE,  3, 'Amenaza explícita de daño físico. Escalamiento legal.'),
  ('doxxing',           'Exposición de datos',    'Doxxing',             'critical', TRUE,  4, 'Difusión de datos personales de terceros.'),
  ('sexual_harassment', 'Acoso sexual',           'Sexual harassment',   'high',     TRUE,  5, 'Contenido sexual no consentido dirigido a una persona.'),
  ('gender_violence',   'Violencia política de género','Gender-based political violence','high', TRUE, 6, 'Ataque dirigido a una candidata por su género.'),
  ('misinformation',    'Información falsa',      'Misinformation',      'medium',   TRUE,  7, 'Afirmación falsa sin intención acreditada.'),
  ('disinformation',    'Desinformación',         'Disinformation',      'high',     TRUE,  8, 'Falsedad difundida deliberadamente.'),
  ('manipulated_media', 'Medio manipulado',       'Manipulated media',   'high',     TRUE,  9, 'Imagen, audio o video alterado.'),
  ('coordinated_inauth','Comportamiento no auténtico','Coordinated inauthentic behavior','high', TRUE, 10, 'Red de cuentas actuando en bloque.'),
  ('electoral_crime',   'Posible delito electoral','Possible electoral offence','critical', TRUE, 11, 'Compra de voto, coacción u otra conducta denunciable.'),
  ('self_harm',         'Autolesión',             'Self-harm',           'critical', TRUE,  12, 'Señales de riesgo para el propio autor. Protocolo de cuidado, no de campaña.'),
  ('spam_bot',          'Spam automatizado',      'Automated spam',      'low',      FALSE, 13, 'Publicación automatizada irrelevante.')
ON CONFLICT (code) DO UPDATE
   SET label_es = EXCLUDED.label_es, default_severity = EXCLUDED.default_severity;

COMMENT ON TABLE civic_cat.risk_flags IS
    'Banderas de riesgo del contenido. Uso previsto: protección del equipo y priorización de respuesta. '
    'No deben emplearse para perfilar, segmentar ni tomar represalias contra autores individuales.';

-- =============================================================================
-- 13. TIPOS DE TAREA NLP
-- =============================================================================
CREATE TABLE IF NOT EXISTS civic_cat.nlp_tasks (
    id          SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        civic.slug_code NOT NULL UNIQUE,
    label_es    TEXT    NOT NULL,
    label_en    TEXT    NOT NULL,
    -- Tipo de salida: guía la validación del resultado del modelo.
    output_kind TEXT    NOT NULL CHECK (output_kind IN ('single_label','multi_label','span','scalar','text')),
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO civic_cat.nlp_tasks (code, label_es, label_en, output_kind, sort_order) VALUES
  ('sentiment',   'Sentimiento',        'Sentiment',       'single_label', 1),
  ('stance',      'Postura',            'Stance',          'single_label', 2),
  ('emotions',    'Emociones',          'Emotions',        'multi_label',  3),
  ('intent',      'Intención',          'Intent',          'single_label', 4),
  ('topics',      'Temas',              'Topics',          'multi_label',  5),
  ('ner',         'Entidades',          'Named entities',  'span',         6),
  ('keywords',    'Palabras clave',     'Keywords',        'multi_label',  7),
  ('toxicity',    'Toxicidad',          'Toxicity',        'scalar',       8),
  ('risk_flags',  'Banderas de riesgo', 'Risk flags',      'multi_label',  9),
  ('sarcasm',     'Ironía',             'Sarcasm',         'scalar',       10),
  ('language',    'Idioma',             'Language',        'single_label', 11),
  ('summary',     'Resumen',            'Summary',         'text',         12),
  ('geo_infer',   'Inferencia geográfica','Geo inference', 'single_label', 13)
ON CONFLICT (code) DO UPDATE SET label_es = EXCLUDED.label_es, output_kind = EXCLUDED.output_kind;

-- =============================================================================
-- 14. PERMISOS DE LECTURA SOBRE CATÁLOGOS
-- =============================================================================
GRANT SELECT ON ALL TABLES IN SCHEMA civic_cat
    TO civicpulse_app, civicpulse_reader, civicpulse_ingest;

ALTER DEFAULT PRIVILEGES IN SCHEMA civic_cat
    GRANT SELECT ON TABLES TO civicpulse_app, civicpulse_reader, civicpulse_ingest;

-- =============================================================================
-- VERIFICACIÓN
-- =============================================================================
DO $$
DECLARE
    v_tables INTEGER;
    v_rows   INTEGER;
BEGIN
    SELECT count(*) INTO v_tables
    FROM information_schema.tables WHERE table_schema = 'civic_cat';

    SELECT (SELECT count(*) FROM civic_cat.sentiment_types)
         + (SELECT count(*) FROM civic_cat.emotion_types)
         + (SELECT count(*) FROM civic_cat.intent_types)
         + (SELECT count(*) FROM civic_cat.stance_types)
         + (SELECT count(*) FROM civic_cat.entity_types)
         + (SELECT count(*) FROM civic_cat.topic_categories)
         + (SELECT count(*) FROM civic_cat.source_types)
         + (SELECT count(*) FROM civic_cat.risk_flags)
    INTO v_rows;

    RAISE NOTICE '── Catálogos cargados: % tablas, % registros en los principales ──', v_tables, v_rows;
END
$$;
