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

### 💵 Dinero real · OpenRouter y clientes

Tarjeta del panel **Marketplace** (justo debajo de «Rentabilidad por cliente», mismo rango de fechas) que enfrenta
lo que el dueño ha **pagado a OpenRouter** con lo que le han **pagado los clientes**, separando el dinero real del
saldo de **cortesía** que regala. Ruta: `GET /api/marketplace/finanzas?desde=&hasta=&refrescar=1` (solo admin).

- **OpenRouter** (`src/services/openrouter.js`, caché de 5 min; «Actualizar OpenRouter» la salta):
  - gasto de cada API key de OpenRouter guardada en **Proveedores** (`GET /api/v1/key`, con la propia clave);
  - con la variable **opcional** `OPENROUTER_MANAGEMENT_KEY` (una *management key*: solo lectura, no sirve para
    chatear), además lo comprado, lo gastado y el saldo de **toda la cuenta** (`/api/v1/credits`) y el gasto de cada
    clave de la cuenta (`/api/v1/keys`), también las de otras apps como el Brain si comparten cuenta.
  - Las claves se mandan **siempre** a `https://openrouter.ai`, nunca a la `base_url` del proveedor, y **jamás** se
    devuelven en claro (solo la máscara `sk-or-…1c96`). La management key nunca se muestra.
  - La comisión de compra de créditos (5,5 %, mínimo 0,80 $ por compra) no la da la API: se muestra como «≈».
  - **Aviso de saldo**: si la cuenta baja de 5 $ (o una clave de Hermes de 2 $ de límite) sale un aviso arriba de la
    página; con 0,5 $ o menos, en rojo. Si OpenRouter llega a 0, los setters dejan de contestar.
- **Clientes**: `GET /api/v1/finanzas` del marketplace (permiso `can_read_finances` de la app Hermes), con la regla
  «cortesía primero» (cada consumo gasta antes la cortesía y luego el dinero real). Si el permiso no está activo o el
  marketplace aún no tiene la consulta, la tarjeta lo dice y enseña el resto.
- **Resultado**: dinero real consumido en Hermes − coste de la IA de Hermes (`llm_usage`, sin el Archivo).

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
- **Guardas del correo del Club** (fase C3): todos los correos del Club (la ficha, el interruptor, las devoluciones, el
  SSO y las pistas «Usar») pasan por UNA normalización, `services/club.js · analizarCorreo`: quita los espacios ASCII de
  alrededor, pasa a minúsculas y RECHAZA (nunca «arregla») los caracteres invisibles o de formato (`\p{Cf}`: U+200B,
  U+FEFF, U+00AD…), los de control, los espacios que no son ASCII o están dentro, el signo kelvin (U+212A) y el texto
  sin NFC. Guardar uno así en la ficha → 400 con el carácter («lleva un carácter invisible (U+200B, espacio de ancho
  cero)…»); en el interruptor → 400 «email no válido: …»; en las devoluciones → aviso y revisión. Además el correo del
  Club no puede ser el de soporte (`soporte@departamentodisruptivo.com`, `soporte@soyjonathanalef.com`, siempre), el de
  un usuario admin de Hermes cuyo usuario es un correo ni los que se añadan en Configuración → «Correo del Club»
  (setting `club_correos.no_club`: correos o `@dominio.com`, también sus subdominios; `GET/PUT /api/settings/club-correos`,
  que avisa en `en_uso` si alguna conexión ya tiene uno confirmado) → 400. La ficha solo ofrece «Usar» con las pistas
  que el servidor dejaría guardar (`club_pistas` en `GET /api/accounts/:id`, solo admin).
  Repaso de la C3: `analizarCorreo` también rechaza las letras de OTROS alfabetos que se confunden con las latinas
  (`ѕ` cirílica U+0455, `ｓ` de ancho completo, la `İ` turca…), números y signos «especiales» (guion largo U+2013…), los
  puntos mal puestos (`ana@x.com.`, `ana..b@x.com`, `.ana@…`) y los signos que un correo no admite sin comillas
  (`( ) , : ; [ ] \`); las letras latinas con tilde (á, é, ñ, ç, ü…) valen. La lista se compara por BUZÓN
  (`soporte+prueba@…` = `soporte@…`; en Gmail sin puntos y googlemail.com = gmail.com). «Usar» tampoco ofrece el correo
  que ya es el correo del Club de OTRA conexión (daba 409) y avisa si lleva tildes. Un `club_email` que solo lleva un BOM
  o un espacio duro ya no lo QUITA (400); vaciarlo es mandarlo vacío. En el interruptor, `email`, `location_id` y `activo`
  tienen que ser texto (o true/false); los 400 quedan en `club_eventos` con resultado `rechazado` (y `club_estado_rechazado`
  en el registro de eventos) con lo recibido visible (`ana@x.com<U+200B>`); y con un `location_id` válido un correo que no
  vale ya no tumba la orden: se aplica por la subcuenta, el correo no se guarda y la respuesta lleva `aviso`. Límites que
  decide la persona: un subdominio (`soporte@mail.departamentodisruptivo.com`) solo se para con `@departamentodisruptivo.com`
  en la lista, y los admins de Hermes solo cuentan si su usuario es un correo (con `ADMIN_USER=admin`, ninguno: añadir sus
  correos a la lista). El responsable (`owner_email`) se sigue guardando con el `normEmail` del portal (es también la
  identidad de acceso de todas las conexiones); su pista vuelve a pasar por `analizarCorreo`.
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
