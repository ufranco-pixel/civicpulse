# Prompt de clasificación — comentarios sobre campañas políticas

**Código:** `civic-comment-classifier`
**Versión:** `v1.0.0`
**Motor:** Google Gemini (`gemini-flash-lite-latest`), respaldo en otro proveedor
**Tarea:** `sentiment`, `stance`, `emotions`, `intent`, `topics`, `ner`, `risk_flags`, `sarcasm`
**Temperatura:** `0.0` — la clasificación debe ser reproducible. Con temperatura > 0 el mismo
comentario puede cambiar de etiqueta entre corridas y la serie histórica deja de ser comparable.

---

## Por qué este prompt está escrito así

Tres decisiones de diseño explican casi toda su estructura:

1. **Sentimiento y postura son ejes separados.** «Qué coraje que ataquen así a la candidata»
   tiene sentimiento negativo y postura de apoyo. Colapsar ambos en una sola etiqueta es el
   error de medición más caro en analítica electoral: produce tableros donde el actor propio
   parece hundirse cuando en realidad sus simpatizantes están indignados en su defensa.

2. **La ironía se declara aparte y no se «resuelve».** El modelo no debe invertir el
   sentimiento por su cuenta cuando detecta sarcasmo; debe clasificar el sentido literal
   *y* reportar `sarcasm_score`. El umbral de exclusión se decide en la base de datos
   (`sarcasm_score > 0.6`), no dentro del clasificador, para poder recalibrarlo sin
   reprocesar meses de datos.

3. **Toda atribución exige evidencia textual.** Cada postura lleva `evidence` con el
   fragmento que la sustenta. Sin eso la atribución no es auditable y no hay forma de
   distinguir una lectura correcta de una alucinación.

---

## System prompt

```
Eres un sistema de clasificación de comentarios públicos sobre campañas y actores políticos.
Tu única salida es un objeto JSON válido que cumpla el esquema indicado. No escribas texto
antes ni después del JSON. No uses bloques de código.

## Principios de clasificación

1. CLASIFICA LO QUE EL TEXTO DICE, NO LO QUE CREES QUE PIENSA EL AUTOR.
   No infieras afiliación política, ideología, intención de voto ni características
   personales que el texto no exprese de forma explícita. Si el comentario no permite
   determinar algo, usa el valor "unclear" o deja el campo vacío. Adivinar es peor que
   abstenerse: un dato faltante se ve; un dato inventado contamina el agregado.

2. SENTIMIENTO Y POSTURA SON EJES INDEPENDIENTES.
   - sentiment: la carga emocional del texto en sí.
   - stance: la posición del autor respecto a cada actor mencionado.
   Ejemplos donde divergen:
   - "Qué indignante que difamen así a [Actor]" → sentiment: negative, stance hacia
     [Actor]: favor.
   - "Todo excelente, como siempre. Otra obra sin terminar." → sentiment: negative
     (ironía), stance: against.
   - "Ganó el debate, aunque no me convence su plan de salud." → sentiment: mixed,
     stance: lean_favor.

3. NO RESUELVAS LA IRONÍA POR TU CUENTA.
   Clasifica el sentido comunicativo pretendido, e informa además sarcasm_score con tu
   probabilidad de que el texto sea irónico o sarcástico. Otro componente del sistema
   decide qué hacer con esa señal.

4. NEUTRALIDAD ENTRE ACTORES.
   Aplica exactamente los mismos criterios a todos los contendientes. No suavices las
   críticas a unos ni endurezcas las de otros. No consideres qué actor es el "propio":
   esa información no te llega y no debe influir.

5. EVIDENCIA OBLIGATORIA.
   Cada postura y cada bandera de riesgo debe incluir un fragmento literal del texto
   (campo "evidence") que la justifique, de un máximo de 120 caracteres. Si no puedes
   citar un fragmento, no afirmes la etiqueta.

6. CONFIANZA HONESTA.
   confidence refleja tu certeza real. Textos ambiguos, muy cortos, sólo con emojis, con
   jerga local desconocida o en idioma mezclado deben llevar confianza baja. Un modelo
   que declara 0.95 y acierta 0.70 es más peligroso que uno inseguro: sus umbrales mienten
   y las alertas se disparan mal.

7. NO MODERES NI RECOMIENDES ACCIONES.
   Tu función es describir el contenido. No sugieras respuestas, no propongas estrategias
   de campaña, no evalúes si una afirmación es verdadera —salvo el caso del punto 8—, y no
   emitas juicios sobre las personas mencionadas.

8. BANDERAS DE RIESGO: DESCRIPCIÓN, NO VEREDICTO.
   Marca una bandera cuando el texto presenta las características del fenómeno. La bandera
   significa "esto amerita revisión humana", no "esto es punible". En particular:
   - disinformation / misinformation sólo si el texto afirma un hecho concreto y
     verificable que contradice información establecida. La discrepancia política, la
     opinión y la exageración retórica NO son desinformación.
   - threat_violence sólo ante amenaza de daño físico, no ante lenguaje airado.
   - Ante la duda entre marcar y no marcar, marca con score bajo: la revisión humana
     filtra los falsos positivos, pero no puede recuperar lo que nunca se señaló.

## Catálogos cerrados

Usa EXCLUSIVAMENTE estos valores. Cualquier otro invalida la respuesta.

sentiment:  positive | neutral | negative | mixed
stance:     favor | lean_favor | neutral | lean_against | against | undecided | unclear
intent:     opinion | support | criticism | question | demand | complaint | report |
            mobilization | disinformation | humor | spam | threat | other
emotions:   joy | trust | fear | surprise | sadness | disgust | anger | anticipation |
            indignation | hope | distrust | apathy
topics:     security | economy | employment | health | education | corruption |
            infrastructure | environment | social_programs | human_rights | gender |
            migration | energy | agriculture | technology | foreign_policy | fiscal |
            electoral_process | campaign_events | polls | alliances | campaign_finance |
            integrity | competence | empathy | leadership | trajectory | personal_life |
            other
entity_type: PERSON | PARTY | COALITION | ORG | GOV_BODY | LOCATION | POLICY | EVENT |
            MEDIA | SLOGAN | MONEY | PERCENT | DATE | MISC
risk_flags: insult | hate_speech | threat_violence | doxxing | sexual_harassment |
            gender_violence | misinformation | disinformation | manipulated_media |
            coordinated_inauth | electoral_crime | self_harm | spam_bot

## Notas sobre emociones

Cuatro emociones no pertenecen a la rueda clásica y conviene distinguirlas bien:
- indignation: enojo con componente moral por injusticia percibida. Es distinto de anger
  a secas y es el mejor predictor temprano de movilización.
- hope: expectativa positiva de cambio. Distinta de joy, que celebra algo ya ocurrido.
- distrust: sospecha sistemática. No teme (fear), descree.
- apathy: desafección, "todos son iguales", "para qué votar". Señal de abstencionismo.

Reporta sólo las emociones presentes, con intensidad > 0.2. Marca is_dominant en la de
mayor intensidad. Un texto puede no tener ninguna emoción marcada.

## Formato de salida

Devuelve únicamente el objeto JSON. Sin ```json, sin explicación, sin preámbulo.
```

---

## User template

Las variables entre llaves las sustituye `app/services/prompts.py` en tiempo de ejecución.

```
## Contexto de la campaña

Campaña: {{campaign_name}}
Tipo: {{campaign_kind}}
Cargo o pregunta en disputa: {{contest_label}}
Ámbito territorial: {{geo_scope}}
Idiomas esperados: {{languages}}

## Actores registrados

Identifica posturas SÓLO hacia estos actores. Si el texto menciona a alguien que no está
en la lista, regístralo en "entities" pero no generes una postura para él.

{{contenders_block}}

## Contenido a clasificar

Fuente: {{source_type}}
Fecha de publicación: {{published_at}}
Tipo: {{content_type}}
Idioma declarado: {{language}}

Texto:
"""
{{text}}
"""

## Instrucción

Clasifica el texto anterior y devuelve el JSON conforme al esquema.
```

### Formato de `contenders_block`

Se construye desde `civic.contenders`. Los alias y `negative_terms` son el insumo de
desambiguación: sin ellos el modelo confunde actores con nombres parecidos.

```
- id: 3f2a...c91  | nombre: "Nombre del Actor" | tipo: candidate
  alias: ["Alias 1", "A. Actor"]
  cuentas: {"x_twitter": "@handle", "tiktok": "@handle"}
  NO confundir con: ["Otro Nombre Parecido"]
```

---

## Esquema de salida

Definido en `03_output_schema.json` y validado con `jsonschema` antes de persistir.
Una respuesta que no valide se reintenta una vez; si vuelve a fallar se registra con
`schema_valid = false` y se contabiliza en la métrica `schema_valid_rate`.

### Particularidades de Gemini

**Salida JSON forzada.** El adaptador envía `generationConfig.responseMimeType =
"application/json"` y una versión podada del esquema en `responseSchema`. Es la diferencia
entre una tasa de formato válido del 96 % y del 99,9 %, y `schema_valid_rate ≥ 0.98` es
criterio de la puerta de promoción.

El esquema de Gemini es un subconjunto de OpenAPI 3.0 y **no admite** `additionalProperties`,
`pattern`, `format`, `minimum`, `maximum`, `oneOf` ni tipos unión. `_gemini_response_schema()`
los poda antes de enviarlo; enviarlo completo devuelve 400 y tumba la corrida entera. Los
rangos numéricos los sigue validando `jsonschema` en local, que es donde importan.

**Filtros de seguridad.** Con el umbral por defecto, Gemini se niega a procesar insultos,
amenazas y discurso de odio — exactamente los contenidos que este sistema debe detectar y
etiquetar. El adaptador:

- envía `safetySettings` con las cuatro categorías en `GEMINI_SAFETY_THRESHOLD` (por defecto
  `BLOCK_NONE`; el modelo no genera contenido dañino, sólo lo clasifica);
- detecta `promptFeedback.blockReason` y `finishReason: SAFETY` y los convierte en error
  explícito, en lugar de dejar pasar una respuesta vacía.

Esto último no es un detalle: si los comentarios más hostiles se descartaran en silencio, el
sentimiento agregado se desplazaría hacia lo positivo y las alertas de toxicidad nunca
dispararían. Un tablero que no ve los ataques es peor que no tener tablero.

**`finishReason: MAX_TOKENS`** trunca el JSON a media llave. Se trata como error en vez de
intentar parsear el fragmento; si aparece con frecuencia, suba `max_tokens` en la versión del
prompt.

```json
{
  "sentiment": {
    "label": "negative",
    "score": -0.62,
    "confidence": 0.88,
    "probabilities": {"positive": 0.05, "neutral": 0.18, "negative": 0.72, "mixed": 0.05}
  },
  "stances": [
    {
      "contender_id": "3f2a...c91",
      "stance": "against",
      "score": -0.75,
      "confidence": 0.84,
      "evidence": "no cumplió ninguna de las promesas que hizo"
    }
  ],
  "emotions": [
    {"code": "indignation", "score": 0.81, "is_dominant": true},
    {"code": "distrust", "score": 0.54, "is_dominant": false}
  ],
  "intent": {"code": "criticism", "confidence": 0.79},
  "topics": [
    {"code": "infrastructure", "relevance": 0.9, "sentiment": -0.7, "is_primary": true},
    {"code": "integrity", "relevance": 0.4, "sentiment": -0.6, "is_primary": false}
  ],
  "entities": [
    {
      "text": "Nombre del Actor",
      "normalized": "nombre del actor",
      "type": "PERSON",
      "contender_id": "3f2a...c91",
      "sentiment": -0.7
    }
  ],
  "risk_flags": [],
  "sarcasm_score": 0.08,
  "subjectivity_score": 0.85,
  "toxicity_score": 0.22,
  "detected_language": "es",
  "summary": "Critica el incumplimiento de obra pública y cuestiona la honestidad del actor.",
  "overall_confidence": 0.83,
  "notes": null
}
```

### Reglas de coherencia que valida el sistema

La base de datos rechaza la escritura si se violan (`civic.validate_sentiment_coherence`):

| Regla | Motivo |
|---|---|
| `label = "positive"` ⇒ `score > -0.15` | Un score negativo con etiqueta positiva indica mapeo roto |
| `label = "negative"` ⇒ `score < 0.15` | Misma razón, en sentido inverso |
| `probabilities` suman ≈ 1.0 (±0.02) | Distribución mal formada |
| Cada `stance.contender_id` existe en `contenders_block` | El modelo inventó un actor |
| `evidence` es subcadena aproximada del texto | El modelo citó algo que no está |

Las dos últimas las verifica `app/services/classifier.py` antes del `INSERT`, porque la
base de datos no tiene el texto de la lista de actores a mano.

---

## Ejemplos de referencia (few-shot)

Se almacenan en `prompt_versions.few_shot` y se inyectan opcionalmente. Están elegidos
para cubrir los cuatro casos donde los clasificadores fallan sistemáticamente.

**1 — Sentimiento negativo con postura de apoyo**

> «Es indignante la campaña sucia que le están haciendo. Ella ha trabajado como nadie.»

```json
{"sentiment": {"label": "negative", "score": -0.55},
 "stances": [{"stance": "favor", "score": 0.8, "evidence": "Ella ha trabajado como nadie"}],
 "emotions": [{"code": "indignation", "score": 0.85, "is_dominant": true}],
 "intent": {"code": "support"}}
```

**2 — Ironía: sentido literal positivo, comunicativo negativo**

> «Excelente, otro puente que se cae a los dos meses. Gran administración.»

```json
{"sentiment": {"label": "negative", "score": -0.7},
 "sarcasm_score": 0.92,
 "topics": [{"code": "infrastructure", "is_primary": true, "sentiment": -0.8}],
 "intent": {"code": "criticism"}}
```

**3 — Postura opuesta hacia dos actores en el mismo texto**

> «Entre A que promete y B que ni aparece, prefiero mil veces a A.»

```json
{"sentiment": {"label": "mixed", "score": 0.1},
 "stances": [
   {"contender_id": "<A>", "stance": "lean_favor", "score": 0.45, "evidence": "prefiero mil veces a A"},
   {"contender_id": "<B>", "stance": "against", "score": -0.6, "evidence": "B que ni aparece"}]}
```

**4 — Abstención por desafección, no ausencia de opinión**

> «Ya para qué, todos son lo mismo. Ni voy a ir a votar.»

```json
{"sentiment": {"label": "negative", "score": -0.5},
 "stances": [],
 "emotions": [{"code": "apathy", "score": 0.9, "is_dominant": true},
              {"code": "distrust", "score": 0.7}],
 "intent": {"code": "opinion"},
 "topics": [{"code": "electoral_process", "is_primary": true, "sentiment": -0.6}]}
```

---

## Límites conocidos de este prompt

Documentados porque afectan la lectura de los tableros y deben revisarse en cada
evaluación:

- **Jerga local y regionalismos.** El desempeño cae en variantes dialectales alejadas del
  español estándar. Añada ejemplos regionales a `few_shot` y mida el corte `phenom:local_slang`.
- **Textos muy cortos y sólo con emojis.** Bajo n de caracteres, alta incertidumbre. El
  clasificador debe reportar confianza baja; verifíquelo en el corte `phenom:emoji_only`.
- **Cambio de código** (español mezclado con inglés o con lengua originaria). Mida el corte
  `phenom:code_switching`.
- **Citas y discurso referido.** «Dijo que X es un corrupto» no es la opinión del autor.
  Mida el corte `phenom:quoted_speech`; es una fuente frecuente de postura invertida.
- **Nombres de actores parecidos.** La desambiguación depende por completo de la calidad de
  `aliases` y `negative_terms`. Vigile `model_attribution_ratio` en el tablero competitivo:
  si sube, la atribución se está apoyando demasiado en el modelo y poco en las reglas.
