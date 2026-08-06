# Canal de WhatsApp

Envía la alerta a los suscriptores cuando se registra algo negativo. Mismo
patrón que su `whatsapp-sender` de ziba: cola en la base, adaptador enchufable,
reintentos con espera creciente.

## Cómo circula

```
Ajustes → «Registrar comentario negativo»   (solo rol admin)
        │
        ▼  POST /api/v1/campaigns/{code}/manual-comments
   civic.contents  +  civic.inferences  (pipeline='human')
        │
        ▼  INSERT en civic.alerts
   disparador tg_alerts_fanout → civic.fanout_alert_deliveries()
        │      filtra por consentimiento · severidad mínima · tipo · veda
        ▼
   civic.alert_deliveries  status='pending'
        │
        ▼  el despachador del whatsapp-bot, cada 10 s
   claim_whatsapp_deliveries()  →  'sending'
        │
        ▼  adaptador: wwebjs · meta_cloud · twilio · mock
        │
        ├── enviado ──► mark_delivery_sent()   → 'sent'
        └── falló ──┬── transitorio ─► 'pending', reintento en 1, 2, 4, 8 min
                    └── permanente ──► 'failed'
```

Lo que faltaba antes era el tramo del medio: las alertas se creaban y las
entregas no existían, porque nada las generaba ni las enviaba.

---

## Puesta en marcha

### 1. Instalar el SQL

```bash
psql "$DATABASE_URL" -f sql/12_whatsapp_dispatch.sql
```

Crea el reparto, el reclamo, el cierre con reintentos y la regla de alerta
para comentarios negativos.

### 2. Dar de alta destinatarios

Sin esto la alerta se crea pero no sale ningún mensaje. La tarjeta de Ajustes
lo avisa antes de enviar, pero conviene hacerlo primero.

```sql
INSERT INTO civic.alert_subscriptions
  (organization_id, campaign_id, campaign_code, channel, destination,
   display_name, min_severity, consent_given_at, consent_source)
SELECT organization_id, id, code, 'whatsapp',
       '5215512345678',            -- país + número, solo dígitos
       'Uriel',
       'low',                      -- recibe de esta severidad hacia arriba
       NOW(), 'alta manual'
FROM   civic.campaigns
WHERE  code = 'SU-CAMPANA';
```

`consent_given_at` no es opcional: un disparador de la base rechaza el alta de
un WhatsApp activo sin consentimiento. Es un requisito legal, no una
preferencia del producto.

`min_severity` importa. La alerta del comentario negativo es `high`, así que
un suscriptor con `min_severity='critical'` **no** la recibirá.

### 3. Variables de entorno

En el `.env` del despliegue:

```bash
# ── Despachador ──
WA_DISPATCH_ENABLED=true
WA_DISPATCH_INTERVAL_MS=10000    # cada cuánto revisa la cola
WA_DISPATCH_BATCH=10
WA_MAX_ATTEMPTS=5
WA_RETRY_BASE_MINUTES=1          # espera 1, 2, 4, 8, 16 min
WA_STUCK_MINUTES=5               # rescata entregas de un bot caído
WA_SEND_TIMEOUT_MS=30000

# ── Proveedor ──
# mock | wwebjs | meta_cloud | twilio
WA_PROVIDER=wwebjs

# Si se rellena, IGNORA WA_PROVIDER. Sirve para forzar 'mock' contra la base
# de producción sin escribirle a nadie: la única forma segura de probar el
# despachador con destinatarios reales.
# WA_OVERRIDE_PROVIDER=mock

# ── whatsapp-web.js ──
WA_SESSION_PATH=/var/lib/oeste-sentimientos/wa-session
WA_CLIENT_ID=oeste-sentimientos
WA_AUTOSTART=true
WA_PRINT_QR_TERMINAL=true
```

**Empiece con `WA_PROVIDER=mock`.** Registra el envío en el log sin mandar
nada. Cuando vea las entregas pasar a `sent`, cambie a `wwebjs`.

### 4. Vincular el teléfono por QR

El bot arranca sin sesión y publica el QR. Dos formas de verlo:

```bash
# Por consola
docker compose -f docker-compose.prod.yml logs -f whatsapp-bot

# O como imagen, con un token de admin
curl -H "Authorization: Bearer $TOKEN" \
     'https://sentimientos.oeste.mx/api/whatsapp/bot/status?include_qr=true'
```

En el teléfono: **WhatsApp → Ajustes → Dispositivos vinculados → Vincular un
dispositivo**, y escanear.

El QR caduca en unos 60 segundos. Si expira, `POST /bot/reconnect` genera otro.

Tres cosas que conviene saber antes de usar este proveedor:

- **El volumen persistente no es opcional.** Si `WA_SESSION_PATH` no sobrevive
  al reinicio del contenedor, hay que escanear el QR en cada despliegue.
- **Quien tenga el QR se lleva la sesión.** Trátelo como una contraseña.
- **No es un canal oficial de Meta.** Funciona bien y es gratis, pero un
  volumen alto de mensajes a números que no le han escrito antes puede acabar
  en un bloqueo de la cuenta. Para envíos masivos, `meta_cloud`.

### 5. Comprobar

```bash
docker compose -f docker-compose.prod.yml build --no-cache sentiment-api whatsapp-bot frontend
docker compose -f docker-compose.prod.yml up -d
```

Entrar como admin → **Ajustes** → *Registrar comentario negativo*. La tarjeta
dice de antemano a cuántos destinatarios va a llegar.

---

## Verificar y diagnosticar

```sql
-- Cola por estado
SELECT status, count(*) FROM civic.alert_deliveries
 WHERE channel='whatsapp' GROUP BY 1;

-- Lo último que salió
SELECT recipient, provider_ref, sent_at FROM civic.alert_deliveries
 WHERE status='sent' ORDER BY sent_at DESC LIMIT 10;

-- Fallos permanentes, con el motivo
SELECT recipient, attempt, error_message FROM civic.alert_deliveries
 WHERE status='failed' ORDER BY updated_at DESC;

-- Suprimidas por veda
SELECT recipient, suppression_reason FROM civic.alert_deliveries
 WHERE status='suppressed';

-- Quién recibiría una alerta 'high' hoy
SELECT s.destination, s.display_name, s.min_severity
FROM   civic.alert_subscriptions s
JOIN   civic_cat.severity_levels smin ON smin.code = s.min_severity
JOIN   civic_cat.severity_levels salr ON salr.code = 'high'
WHERE  s.channel='whatsapp' AND s.is_active
  AND  s.consent_given_at IS NOT NULL AND salr.rank >= smin.rank;
```

Estado del canal completo, sesión y cola:

```bash
curl -H "Authorization: Bearer $TOKEN" \
     https://sentimientos.oeste.mx/api/whatsapp/bot/status | jq .data.dispatcher
```

### Síntomas y causas

| Lo que ve | Causa habitual |
|---|---|
| `deliveries: 0` al registrar | No hay suscriptores, o su `min_severity` es mayor que `high`, o falta `consent_given_at` |
| Entregas en `pending` que no avanzan | `WA_DISPATCH_ENABLED=false`, o el bot no arranca |
| `failed` con «WhatsApp no conectado» | La sesión se cayó. Vuelva a vincular con el QR |
| `failed` con «proveedor desconocido» | Errata en `WA_PROVIDER` |
| `suppressed` con `veda_electoral` | Correcto: en veda se registra pero no se envía |
| Llega a unos sí y a otros no | Los que no reciben tienen `min_severity` por encima de la alerta |

---

## Notas

**Solo los comentarios negativos generan alerta.** Un positivo se registra y
cuenta en los indicadores, pero no manda WhatsApp. Avisar de las felicitaciones
convierte el canal en ruido, y el canal ruidoso se silencia justo antes de la
alerta que sí importaba.

**Lo registrado a mano cuenta en los indicadores.** Queda marcado con
`pipeline='human'` y con el usuario que lo creó, así que se puede separar
después, pero mientras esté ahí suma en los porcentajes igual que un comentario
recogido de una fuente real.

**El mensaje lleva la advertencia metodológica.** No es adorno: un WhatsApp que
dice «el sentimiento cayó 12 %» se reenvía por ahí como si fuera una encuesta.
La advertencia viaja con él.

**Se puede correr más de una réplica del bot.** El reclamo usa
`FOR UPDATE SKIP LOCKED`, así que dos despachadores no toman la misma entrega.
Con `wwebjs`, en cambio, solo una réplica puede tener la sesión: varias
instancias sobre el mismo perfil en disco lo corrompen.
