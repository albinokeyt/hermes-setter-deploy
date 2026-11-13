# ⚡ Hermes — Setter IA para Instagram y WhatsApp sobre GoHighLevel

Hermes recibe los mensajes de tus leads a través de GHL, piensa con el LLM que tú elijas (OpenRouter, Gemini, Groq o cualquier API compatible) y responde **como una persona real**: espera a que el lead termine de escribir, contesta en 2-3 mensajes cortos con pausas naturales, hace seguimientos automáticos y clasifica cada lead con etiquetas.

## Qué hace

- **Debounce humano**: si el lead escribe "hola" y luego "cómo estás", el bot espera unos segundos de silencio y responde a todo junto.
- **Respuestas en 2-3 mensajes** con retardos proporcionales a la longitud (simula escritura real).
- **Seguimientos configurables** por cuenta (horas + instrucción para la IA), que se cancelan solos si el lead contesta y respetan la ventana de 24 h de Meta.
- **Memoria por lead**: el agente extrae y recuerda nombre, negocio, dolores, objeciones, acuerdos.
- **Etiquetas / pipeline**: nuevo → en conversación → en seguimiento → calificado → en conversión → descartado, sincronizadas como tags en GHL.
- **Multi-cuenta**: una cuenta por subcuenta de GHL, cada una con su prompt (3 partes), su proveedor de IA, su horario y sus seguimientos.
- **Handoff automático**: si un humano responde desde GHL, el bot se aparta en ese chat.
- **Panel completo**: dashboard central, conversaciones en vivo, kanban de etiquetas, playground de prueba y registro de webhooks.

## Stack

Node 22 · Fastify · BullMQ · Redis · PostgreSQL · React (Vite + Tailwind). Un solo contenedor Docker.

---

## Despliegue en EasyPanel

1. **Crea los servicios de datos** en tu proyecto de EasyPanel:
   - **Postgres** (imagen `postgres:16`): apunta el nombre, usuario y contraseña.
   - **Redis** (imagen `redis:7`).

2. **Crea el servicio App**:
   - Source: **GitHub** → este repositorio, rama `main`.
   - Build: **Dockerfile** (lo detecta solo).
   - Puerto: **3000**.

3. **Variables de entorno** del servicio App:

   ```
   DATABASE_URL=postgres://USUARIO:PASSWORD@NOMBRE_SERVICIO_POSTGRES:5432/BASEDEDATOS
   REDIS_URL=redis://NOMBRE_SERVICIO_REDIS:6379
   ADMIN_USER=admin
   ADMIN_PASSWORD=una-buena-contraseña
   APP_BASE_URL=https://tu-dominio-de-easypanel.easypanel.host
   ```

   > `APP_BASE_URL` es la URL pública del servicio (con https, sin barra final). Se usa para el OAuth de GHL y los webhooks.

4. **Deploy**. Entra con `ADMIN_USER` / `ADMIN_PASSWORD` y cambia la contraseña en la sección Usuario.

---

## Conexión con GHL (modo recomendado: app privada de Marketplace)

La app privada se crea **una sola vez** y sirve para todas tus subcuentas. No pasa por ninguna revisión de GHL.

1. Entra en [marketplace.gohighlevel.com](https://marketplace.gohighlevel.com) y regístrate como developer con tu cuenta de agencia.
2. **Create App**:
   - Type: **Private**
   - Distribution: **Sub-Account**
3. **Scopes** (exactamente estos):
   ```
   conversations/message.readonly conversations/message.write conversations.readonly contacts.readonly contacts.write locations.readonly calendars/events.readonly
   ```
4. **Redirect URL**: `https://TU-APP/api/oauth/callback`
5. **Webhooks**: URL `https://TU-APP/api/webhooks/inbox` y activa los eventos **InboundMessage**, **OutboundMessage**, **AppointmentCreate**, **AppointmentUpdate** y **AppointmentDelete** (los tres últimos alimentan las etiquetas Agendado / Agenda cancelada y la gráfica de agendas).
6. Genera **Client ID** y **Client Secret** y pégalos en Hermes → **Configuración**.
7. En Hermes → **Cuentas** → tu cuenta → pestaña **Conexión GHL** → **Conectar subcuenta**: eliges la subcuenta del cliente y listo.

> **Validación importante (hazla el primer día):** manda un DM de Instagram y un WhatsApp de prueba a la subcuenta conectada y revisa **Configuración → Registro de eventos**. Ahí verás el payload crudo que manda GHL. Si WhatsApp no llegara por el webhook de la app, usa el modo alternativo de abajo solo para ese canal.

### Modo alternativo sin app de Marketplace (PIT + Workflow)

Para conectar una subcuenta sin crear la app:

1. En la subcuenta: **Settings → Private Integrations** → crea un token con los mismos scopes → pégalo en la pestaña **Conexión GHL** de la cuenta junto con su **Location ID**.
2. En la subcuenta crea un **Workflow**:
   - Trigger: **Customer Replied**
   - Action: **Custom Webhook** → método **POST** → URL: la que te da Hermes en esa misma pestaña.
   - En **Custom Data** añade:
     - `contact_id` = `{{contact.id}}`
     - `message` = `{{message.body}}`
     - `channel` = `{{message.type}}`

---

## Cobros: Marketplace Disruptivo

Hermes **no gestiona pagos propios**. Antes de atender pregunta al [Marketplace
Disruptivo](https://marketplace.escaladoacelerado.es) si esa subcuenta tiene el uso **incluido**
(plan o prueba gratuita) y, si no lo tiene, cobra su consumo de IA **solo del saldo prepago** que el
cliente recarga allí (crédito en USD, `pay_with: 'credit'`). Nunca se cobra del wallet de GoHighLevel.

- **Unidad facturable:** una **conversación por día natural**. Da igual que ese día se crucen 30
  mensajes con el lead: cuenta 1. Al día siguiente, ese mismo lead vuelve a contar 1.
- **Identificador de cobro** (lo que impide cobrar dos veces):
  `hermes-{locationId}-{conversationId}-{YYYY-MM-DD}`, derivado siempre de los mismos datos —
  nunca de aleatorios, horas ni contadores en memoria.
- **Se cobra DESPUÉS de entregar** el mensaje al lead, nunca antes.
- **Sin `MD_API_KEY` la integración queda apagada** y Hermes funciona exactamente como antes.

| Pieza | Dónde |
|---|---|
| Cliente, puerta de acceso y cobro | `src/services/marketplace.js` |
| Puerta antes de atender | `puedeAtender()` en `processDebounce` y `processFollowup` (`src/services/pipeline.js`) |
| Registro del consumo tras entregar | `registrarConsumo()` al final de `processSend` (`src/services/pipeline.js`) |
| Fuente de verdad de los cobros | tabla `marketplace_charges` (migración `047`) |
| Panel del administrador | menú **Marketplace** · rutas en `src/routes/marketplace.js` |

Las variables (`MD_API_KEY`, `MD_METER`, `MD_PRECIO_UNIDAD`, `MD_UNIDADES_POR_COBRO`,
`MD_ZONA_HORARIA`, `MD_COBROS`) están documentadas en `.env.example`. **La clave nunca va en el
repositorio**: solo en las variables de entorno de EasyPanel.

Para integrar o probar sin gastar dinero, pide al administrador del marketplace que active el
**modo prueba** de la app Hermes: los cargos quedan con estado `test` y no tocan el wallet ni el
crédito. Desde el panel, **Marketplace → Comprobar** diagnostica sin mover nada y **Cobro de
prueba** ejecuta el ciclo completo (repetirlo el mismo día debe responder «idempotente»: esa es la
prueba de que no se duplica).

## Club de Sistemas (migración 059)

- **Conexiones nuevas seguras**: toda conexión que nace sola (instalación OAuth, enlace de agencia `/ghl-app`, SSO
  de la Custom Page) se crea en `src/services/club.js · crearConexionNueva()` con **🧪 modo prueba** (`test_mode=true`,
  etiqueta `test-setter`) y su «Setter principal» copia la **plantilla de conexiones nuevas** (Configuración →
  «Plantilla de conexiones nuevas»: API, modelo y prompt de partida). Las conexiones que ya existían no cambian.
  Mientras el prompt tenga huecos `[[RELLENAR: …]]`, el setter solo responde en modo prueba (o en el simulador).
- **Interruptor del Club**: `POST /api/club/estado` con la cabecera `X-Club-Secret: <CLUB_WEBHOOK_SECRET>` (o
  `Authorization: Bearer <secreto>`), `Content-Type: application/json` y el cuerpo
  `{ "location_id"?: "…", "email"?: "…", "activo": true|false, "motivo": "…" }`. Pone `ai_enabled` en todas las
  conexiones NUEVAS de la subcuenta. Solo correo: la conexión nueva cuyo **correo del Club confirmado** (`club_email`,
  migración 061: lo pone soporte en la ficha de la conexión → Conexión GHL → «Club de Sistemas», o el admin con
  `PUT /api/accounts/:id`; es único) es ese correo. El responsable (`owner_email`), el correo de la subcuenta en GHL
  (`ghl_location_email`) y los «correos autorizados» NO enlazan (soporte puede ser el responsable y los otros dos los
  edita el cliente): solo son pistas para soporte (`sin_confirmar`). Sin conexión → pendiente (202) que se aplica al
  crearse (subcuenta) o cuando soporte confirma ese correo del Club en una conexión (correo; se aplica el último).
  Conexiones anteriores a la 059 → 202 «protegida», nunca se tocan. Un pendiente más viejo que el último
  estado aplicado (`accounts.club_estado_at`) se descarta («pendiente_obsoleto»). Sin la variable → 503; secreto malo →
  401. Registro en la tabla `club_eventos` (Configuración → «Interruptor del Club»).
- **Tope de gasto mensual** (`accounts.tope_mensual_usd`, solo admin, pestaña Ajustes de la conexión): al llegar al
  tope en el mes natural (zona horaria de la conexión, precio al cliente), la puerta no llama a la IA (como sin saldo),
  tampoco se leen imágenes ni audios con IA, y queda el evento `tope_mensual_alcanzado`. Las pruebas del panel (van a 0)
  no las corta el tope. Es un tope «blando»: la llamada que lo cruza se termina.
- **Devoluciones que se evalúan solas** (migración 060): `POST /api/club/devolucion`, misma cabecera `X-Club-Secret`
  (sin la variable → 503). Cuerpo `{ "email", "contact_id", "producto": "cuenta"|"brain"|"ambos", "motivo",
  "fecha_cobro"?, "location_id"? }`. Por producto: fuera de plazo (días naturales en Madrid desde `fecha_cobro`) →
  `denegada`; **cuenta** → consumo de IA (precio al cliente, `llm_usage.billed_usd`) de su conexión desde el cobro
  ≤ `max_ia_usd` → `aprobada`, más → `denegada` («Has usado X USD de IA (límite 5)»); **brain** → `POST brain_uso_url`
  con el cuerpo `{ "email", "desde" }` (el correo no va en la dirección) y `X-Club-Secret`, respuesta `{ "tareas": N }` ≤ `max_brain_tareas` → `aprobada`, más →
  `denegada`. Sin `location_id`, la cuenta se busca por el correo del Club confirmado (`club_email`). Falta un dato, no
  se puede medir o algo no cuadra → `revision` (nunca se aprueba por un fallo). Se guarda
  en `club_devoluciones` (idempotente por contacto + producto + día del cobro) y el resultado va a GHL
  (`POST ghl_resultado_url` con `{ email, contact_id, producto, decision, motivo, solicitud_id, fecha_cobro, … }`) en
  segundo plano, con reintentos cada 5 min (`workers.js`) y reenvío manual. Ajustes y solicitudes en Configuración →
  «Devoluciones del Club» (setting `devoluciones`: `plazo_dias`, `max_ia_usd`, `max_brain_tareas`, `brain_uso_url`,
  `ghl_resultado_url`).
- Las rutas del Club son públicas **exactas** (`src/lib/rutas.js`; cualquier variante pide sesión) y su freno de
  secretos fallidos cuenta por la IP real (último tramo de `X-Forwarded-For`, el que añade Traefik) y además en una
  ventana global por minuto.
- Pruebas: `npm test` (Postgres real en memoria con PGlite y las migraciones de verdad; la puerta del marketplace con
  dobles de módulo).

## Desarrollo local

```bash
docker compose up --build
# panel en http://localhost:3000  (admin / cambiame)
```

O sin Docker (necesitas Postgres y Redis locales):

```bash
npm install && npm run dev          # API en :3000
cd web && npm install && npm run dev  # panel en :5173 con proxy al API
```

## Estructura

```
src/
  index.js            arranque: migraciones, API, workers, estáticos
  config.js           env + etiquetas + scopes
  db.js               Postgres + migraciones SQL
  queues.js           colas BullMQ (debounce, send, followup)
  workers.js          workers de las colas
  services/
    pipeline.js       recepción, debounce, envío, seguimientos, etiquetas
    agent.js          prompt de 3 partes + memoria + salida JSON
    llm.js            adaptador OpenAI-compatible multi-proveedor
    ghl.js            API de GHL (OAuth + PIT, envío, tags, contactos)
    humanize.js       retardos de escritura, horarios, ventana de 24 h
  routes/             API del panel + webhooks + OAuth
web/                  panel React (Vite + Tailwind)
```
