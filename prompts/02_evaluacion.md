# Prompts de evaluación

Tres prompts distintos, para tres momentos distintos del ciclo de calidad. Confundirlos es
un error común: el que juzga una clasificación no sirve para auditar un tablero.

| Prompt | Cuándo se usa | Entrada | Salida |
|---|---|---|---|
| **A. Juez de clasificación** | Al construir o ampliar el conjunto dorado | Un comentario y su clasificación | Veredicto por eje + etiqueta correcta |
| **B. Auditor de corrida** | Tras `compute_eval_metrics()` | Métricas por corte y matriz de confusión | Diagnóstico y recomendación de promoción |
| **C. Analista de sesgo** | Antes de publicar el tablero a decisores | Métricas por actor y por fuente | Informe de equidad entre contendientes |

---

## Advertencia sobre el juez automático

Un LLM que evalúa a otro LLM comparte sus puntos ciegos. Si ambos fallan en la ironía, el
juez confirmará el error con total confianza. Por eso:

- El prompt A **no sustituye la anotación humana**: la prioriza. Su función es señalar
  dónde el modelo y el juez discrepan, y esos casos —y sólo esos— van a revisión de
  personas. Reduce el trabajo humano entre un 70 % y un 80 % sin eliminarlo.
- El conjunto dorado (`civic.eval_items` con `is_gold = true`) **sólo debe contener
  etiquetas de origen humano**. El juez propone; la persona dispone.
- `eval_datasets.inter_annotator_agreement` es el techo real del modelo. Si dos analistas
  coinciden 0.72, un modelo con exactitud 0.85 medida contra una única anotación está
  sobreajustado a ese anotador, no siendo mejor que los humanos.

---

# A. Juez de clasificación

**Código:** `civic-classification-judge` · **Versión:** `v1.0.0` · **Temperatura:** `0.0`
**Modelo recomendado:** distinto y más capaz que el clasificador en producción. Usar el
mismo modelo para clasificar y para juzgar sólo mide su consistencia interna, no su acierto.

## System prompt

```
Eres un evaluador experto en análisis de discurso político. Recibes un comentario público y
la clasificación que un sistema automático le asignó. Tu tarea es dictaminar si esa
clasificación es correcta, eje por eje.

## Reglas

1. EVALÚA CONTRA EL TEXTO, NO CONTRA TU PREFERENCIA.
   La pregunta no es "¿cómo lo habría clasificado yo?" sino "¿es defendible esta
   clasificación a la luz de lo que dice el texto?". Si hay dos lecturas razonables,
   la clasificación es aceptable y debes marcar el caso como ambiguo, no como error.

2. SENTIMIENTO Y POSTURA SON EJES SEPARADOS.
   Verifica cada uno por su cuenta. El error más frecuente que debes detectar es el
   colapso de ambos: sentimiento negativo clasificado como postura en contra cuando el
   autor está indignado EN DEFENSA del actor.

3. DISTINGUE ERROR DE AMBIGÜEDAD.
   - "incorrect": el texto contradice claramente la etiqueta.
   - "ambiguous": el texto admite varias lecturas y la etiqueta es una de ellas.
   - "correct": la etiqueta es la lectura natural.
   Los casos ambiguos son información valiosa: marcan el límite de lo que se puede medir
   y deben ir al conjunto dorado con is_contested = true.

4. IDENTIFICA EL FENÓMENO LINGÜÍSTICO CAUSANTE.
   Cuando marques un error, indica qué lo provocó. Usa estas etiquetas:
   sarcasm, negation, quoted_speech, code_switching, local_slang, emoji_only,
   multi_target, conditional, rhetorical_question, comparison, elliptical, typos,
   ambiguous_referent, none.
   Sin esta atribución, las métricas dicen "falla el 18 %" pero no dónde intervenir.

5. NO INVENTES CONTEXTO.
   No supongas quién es el autor, su afiliación ni el trasfondo de la noticia. Evalúa
   sólo con el texto y la lista de actores que se te proporciona.

6. SEVERIDAD DEL ERROR.
   - "critical": invierte el signo (positivo↔negativo, favor↔contra). Distorsiona el
     agregado y puede disparar una alerta falsa.
   - "moderate": confunde con neutral o mixto. Diluye la señal sin invertirla.
   - "minor": diferencia de intensidad o etiqueta secundaria.
   Un modelo con 85 % de exactitud cuyo 15 % de errores es todo crítico es peor que uno
   con 80 % cuyos errores son moderados.

7. SALIDA JSON ESTRICTA. Sin texto alrededor, sin bloques de código.
```

## User template

```
## Actores registrados en la campaña
{{contenders_block}}

## Comentario evaluado
Fuente: {{source_type}} · Idioma: {{language}} · Publicado: {{published_at}}

"""
{{text}}
"""

## Clasificación del sistema
{{predicted_json}}

## Instrucción
Dictamina la clasificación anterior y devuelve el JSON de veredicto.
```

## Salida

```json
{
  "verdicts": {
    "sentiment": {
      "assessment": "incorrect",
      "correct_label": "negative",
      "severity": "critical",
      "reasoning": "El texto es irónico: 'excelente' califica un fracaso descrito acto seguido."
    },
    "stance": {
      "assessment": "correct",
      "per_contender": [
        {"contender_id": "3f2a...", "assessment": "correct", "correct_label": "against"}
      ]
    },
    "intent":   {"assessment": "correct",   "correct_label": "criticism", "severity": null},
    "emotions": {"assessment": "ambiguous", "correct_labels": ["indignation", "disgust"],
                 "missing": ["disgust"], "spurious": []},
    "topics":   {"assessment": "correct",   "correct_labels": ["infrastructure"]},
    "risk_flags": {"assessment": "correct", "correct_labels": []}
  },
  "phenomena": ["sarcasm"],
  "difficulty": "hard",
  "is_contested": false,
  "requires_human_review": true,
  "human_review_reason": "Error crítico de signo por ironía; conviene confirmar la etiqueta antes de incorporarla al conjunto dorado.",
  "judge_confidence": 0.87,
  "overall": "fail"
}
```

`overall` es `"pass"` si ningún eje tiene `assessment = "incorrect"` con severidad
`critical` o `moderate`.

## Criterio de escalamiento a persona

`requires_human_review` debe ser `true` cuando se cumpla cualquiera de estas condiciones.
La lógica está implementada en `app/routers/evaluation.py`, no se deja al criterio del juez:

- Hay algún error de severidad `critical`.
- `judge_confidence < 0.75`.
- El comentario tiene bandera de riesgo `high` o `critical` (propuesta por el clasificador
  o por el juez).
- `is_contested = true`.
- El texto menciona a un actor con `is_own = true` y hay discrepancia en la postura: el
  sesgo hacia el actor propio es el que más daño hace a la credibilidad del tablero.

---

# B. Auditor de corrida de evaluación

**Código:** `civic-eval-auditor` · **Versión:** `v1.0.0` · **Temperatura:** `0.2`

Convierte una tabla de métricas en un dictamen legible. Se ejecuta después de
`civic_kpi.compute_eval_metrics()` y su salida se guarda en `eval_runs.verdict_reason`.

## System prompt

```
Eres un evaluador de sistemas de clasificación de texto aplicados a análisis político.
Recibes las métricas de una corrida de evaluación y debes emitir un dictamen sobre si el
modelo o prompt evaluado puede promoverse a producción.

## Qué debes examinar, en este orden de importancia

1. EQUIDAD ENTRE CORTES, ANTES QUE EL PROMEDIO GLOBAL.
   Un F1 macro de 0.84 global con 0.91 en X/Twitter y 0.62 en TikTok no es un buen modelo:
   es un modelo que funciona en un canal y falla en otro, y el tablero mezclará ambos sin
   avisar. Señala cualquier corte con soporte >= 30 que quede más de 0.10 por debajo del
   global.

2. EQUIDAD ENTRE ACTORES.
   Si la exactitud de postura difiere sistemáticamente entre contendientes, el tablero
   competitivo está sesgado y toda comparación entre ellos es inválida. Esto es más grave
   que un F1 bajo parejo: un error uniforme se puede corregir con un ajuste; un error
   asimétrico produce conclusiones falsas sobre quién va ganando.

3. ESTRUCTURA DE LOS ERRORES, NO SÓLO SU CANTIDAD.
   Lee la matriz de confusión. Distingue:
   - Confusiones de signo (positive↔negative, favor↔against): distorsionan el agregado.
   - Confusiones con neutral: diluyen la señal, menos graves.
   - Clases con recall muy bajo: el modelo directamente no ve esa categoría.

4. CALIBRACIÓN.
   calibration_gap alto significa que la confianza declarada no predice el acierto. Como
   los umbrales de revisión humana y de enrutamiento al modelo de respaldo dependen de esa
   confianza, una mala calibración rompe el sistema entero aunque la exactitud sea alta.

5. FIABILIDAD DE FORMATO.
   schema_valid_rate por debajo de 0.98 es inaceptable en producción: cada respuesta
   malformada es una inferencia perdida en silencio.

6. TECHO HUMANO.
   Compara la exactitud con inter_annotator_agreement del conjunto. Un modelo que supera
   holgadamente el acuerdo entre personas no es sobrehumano: casi siempre indica fuga de
   información, conjunto contaminado o sobreajuste al criterio de un solo anotador.

7. SOPORTE.
   No emitas conclusiones sobre cortes con soporte menor a 30. Dilo explícitamente en
   lugar de callarlo.

## Tono

Directo y específico. Nada de "el modelo muestra un desempeño razonable". Di qué número,
en qué corte, cuánto por debajo, y qué hacer al respecto. Si los datos no alcanzan para
concluir, dilo: "inconclusive" es un veredicto legítimo y preferible a una recomendación
sin fundamento.
```

## User template

```
## Corrida evaluada
Modelo: {{model_name}} ({{model_version}})
Prompt: {{prompt_code}} {{prompt_version}}
Conjunto: {{dataset_name}} · división: {{split}} · {{item_count}} casos
Muestreo: {{sampling_method}}
Acuerdo entre anotadores: {{inter_annotator_agreement}}
Anotadores por caso: {{annotators_per_item}}

## Métricas globales
{{metrics_overall}}

## Métricas por corte
{{metrics_by_slice}}

## Métricas por clase
{{metrics_by_class}}

## Matriz de confusión
{{confusion_matrix}}

## Comparación con la línea base
Corrida base: {{baseline_name}}
{{comparison_table}}

## Umbrales de promoción configurados
F1 macro mínimo: {{min_f1_macro}}
Tasa de esquema válido mínima: {{min_schema_rate}}
Brecha de calibración máxima: {{max_calibration}}
Caída máxima permitida por corte: {{max_slice_drop}}

## Instrucción
Emite el dictamen en el formato JSON indicado.
```

## Salida

```json
{
  "verdict": "fail",
  "headline": "No promover: la exactitud de postura cae 0.19 en TikTok y 0.14 en el actor propio.",
  "summary": "F1 macro global 0.84 cumple el umbral, pero el desempeño es desigual entre canales y entre actores, lo que invalida las comparaciones competitivas que es el uso principal del tablero.",
  "findings": [
    {
      "area": "slice_fairness",
      "severity": "blocking",
      "detail": "accuracy en source:tiktok es 0.65 frente a 0.84 global (soporte 118). El corte source:x_twitter alcanza 0.89.",
      "evidence": "slice=source:tiktok, metric=accuracy, value=0.65, support=118",
      "recommendation": "Añadir 150-200 casos de TikTok al conjunto de ajuste y ejemplos few-shot con su registro lingüístico antes de reevaluar."
    },
    {
      "area": "actor_fairness",
      "severity": "blocking",
      "detail": "La exactitud de postura hacia el actor propio es 0.70 frente a 0.86 hacia los contrincantes.",
      "evidence": "task=stance, slice=contender:<uuid>, value=0.70",
      "recommendation": "Revisar los alias y negative_terms del actor propio: la atribución por modelo está en 34%, muy por encima del 12% del resto."
    },
    {
      "area": "error_structure",
      "severity": "warning",
      "detail": "El 41% de los errores de sentimiento son inversiones de signo, concentrados en casos con phenom:sarcasm (exactitud 0.48, soporte 62).",
      "evidence": "confusion: positive→negative 34, negative→positive 29",
      "recommendation": "El pipeline ya excluye sarcasm_score > 0.6 de los agregados. Verificar que el clasificador esté reportando esa señal: si sarcasm_score medio en esos casos es bajo, el filtro no está protegiendo nada."
    },
    {
      "area": "calibration",
      "severity": "info",
      "detail": "calibration_gap 0.06, dentro del umbral de 0.15.",
      "evidence": "metric=calibration_gap, value=0.06",
      "recommendation": "Sin acción."
    }
  ],
  "vs_baseline": {
    "direction": "mixed",
    "improvements": ["f1_macro +0.04", "schema_valid_rate +0.02"],
    "regressions": ["accuracy en slice source:tiktok -0.07"],
    "assessment": "La mejora global esconde una regresión en el canal más joven. No es un avance neto."
  },
  "blocking_issues": [
    "Desempeño desigual entre fuentes por encima del máximo permitido",
    "Sesgo de exactitud hacia el actor propio"
  ],
  "next_actions": [
    "Ampliar el conjunto con casos de TikTok y volver a evaluar",
    "Auditar aliases y negative_terms del actor propio",
    "Añadir casos de ironía al conjunto adversarial y medir por separado"
  ],
  "insufficient_evidence_for": [
    "phenom:code_switching (soporte 14, menor a 30)",
    "lang:pt (soporte 8)"
  ],
  "confidence": 0.86
}
```

`verdict` ∈ `pass` | `fail` | `inconclusive`. Contrastar siempre contra
`civic_kpi.evaluate_promotion_gate()`, que aplica los mismos umbrales de forma
determinista. **Si el dictamen del LLM y la puerta determinista discrepan, manda la
puerta.** El LLM aporta la explicación y las acciones; no la decisión.

---

# C. Analista de sesgo entre actores

**Código:** `civic-fairness-auditor` · **Versión:** `v1.0.0` · **Temperatura:** `0.2`

Se ejecuta antes de habilitar el tablero competitivo a personas que toman decisiones, y
periódicamente durante la campaña. Responde a una única pregunta: **¿la herramienta mide a
todos los contendientes con la misma vara?**

## System prompt

```
Eres un auditor de equidad de sistemas de medición aplicados a competencia política.

El sistema que auditas compara a varios contendientes entre sí. Si mide a unos con más
precisión que a otros, la comparación es inválida aunque cada medición aislada parezca
aceptable. Un sesgo de 8 puntos en la atribución de postura puede invertir un ranking.

## Qué debes examinar

1. PARIDAD DE EXACTITUD. Diferencia de accuracy y F1 de postura entre contendientes.
   Umbral de atención: 0.08. Umbral de bloqueo: 0.15.

2. PARIDAD DE COBERTURA. ¿Se detectan las menciones de todos por igual? Un actor con
   pocos alias registrados aparecerá artificialmente poco y su share of voice estará
   subestimado. Compara model_attribution_ratio entre actores: valores dispares indican
   que unos se detectan por regla y otros por inferencia, con precisiones distintas.

3. SESGO DIRECCIONAL. ¿El modelo tiende a clasificar como "en contra" con más facilidad
   para unos actores que para otros? Compara la tasa de falsos "against" por actor.

4. ASIMETRÍA DE LA MUESTRA. Distribución de menciones por fuente para cada actor. Si un
   contendiente concentra su conversación en un canal donde el clasificador es débil,
   su medición es peor aunque el modelo sea "el mismo".

5. EFECTO DEL ACTOR PROPIO. Verifica específicamente si el desempeño hacia el actor con
   is_own = true difiere del resto. Un sesgo aquí es el más costoso: es el número que
   más se mira y el que menos se cuestiona.

## Qué NO debes hacer

- No evalúes si los actores son buenos o malos candidatos.
- No interpretes los resultados políticos ni sugieras estrategia de campaña.
- No recomiendes ajustar el sistema para que un actor salga mejor. La única corrección
  legítima es la que mejora la exactitud para todos.

## Salida JSON estricta.
```

## User template

```
## Campaña
{{campaign_name}} · {{contest_label}} · {{period}}

## Contendientes y su desempeño de clasificación
{{per_contender_metrics}}

## Distribución de menciones por fuente y actor
{{source_distribution}}

## Exactitud del clasificador por fuente
{{accuracy_by_source}}

## Configuración de detección por actor
{{contender_detection_config}}

## Instrucción
Audita la equidad de la medición y devuelve el JSON.
```

## Salida

```json
{
  "fair_for_comparison": false,
  "headline": "El ranking competitivo no es publicable: dos actores se miden con precisiones que difieren 0.16.",
  "max_accuracy_gap": 0.16,
  "per_contender": [
    {
      "contender_id": "3f2a...",
      "name": "Actor A",
      "is_own": true,
      "stance_accuracy": 0.70,
      "gap_vs_best": 0.16,
      "mentions": 8421,
      "model_attribution_ratio": 0.34,
      "dominant_source": "tiktok",
      "issues": [
        "Sólo 2 alias registrados frente a una media de 6",
        "34% de menciones atribuidas por modelo (media 12%)",
        "61% de su conversación está en el canal con peor exactitud"
      ]
    }
  ],
  "systemic_findings": [
    "La exactitud correlaciona con el canal dominante de cada actor, no con el actor en sí: el sesgo es de cobertura, no del clasificador."
  ],
  "blocking": true,
  "remediation": [
    "Registrar alias y variantes ortográficas de Actor A hasta igualar la cobertura del resto",
    "Reevaluar tras la corrección y confirmar que el gap baja de 0.08",
    "Mientras tanto, mostrar el tablero competitivo con aviso de precisión desigual o desactivarlo"
  ],
  "recommended_disclosure": "Los datos de Actor A provienen mayoritariamente de TikTok, donde la precisión de clasificación es menor. Las comparaciones directas de apoyo neto entre actores no son fiables en este periodo."
}
```

`recommended_disclosure` es el texto que la interfaz debe mostrar sobre el tablero
competitivo mientras el sesgo persista. Cuando `blocking = true`, el frontend atenúa el
comparativo y muestra ese aviso: **es preferible un tablero que declara sus límites a uno
que presenta un ranking sesgado con apariencia de exactitud.**

---

## Ciclo completo de evaluación

```
1. Muestrear casos          → estratificado por fuente, idioma y actor;
                              más un bloque adversarial de ironía, negación y citas
2. Clasificar               → prompt A (juez) propone etiquetas
3. Revisión humana          → sólo los casos que el juez marca requires_human_review,
                              y una muestra aleatoria del 10 % del resto como control
4. Congelar el conjunto     → eval_datasets.is_frozen = true
5. Correr el candidato      → civic.eval_runs + eval_predictions
6. Calcular métricas        → civic_kpi.compute_eval_metrics(run_id)
7. Puerta determinista      → civic_kpi.evaluate_promotion_gate(run_id)     ← decide
8. Dictamen explicado       → prompt B (auditor)                            ← explica
9. Auditoría de equidad     → prompt C (sesgo entre actores)
10. Promover o rechazar     → si pasa: prompt_versions.status = 'active'
```

Los pasos 7 y 8 son complementarios, no alternativos. La puerta decide; el auditor explica
por qué y qué hacer. Un sistema donde un LLM decide qué modelo va a producción no tiene
control de calidad: tiene otra capa de opinión.
