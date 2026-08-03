import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

// 🧭 Tutorial guiado EXHAUSTIVO: recorre TODO el sistema — cada sección, cada pestaña y cada
// control — navegando solo entre páginas, entrando a una conexión, un setter y un chat REALES
// (si existen) y cambiando las pestañas por sí mismo (campo `click`). Todo en palabras sencillas.
// Los objetivos se marcan con data-tour; los pasos se filtran por rol (menú + adminOnly) y los
// elementos que no existan en ese momento se saltan solos. El progreso (paso máximo) se reporta
// al servidor para que el admin vea el % de cada usuario en la sección Usuarios.

const PAD = 6; // aire alrededor del elemento enfocado
const CARD_W = 330;

// ctx = ids reales para las visitas por dentro: primera conexión, primer setter, un chat reciente
function buildSteps(me, ctx) {
  const isAdmin = me?.role === 'admin';
  const cuentas = isAdmin ? 'Conexiones' : 'Mis agentes';
  const accRoute = ctx.accountId ? `/cuentas/${ctx.accountId}` : null;
  const setRoute = ctx.setterId ? `/setters/${ctx.setterId}` : null;
  const convRoute = ctx.convId ? `/conversaciones/${ctx.convId}` : null;

  return [
    // ── Bienvenida ──
    { sel: 'tour-btn', title: 'Este recorrido, siempre a mano', text: 'Desde este botón puedes volver a ver el tutorial cuando quieras. Vamos a recorrer TODO el sistema — cada sección y cada botón — y el propio tutorial te irá llevando de página en página. Puedes salir cuando quieras con «Finalizar tutorial» o la tecla Esc.' },

    // ── Dashboard ──
    { route: '/', sel: 'page:dash', title: 'Dashboard', text: 'Tu resumen general: cuántas personas han escrito, mensajes enviados y recibidos, citas agendadas y lo que llevas gastado en IA.' },
    { route: '/', sel: 'dash-rango', title: 'Elige el periodo', text: 'Con estos botones cambias el rango de fechas (hoy, 7, 30, 90 días o uno personalizado). Todo lo de abajo se recalcula para ese periodo.' },
    { route: '/', sel: 'dash-stats', title: 'Los números clave', text: `Conversaciones nuevas y activas, mensajes recibidos y enviados, y agendas conseguidas.${isAdmin ? ' Como admin también ves el costo de IA (lo que pagas) y lo facturado (lo que cobras): pulsa la tarjeta de costo para ver el desglose.' : ''}` },
    { route: '/', sel: 'dash-etapas', title: 'Tus leads por status', text: 'Cuántos leads hay en cada status (nuevo, en conversación, calificado, agendado…). La tarjeta 🚨 avisa si alguien pidió hablar con una persona. Pulsa cualquiera para ir al tablero.' },
    { route: '/', sel: 'dash-grafica', title: 'La actividad día a día', text: 'Mensajes recibidos y enviados, leads nuevos y agendas de cada día. De un vistazo ves si la máquina está funcionando.' },

    // ── Paso 1 (admin): APIs ──
    { route: '/apis', sel: 'page:apis', title: 'Para montar el sistema, paso 1: APIs de IA', text: 'Aquí conectas los «cerebros» que usarán tus asistentes. Con «Añadir API» pegas la clave de tu proveedor (OpenRouter, por ejemplo), eliges el modelo, marcas para qué sirve (texto, ver fotos, escuchar audios) y defines costo y precio.' },
    { route: '/apis', sel: 'apis-lista', title: 'Tus APIs creadas', text: 'Cada tarjeta es una API lista para usar. Puedes probarla, editarla o borrarla. Y muy importante: «Disponible para usuarios» hace que tus clientes puedan elegirla para su asistente sin ver tu clave ni tus costes.' },

    // ── Paso 2: Conexiones (lista) ──
    { route: '/cuentas', sel: 'page:cuentas', title: `Paso 2: ${cuentas}`, text: 'La pieza central. Cada conexión es una cuenta de GoHighLevel, y dentro viven tus setters: los asistentes que chatean por ti con los leads.' },
    { route: '/cuentas', sel: 'cuentas-acciones', title: 'Crear conexión y setter', text: isAdmin
        ? 'Con «Nueva conexión» enlazas una cuenta de GHL (te guía para instalar la app). Con «Nuevo setter» creas al asistente que chateará dentro de esa conexión.'
        : 'Con «Nuevo setter» creas un asistente dentro de tu conexión. Para añadir otra subcuenta de GHL, abre Hermes desde esa subcuenta y se conecta sola.' },
    { route: '/cuentas', sel: 'cuentas-lista', title: 'Tus conexiones', text: 'Cada fila es una conexión: ves si GHL está enlazado, enciendes o apagas su IA, activas el 🧪 modo test y con la flechita despliegas sus setters. «Conexión» entra a su configuración — vamos a entrar ahora.' },

    // ── Dentro de una CONEXIÓN (real) ──
    ...(accRoute ? [
      { route: accRoute, gate: '/cuentas', sel: 'conexion-estado', title: 'Dentro de la conexión: su interruptor', text: 'Este interruptor enciende o apaga TODA la conexión (todos sus setters). Y «Guardar» aplica cualquier cambio que hagas en estas pestañas — no se guarda solo.' },
      { route: accRoute, gate: '/cuentas', sel: 'conexion-tabs', title: 'Las pestañas de la conexión', text: 'Setters (los asistentes), Ajustes (horarios, test, pausas), CTAs (esperas para anuncios), Accesos (quién puede entrar) y Conexión GHL. El tutorial las irá abriendo una a una.' },
      { route: accRoute, gate: '/cuentas', sel: 'conexion-setters', click: 'conexion-tab-setters', title: 'Los setters de esta conexión', text: 'Cada fila es un asistente: si está encendido, qué IA usa, cuántos leads lleva y cuántas agendas consiguió. El «principal» atiende a quien no case con ningún otro. Abajo puedes crear más.' },
      { route: accRoute, gate: '/cuentas', sel: 'conexion-ajustes', click: 'conexion-tab-ajustes', title: 'Ajustes: el nombre', text: 'El nombre técnico y el alias (el nombre bonito que ves en el panel). Los canales que atiende cada asistente se eligen dentro del propio setter.' },
      { route: accRoute, gate: '/cuentas', sel: 'conexion-horario', click: 'conexion-tab-ajustes', title: 'Horario de respuesta', text: 'Si lo limitas, fuera de ese horario el asistente NO responde: guarda lo pendiente y contesta cuando vuelva a abrir. Con su zona horaria.' },
      { route: accRoute, gate: '/cuentas', sel: 'conexion-insercion', click: 'conexion-tab-ajustes', title: 'Tiempo de inserción', text: 'Cuando un lead escribe por primera vez, los asistentes esperan estos segundos antes de decidir. Sirve para que una automatización de GHL tenga tiempo de ponerle una etiqueta (por ejemplo, una que diga «a este no le respondas»).' },
      { route: accRoute, gate: '/cuentas', sel: 'conexion-test', click: 'conexion-tab-ajustes', title: 'Modo test de toda la conexión', text: 'Con esto activado, los setters SOLO responden a contactos que tengan la etiqueta de prueba en GHL. Perfecto para ensayar con tu propio número antes de abrir el grifo.' },
      { route: accRoute, gate: '/cuentas', sel: 'conexion-exclusion', click: 'conexion-tab-ajustes', title: 'Etiqueta de exclusión', text: 'Lo contrario del test: cualquier contacto con esta etiqueta queda FUERA de las IAs — ningún setter le responde. Útil para clientes actuales o casos delicados.' },
      { route: accRoute, gate: '/cuentas', sel: 'conexion-pausa-humano', click: 'conexion-tab-ajustes', title: 'Si un humano interviene, el bot se aparta', text: 'Cuando alguien de tu equipo responde a mano (desde GHL o el móvil), el asistente se pausa en ese chat. ⚠️ Pon los minutos de reactivación en más de 0: con 0, queda pausado para siempre hasta que lo reactives tú.' },
      { route: accRoute, gate: '/cuentas', sel: 'conexion-comentarios', click: 'conexion-tab-ajustes', title: 'Comentarios de Instagram', text: 'Pega esta URL en una automatización de GHL con el trigger de comentario de Instagram y todos los comentarios quedarán registrados en el Archivo. Abajo puedes probar que llegan.' },
      { route: accRoute, gate: '/cuentas', sel: 'conexion-ctas', click: 'conexion-tab-ctas', title: 'CTAs: esperas para anuncios', text: 'Si el PRIMER mensaje del lead contiene una palabra clave (la frase de tu anuncio, por ejemplo), el asistente espera el tiempo que definas antes de entrar — para no contestar de golpe y parecer un robot.' },
      { route: accRoute, gate: '/cuentas', sel: 'conexion-accesos', click: 'conexion-tab-accesos', title: 'Accesos del cliente', text: 'Quién puede entrar al panel de esta conexión: los usuarios de la subcuenta en GHL entran solos, y aquí puedes añadir correos extra.' },
      { route: accRoute, gate: '/cuentas', sel: 'conexion-ghl', click: 'conexion-tab-conexion', adminOnly: true, title: 'Conexión GHL (técnica)', text: 'Cómo se enlaza con GoHighLevel: por la app del Marketplace (OAuth, recomendado) o por token privado. Aquí están el enlace del portal del cliente y el webhook alternativo. Abajo, la zona de peligro para eliminar la conexión.' },
    ] : []),

    // ── Dentro de un SETTER (real) ──
    ...(setRoute ? [
      { route: setRoute, gate: '/cuentas', sel: 'setter-estado', title: 'Dentro de un setter: su interruptor', text: 'Ahora estamos DENTRO de un asistente. Su interruptor lo enciende o apaga (solo a él), y «Guardar cambios» aplica todo lo que toques en sus pestañas. Puedes cambiarle el nombre pulsando sobre él.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-tabs', title: 'Las pestañas del setter', text: 'Prompt (lo que sabe decir), IA (su cerebro), Comportamiento (cómo y cuándo responde), ⚡ Activaciones (entrar por etiqueta), Seguimientos (reenganchar) y ✨ Arquitecto (crear el prompt conversando). Vamos una a una.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-prompt-intro', click: 'setter-tab-prompt', title: 'El prompt, en 3 bloques', text: 'El guion completo del asistente se divide en 3 partes. Con «🕘 Historial» puedes ver versiones anteriores y volver a cualquiera si un cambio no te gustó.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-prompt-identidad', click: 'setter-tab-prompt', title: '1 · Identidad', text: 'Quién es: su nombre, su tono, cómo escribe, qué haría y qué jamás diría. Es su personalidad.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-prompt-negocio', click: 'setter-tab-prompt', title: '2 · Negocio y oferta', text: 'Qué vendes, a quién, precios, beneficios, respuestas a preguntas frecuentes y los enlaces que puede enviar.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-prompt-flujo', click: 'setter-tab-prompt', title: '3 · Flujo y objetivo', text: 'El paso a paso de la conversación y su OBJETIVO: agendar una cita, enviar un enlace, calificar… Es el mapa que sigue con cada lead.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-ia-texto', click: 'setter-tab-ia', title: 'Su cerebro: la API de texto', text: 'Qué API usa para chatear (de las que creaste en APIs de IA), la temperatura (más alta = más creativo) y en cuántos mensajes puede dividir cada respuesta.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-ia-imagen', click: 'setter-tab-ia', title: 'Leer fotos', text: 'Si lo activas, cuando el lead envíe una foto el asistente la «ve» y la usa en la conversación. Necesita una API marcada para imagen.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-ia-audio', click: 'setter-tab-ia', title: 'Escuchar notas de voz', text: 'Si lo activas, las notas de voz del lead se convierten en texto y el asistente responde a lo que dijo. Sin esto, pedirá con naturalidad que se lo escriban.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-comportamiento', click: 'setter-tab-comportamiento', title: 'Comportamiento', text: 'Cómo y cuándo responde. La «espera antes de responder» es clave: el asistente deja pasar unos segundos de silencio y responde a TODO junto, como una persona — no mensaje a mensaje.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-canales', click: 'setter-tab-comportamiento', title: 'Sus canales', text: 'En qué canales atiende ESTE setter (WhatsApp, Instagram…). Los mensajes de otros canales se guardan igual, pero no los responde él.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-insercion', click: 'setter-tab-comportamiento', title: 'Su tiempo de inserción', text: 'Igual que el de la conexión pero solo para este setter (si es mayor, manda el suyo). Da margen a que las automatizaciones de GHL etiqueten al lead antes de que el setter decida entrar.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-calendarios', click: 'setter-tab-comportamiento', title: 'Sus calendarios de agenda', text: 'Si su objetivo es agendar, marca AQUÍ sus calendarios: solo esas reservas cuentan como agenda suya. Sin esto, sus citas no se miden. Si su objetivo es otro, déjalo vacío.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-test', click: 'setter-tab-comportamiento', title: 'Su modo test', text: 'Test individual: SOLO este setter queda en pruebas, con su propia etiqueta, mientras los demás siguen normal. Puedes probar varios a la vez, cada uno con la suya.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-filtro-tags', click: 'setter-tab-comportamiento', title: 'Filtrar por etiquetas (avanzado)', text: 'Para repartir leads entre varios setters: este solo atiende a contactos con ciertas etiquetas de GHL, o ignora a los que tengan otras. Vacío = atiende a cualquiera sin dueño.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-activaciones', click: 'setter-tab-activaciones', title: '⚡ Activaciones por etiqueta', text: 'La joya: cuando tu workflow de GHL le pone una etiqueta al contacto, el setter entra a hablar ÉL SOLO. Cada etiqueta lleva su contexto («ya abrió la guía, retoma eso»), su espera y sus CTAs vinculados — y esas instrucciones mandan.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-activ-webhook', click: 'setter-tab-activaciones', title: 'El webhook de etiquetas', text: 'Para que las etiquetas lleguen: pega esta URL en tu app de GHL (fila ContactTagUpdate). Es la misma para todas las subcuentas, y abajo puedes probar que llegan.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-activ-registro', click: 'setter-tab-activaciones', title: 'Registro en vivo', text: 'Cada activación aparece aquí con su cuenta atrás hasta que el setter habla, el mensaje que envió, o el motivo si se descartó. Así ves la película completa.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-seguimientos', click: 'setter-tab-seguimientos', title: 'Seguimientos', text: 'Si el lead deja de contestar, el setter lo retoma solo: hasta 5 pasos, cada uno con sus horas de espera y su instrucción («retoma con algo del último tema, cero presión»). Se cancelan si el lead responde, y la IA revisa antes si aún conviene.' },
      { route: setRoute, gate: '/cuentas', sel: 'setter-arquitecto', click: 'setter-tab-arquitecto', title: '✨ El arquitecto', text: 'Crea el prompt conversando: la IA arquitecta te entrevista sobre tu negocio (qué vendes, precios, objeciones, tu forma de hablar) y arma los 3 bloques por ti. Cuando te guste, «Aplicar» y listo.' },
    ] : []),

    // ── Paso 3: Probar agente ──
    { route: '/prueba', sel: 'page:prueba', title: 'Paso 3: pruébalo aquí', text: 'Antes de soltar a tu asistente, chatea con él como si fueras un cliente. No gasta leads reales y se comporta exactamente igual que en producción.' },
    { route: '/prueba', sel: 'prueba-selector', title: 'Elige a quién probar', text: 'Si tienes varias conexiones o setters, aquí eliges cuál pruebas. «Reiniciar» empieza una conversación de cero.' },
    { route: '/prueba', sel: 'prueba-pruebas', title: 'Tus pruebas guardadas', text: 'Cada conversación de prueba se guarda: retómala, renómbrala o bórrala. La marca vN te dice con qué versión del prompt quedó — así comparas antes y después.' },
    { route: '/prueba', sel: 'prueba-chat', title: 'El chat de prueba', text: 'Habla aquí como el lead. Prueba a mandar varios mensajes seguidos («hola» … «quería info»): espera unos segundos y responde a todo junto, como hará en la vida real.' },
    { route: '/prueba', sel: 'prueba-decision', title: 'Qué decidió y por qué', text: 'Tras cada respuesta ves qué status le puso al lead (nuevo, calificado…) y el motivo. Es la «mente» del asistente en vivo.' },
    { route: '/prueba', sel: 'prueba-memoria', title: 'La memoria que construye', text: 'Los datos que va guardando del lead (nombre, negocio, dolor, presupuesto…). Esa memoria la usa en toda la conversación — cuéntale cosas y mira cómo las apunta.' },
    { route: '/prueba', sel: 'prueba-corregir', title: 'Corrígelo con tus palabras', text: '¿Algo no te gustó? Pulsa «Importar cambio» y dile la corrección como a un empleado («no ofrezcas descuento tan pronto»). Reescribe el prompt él solo, con cada versión guardada en el historial.' },
    { route: '/prueba', sel: 'prueba-gasto', title: 'Lo gastado en pruebas', text: 'Las pruebas también consumen IA: aquí ves cuánto llevas gastado en probar y ajustar.' },

    // ── Paso 4: Conversaciones ──
    { route: '/conversaciones', sel: 'page:conv', title: 'Paso 4: míralo trabajar', text: 'Todos los chats reales, en tiempo real: qué dijo el lead, qué respondió el asistente y en qué punto va cada uno.' },
    { route: '/conversaciones', sel: 'conv-filtros', title: 'Encuentra cualquier chat', text: 'Busca por nombre o correo, o filtra por conexión, asistente o status. También puedes ver solo los chats donde intervino un humano.' },
    { route: '/conversaciones', sel: 'conv-lista', title: 'La lista de chats', text: 'Cada fila: quién es, su última actividad, su status y quién lo atiende. Pulsa cualquiera para entrar — vamos a entrar a uno.' },

    // ── Dentro de un CHAT (real) ──
    ...(convRoute ? [
      { route: convRoute, gate: '/conversaciones', sel: 'chat-cabecera', title: 'Dentro de un chat: la cabecera', text: 'Quién es el lead, por qué canal habla y qué setter lo atiende. «Ir a GHL» abre su ficha en GoHighLevel, y el botón «IA» saca a este contacto de las IAs para siempre (o lo devuelve).' },
      { route: convRoute, gate: '/conversaciones', sel: 'chat-historial', title: 'La conversación completa', text: 'Cada burbuja dice quién habló: el lead, el 🤖 asistente, un 👤 humano o una ⚙️ automatización de GHL. Nada se pierde.' },
      { route: convRoute, gate: '/conversaciones', sel: 'chat-escribir', title: 'Escribir tú, en persona', text: 'Escribe aquí y el mensaje sale como humano: el asistente se aparta automáticamente en este chat para no pisarte.' },
      { route: convRoute, gate: '/conversaciones', sel: 'chat-control', title: 'El control del chat', text: 'Pausa o reactiva el asistente solo en esta conversación, y cámbiale el status al lead a mano si hace falta.' },
      { route: convRoute, gate: '/conversaciones', sel: 'chat-memoria', title: 'Su memoria de este lead', text: 'Lo que el asistente sabe de esta persona: nombre, negocio, dolor, acuerdos… Lo usa para no repetir preguntas y sonar humano.' },
      { route: convRoute, gate: '/conversaciones', sel: 'chat-etiquetas-hist', title: 'El camino del lead', text: 'Por qué status pasó y por qué: cada cambio de status queda registrado con su motivo. Abajo puedes borrar la conversación para que el contacto entre de cero (útil al probar).' },
    ] : []),

    // ── Etiquetas ──
    { route: '/etiquetas', sel: 'page:tags', title: 'Status: tu embudo', text: 'El tablero de leads: el asistente le pone el status a cada uno solo y aquí los ves por columnas, de nuevo a convertido.' },
    { route: '/etiquetas', sel: 'tags-board', title: 'El tablero', text: 'Cada columna es un status y cada tarjeta un lead. Puedes arrastrar o mover cualquiera a mano, y entrar a su chat desde la tarjeta.' },

    // ── Archivo ──
    { route: '/archivo', sel: 'page:archivo', title: 'Archivo', text: 'El historial completo de TODO: mensajes del asistente, de humanos y de automatizaciones, y los comentarios de Instagram. Aunque el bot esté apagado, aquí se guarda todo.' },
    { route: '/archivo', sel: 'archivo-filtros', title: 'Filtros y descarga', text: 'Filtra por conexión, canal, o quién envió cada mensaje (asistente, humano o automatización); cambia a 💬 Comentarios para ver los de Instagram; y «Descargar CSV» te lo lleva a Excel.' },
    { route: '/archivo', sel: 'archivo-lista', title: 'Los mensajes', text: 'Cada fila con su fecha, contacto, canal y contenido. Es tu caja negra: si pasó, está aquí.' },

    // ── Versus ──
    { route: '/versus', sel: 'page:versus', title: '⚔️ Versus', text: 'Pon a competir a dos (o más) asistentes con leads reales: el sistema reparte los leads y te dice cuál agenda más. Ideal para probar dos formas de vender la misma oferta.' },
    { route: '/versus', sel: 'versus-nuevo', title: 'Crear un versus', text: 'Elige la métrica ganadora (agendas, conversión…), qué leads compiten (todos o solo con cierta etiqueta) y los setters que se enfrentan.' },

    // ── Errores ──
    { route: '/errores', sel: 'page:errores', title: 'Reportar error', text: '¿Algo falló? Cuéntanoslo aquí. Nada se pierde: cada reporte queda registrado con su estado.' },
    { route: '/errores', sel: 'bugs-grafico', adminOnly: true, title: 'El pulso de las incidencias', text: 'Incidencias que entran y resoluciones que salen, por día — y si eliges un solo día, por horas. Cambia el rango con los botones o las fechas.' },
    { route: '/errores', sel: 'bugs-filtros', adminOnly: true, title: 'Filtra los reportes', text: 'Por estado (abierto, en curso, resuelto) y por tipo de error. El rango de fechas del gráfico también filtra la lista de abajo.' },
    { route: '/errores', sel: 'bugs-form', title: 'El formulario', text: 'Elige el tipo de error, cuenta qué pasó y adjunta capturas de pantalla si quieres. Cuantos más detalles, más rápido se arregla.' },
    { route: '/errores', sel: 'bugs-lista', title: 'Tus reportes y las respuestas', text: 'Aquí ves cada reporte, su estado (abierto o resuelto) y la 💬 respuesta del equipo cuando llegue — todo dentro del propio reporte.' },

    // ── Configuración (admin) ──
    { route: '/configuracion', sel: 'page:config', title: 'Configuración (solo admin)', text: 'La sala de máquinas: la conexión con GoHighLevel, los prompts maestros y el registro de todo lo que llega. Vamos pieza por pieza.' },
    { route: '/configuracion', sel: 'config-guardarrail', title: 'El guardarraíl', text: 'La regla inquebrantable que se aplica a TODOS los setters, por encima de sus prompts: que no inventen datos ni se salgan de su papel.' },
    { route: '/configuracion', sel: 'config-arquitecto', title: 'Prompt del arquitecto', text: 'Cómo entrevista la IA arquitecta cuando crea un prompt desde cero. Si lo dejas vacío, usa el de fábrica (recomendado).' },
    { route: '/configuracion', sel: 'config-corrector', title: 'Prompt del corrector', text: 'Cómo aplica el corrector los cambios que pides desde «Probar agente»: ediciones quirúrgicas, sin reescribir de más. Vacío = el de fábrica.' },
    { route: '/configuracion', sel: 'config-modelos', title: 'Sus modelos de IA', text: 'Con qué modelo trabajan el arquitecto y el corrector (independiente del modelo de chat de cada setter). Vacío = usan el del setter.' },
    { route: '/configuracion', sel: 'config-app', title: 'La app de GHL', text: 'Las credenciales de tu app del Marketplace (Client ID y Secret) y el secreto SSO para el acceso blindado. Con la guía de cómo crear la app paso a paso.' },
    { route: '/configuracion', sel: 'config-instalacion', title: 'Enlace de instalación', text: 'El «clic para instalar»: quien lo abre elige su subcuenta de GHL y la app queda instalada y conectada. Para instalarla tú o mandársela a un cliente.' },
    { route: '/configuracion', sel: 'config-agencia', title: 'Enlace de agencia', text: 'Pégalo UNA vez como menú personalizado a nivel agencia en GHL y aparece en todas las subcuentas: cada cliente entra a SU panel automáticamente, verificado por sus usuarios de GHL.' },
    { route: '/configuracion', sel: 'config-urls', title: 'URLs de la app', text: 'Lo que se pega en la app del Marketplace: la Custom Page (acceso blindado), la Redirect URL, la Webhook URL de mensajes y los scopes. Copiar y pegar, tal cual.' },
    { route: '/configuracion', sel: 'config-eventos', title: 'Registro de eventos', text: 'TODO lo que llega de GHL, en crudo. Si algo no funciona, aquí se ve al momento: úsalo para validar que Instagram y WhatsApp entran bien antes de activar el bot.' },

    // ── Usuarios ──
    { route: '/usuarios', sel: 'page:usuarios', title: 'Usuarios', text: 'Quién puede entrar al panel y qué puede tocar cada uno.' },
    { route: '/usuarios', sel: 'users-mi-acceso', title: 'Tu acceso', text: 'Cambia aquí tu nombre de usuario y tu contraseña (te pedirá la actual para confirmar).' },
    { route: '/usuarios', sel: 'users-nuevo', adminOnly: true, title: 'Crear usuarios', text: 'Da acceso a tu equipo o a clientes: usuario normal (solo su conexión) o admin. Y decide si puede gestionar su agente o «solo mensajes» (ve conversaciones pero no toca la configuración).' },
    { route: '/usuarios', sel: 'users-panel', adminOnly: true, title: 'Usuarios del panel', text: 'Los accesos con contraseña: cambia su conexión, alterna entre gestionar agente o solo mensajes, restablece contraseñas o elimínalos.' },
    { route: '/usuarios', sel: 'users-portal', adminOnly: true, title: 'Accesos desde GHL', text: 'Quienes entran por el enlace del menú de GHL, sin contraseña: su identidad la certifica GoHighLevel. Aquí ves quién ha entrado y puedes revocar accesos.' },
    { route: '/usuarios', sel: 'users-tour', adminOnly: true, title: 'Progreso del tutorial', text: 'Y aquí ves quién ha hecho este mismo tutorial y hasta dónde llegó cada usuario, con su porcentaje. 100% = lo terminó.' },

    // ── Cierre ──
    { sel: null, title: '¡Eso es todo! 🎉', text: ctx.hasAgentes
        ? `Ya conoces el sistema COMPLETO. El orden para arrancar: ${isAdmin ? 'API de IA → conexión → setter (prompt con el arquitecto) → pruébalo → modo test → a producción' : 'entra en «Mis agentes», configura tu asistente con el arquitecto y pruébalo antes de soltarlo'}. Y si te pierdes, el botón «Tutorial» está siempre abajo a la izquierda.`
        : 'Ya conoces el panel. Explora tus Conversaciones y el Archivo: todo lo que pasa con tus clientes queda ahí. Y si te pierdes, el botón «Tutorial» está siempre abajo a la izquierda.' },
  ];
}

export function Tour({ me, onClose }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [steps, setSteps] = useState(null); // null = resolviendo ids reales
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const dirRef = useRef(1);        // dirección de viaje: si un objetivo no aparece, se salta hacia ahí
  const navForRef = useRef(-1);    // paso para el que navegamos: su re-ejecución conserva la espera larga
  const askedRef = useRef(false);  // el confirm inicial solo una vez (StrictMode lo montaría doble en dev)
  const maxRef = useRef(0);        // paso máximo alcanzado (para el % que ve el admin)
  const cardRef = useRef(null);
  const step = steps?.[i];
  const total = steps?.length || 0;

  // arrancar desde una pantalla de detalle (p. ej. un setter a medio editar) implica navegar y
  // perder lo no guardado: avisar antes de empezar
  useEffect(() => {
    if (askedRef.current) return;
    askedRef.current = true;
    if (/^\/[^/]+\/.+/.test(window.location.pathname)
      && !window.confirm('El tutorial te llevará por las secciones del panel y saldrás de esta pantalla (lo que no hayas guardado se perdería). ¿Empezamos?')) {
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // resolver ids REALES para el recorrido por dentro (primera conexión, primer setter, un chat)
  useEffect(() => {
    let alive = true;
    (async () => {
      const ctx = { accountId: null, setterId: null, convId: null, hasAgentes: Boolean(document.querySelector('[data-tour="nav:/cuentas"]')) };
      try {
        const accs = await api.get('/api/accounts');
        if (Array.isArray(accs) && accs.length) {
          ctx.accountId = accs[0].id;
          for (const a of accs) {
            try {
              const sts = await api.get(`/api/accounts/${a.id}/setters`);
              if (Array.isArray(sts) && sts.length) { ctx.accountId = a.id; ctx.setterId = sts[0].id; break; }
            } catch { /* siguiente */ }
          }
        }
      } catch { /* sin cuentas */ }
      try {
        const convs = await api.get('/api/conversations');
        if (Array.isArray(convs) && convs.length) ctx.convId = convs[0].id;
      } catch { /* sin chats */ }
      if (!alive) return;
      setSteps(
        buildSteps(me, ctx)
          .filter((s) => {
            const gate = s.gate || s.route;
            return !gate || document.querySelector(`[data-tour="nav:${gate}"]`);
          })
          .filter((s) => !s.adminOnly || me?.role === 'admin')
      );
    })();
    return () => { alive = false; };
  }, [me]);

  useEffect(() => { cardRef.current?.focus(); }, [i]);

  // progreso al servidor: solo el máximo, en segundo plano
  useEffect(() => {
    if (!total) return;
    if (i + 1 > maxRef.current) {
      maxRef.current = i + 1;
      api.post('/api/tour/progress', { paso: i + 1, total }).catch(() => {});
    }
  }, [i, total]);

  const finish = (completado) => {
    if (completado && total) api.post('/api/tour/progress', { paso: total, total, terminado: true }).catch(() => {});
    onClose();
  };

  // localizar el objetivo: navegar a su página, abrir su pestaña (click) y esperar a que exista.
  // Si no aparece (elemento de otro rol, función desactivada, lista vacía…), se salta el paso solo.
  useEffect(() => {
    if (!step) return;
    if (!step.sel) { setRect(null); return; }
    let cancelled = false;
    const needNav = step.route && location.pathname !== step.route;
    if (needNav) { navForRef.current = i; navigate(step.route); }
    // Recién navegado, la página puede estar en «Cargando…» (hasta ~5s); si ya estábamos, ~1.6s.
    // OJO: navigate() cambia location.pathname (está en las deps) y este efecto se RE-EJECUTA con
    // needNav=false — navForRef recuerda que este paso navegó para conservar la espera larga.
    const maxTries = (needNav || navForRef.current === i) ? 25 : 8;
    setRect(null);
    let tries = 0;
    const measure = (el) => {
      const r = el.getBoundingClientRect();
      if (!cancelled) setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    const tick = () => {
      if (cancelled) return;
      // pestañas: si el paso vive dentro de una, pulsarla hasta que su contenido exista
      if (step.click && !document.querySelector(`[data-tour="${step.sel}"]`)) {
        document.querySelector(`[data-tour="${step.click}"]`)?.click();
      }
      const el = document.querySelector(`[data-tour="${step.sel}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        requestAnimationFrame(() => {
          if (cancelled) return;
          const el2 = document.querySelector(`[data-tour="${step.sel}"]`);
          if (el2) measure(el2);
        });
        return;
      }
      if (++tries > maxTries) {
        if (!cancelled) setI((x) => Math.max(0, Math.min(total - 1, x + dirRef.current)));
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
    const onResize = () => {
      const el = document.querySelector(`[data-tour="${step.sel}"]`);
      if (el) measure(el);
    };
    window.addEventListener('resize', onResize);
    // la página sigue cargando datos tras la navegación y el objetivo puede desplazarse: re-medir suave
    const iv = setInterval(onResize, 600);
    return () => { cancelled = true; clearInterval(iv); window.removeEventListener('resize', onResize); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, step, total, location.pathname]);

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') finish(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // preparando: resolviendo los ids reales del recorrido
  if (!steps) {
    return (
      <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label="Tutorial">
        <div className="absolute inset-0 bg-black/60" />
        <div className="fixed left-1/2 top-1/2 w-72 -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 text-center shadow-2xl">
          <div className="mb-2 text-2xl">🧭</div>
          <p className="text-sm font-semibold text-slate-700">Preparando el recorrido…</p>
        </div>
      </div>
    );
  }
  if (!step) return null;
  const last = i === total - 1;

  // Colocación de la tarjeta: a la derecha del foco si cabe (menú lateral); si el foco es ancho
  // (títulos, tarjetas), debajo — o encima si no hay sitio. La flecha SIEMPRE apunta al objetivo.
  let cardStyle;
  let arrow = null; // { side: 'left'|'top'|'bottom', offset }
  if (rect) {
    const spaceRight = window.innerWidth - (rect.left + rect.width);
    if (spaceRight >= CARD_W + 30) {
      const top = Math.max(12, Math.min(rect.top - 8, window.innerHeight - 260));
      cardStyle = { position: 'fixed', left: rect.left + rect.width + 18, top, width: CARD_W };
      arrow = { side: 'left', offset: Math.max(10, Math.min(rect.top + rect.height / 2 - top - 6, 210)) };
    } else {
      const left = Math.max(12, Math.min(rect.left + 8, window.innerWidth - CARD_W - 12));
      const below = rect.top + rect.height + 14;
      if (below + 250 <= window.innerHeight) {
        cardStyle = { position: 'fixed', left, top: below, width: CARD_W };
        arrow = { side: 'top', offset: Math.max(14, Math.min(rect.left + rect.width / 2 - left - 6, CARD_W - 26)) };
      } else {
        cardStyle = { position: 'fixed', left, top: Math.max(12, rect.top - 250), width: CARD_W };
        arrow = { side: 'bottom', offset: Math.max(14, Math.min(rect.left + rect.width / 2 - left - 6, CARD_W - 26)) };
      }
    }
  } else {
    cardStyle = { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 360 };
  }

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label="Tutorial">
      {/* capa que bloquea clics; el "foco" se recorta con una sombra gigante alrededor del elemento */}
      {rect ? (
        <>
          <div className="absolute inset-0" onClick={() => {}} />
          <div
            className="pointer-events-none fixed rounded-xl transition-all duration-300"
            style={{
              left: rect.left - PAD,
              top: rect.top - PAD,
              width: rect.width + PAD * 2,
              height: rect.height + PAD * 2,
              boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.62)',
            }}
          />
        </>
      ) : (
        <div className="absolute inset-0 bg-black/60" />
      )}

      <div ref={cardRef} tabIndex={-1} style={cardStyle} className="rounded-2xl bg-white p-4 shadow-2xl outline-none">
        {arrow && (
          <span
            className="absolute block h-3 w-3 rotate-45 bg-white"
            style={arrow.side === 'left'
              ? { left: -6, top: arrow.offset }
              : arrow.side === 'top'
                ? { top: -6, left: arrow.offset }
                : { bottom: -6, left: arrow.offset }}
            aria-hidden="true"
          />
        )}
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900">{step.title}</h3>
          <span className="text-[11px] font-medium text-slate-400">{i + 1} / {total}</span>
        </div>
        <p className="text-[13px] leading-relaxed text-slate-600">{step.text}</p>
        <div className="mt-3 flex items-center gap-2">
          {i > 0 && (
            <button onClick={() => { dirRef.current = -1; setI(i - 1); }} className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
              Anterior
            </button>
          )}
          <button
            onClick={() => { if (last) { finish(true); } else { dirRef.current = 1; setI(i + 1); } }}
            className="rounded-xl bg-violet-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-violet-700"
          >
            {last ? 'Terminar' : 'Siguiente'}
          </button>
          {!last && (
            <button onClick={() => finish(false)} className="ml-auto text-[11px] font-medium text-slate-400 hover:text-slate-600">
              Finalizar tutorial
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Aviso de primera visita: pregunta UNA vez si quiere hacer el tutorial (nunca es obligatorio).
export function TourInvite({ onStart, onDismiss }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 text-center shadow-2xl">
        <div className="mb-2 text-3xl">🧭</div>
        <h3 className="mb-1 text-sm font-bold text-slate-900">¿Te enseñamos el panel?</h3>
        <p className="mb-4 text-[13px] leading-relaxed text-slate-600">
          Hay un tutorial guiado que recorre TODO el sistema contigo — cada sección y cada botón — con palabras sencillas. ¿Quieres verlo ahora?
        </p>
        <div className="flex justify-center gap-2">
          <button onClick={onStart} className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700">Sí, empezar</button>
          <button onClick={onDismiss} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">Ahora no</button>
        </div>
        <p className="mt-3 text-[11px] text-slate-400">Podrás verlo cuando quieras desde el botón «Tutorial» del menú.</p>
      </div>
    </div>
  );
}
