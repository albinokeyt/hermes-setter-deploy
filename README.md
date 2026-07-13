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
