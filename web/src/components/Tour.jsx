import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

// 🧭 Tutorial guiado COMPLETO: recorre todo el sistema sección por sección (navega solo entre
// páginas), oscurece la pantalla y deja un "foco" sobre cada elemento con su explicación en
// palabras sencillas. Los objetivos se marcan con data-tour; los pasos se filtran por rol mirando
// qué items del menú existen. El progreso (paso máximo alcanzado) se reporta al servidor para que
// el admin vea el % de cada usuario en la sección Usuarios.

const PAD = 6; // aire alrededor del elemento enfocado
const CARD_W = 330;

function buildSteps(me, hasAgentes) {
  const isAdmin = me?.role === 'admin';
  const cuentas = isAdmin ? 'Conexiones' : 'Mis agentes';
  return [
    // ── Bienvenida ──
    { sel: 'tour-btn', title: 'Este recorrido, siempre a mano', text: 'Desde este botón puedes volver a ver el tutorial cuando quieras: no hace falta memorizar nada. Vamos a recorrer TODO el sistema, sección por sección — el propio tutorial te irá llevando de página en página.' },

    // ── Dashboard ──
    { route: '/', sel: 'page:dash', title: 'Dashboard', text: 'Tu resumen general: cuántas personas han escrito, mensajes enviados y recibidos, citas agendadas y la actividad de cada día.' },
    { route: '/', sel: 'dash-rango', title: 'Elige el periodo', text: 'Con estos botones cambias el rango de fechas (hoy, 7, 30 o 90 días). Todo lo que ves abajo se recalcula para ese periodo.' },

    // ── Paso 1 (admin): APIs ──
    { route: '/apis', sel: 'page:apis', title: 'Para montar el sistema, paso 1: APIs de IA', text: 'Aquí conectas los «cerebros» que usarán tus asistentes. Pegas la clave de tu proveedor (OpenRouter, por ejemplo), marcas para qué sirve (texto, ver fotos, escuchar audios) y defines su costo y el precio que cobras.' },
    { route: '/apis', sel: 'page:apis', title: 'Disponible para usuarios', text: 'Si marcas una API como «disponible para usuarios», tus clientes podrán elegirla para su asistente sin ver tu clave ni tus costes. Al menos una debe estar marcada para que ellos puedan configurar su IA.' },

    // ── Paso 2: Conexiones / Mis agentes ──
    { route: '/cuentas', sel: 'page:cuentas', title: `Paso 2: ${cuentas}`, text: 'La pieza central. Cada conexión es una cuenta de GoHighLevel, y dentro viven tus setters: los asistentes que chatean por ti con los leads.' },
    { route: '/cuentas', sel: 'cuentas-acciones', title: 'Crear conexión y setter', text: isAdmin
        ? 'Con «Nueva conexión» enlazas una cuenta de GHL (te guía para instalar la app y pegar los webhooks). Con «Nuevo setter» creas al asistente que chateará dentro de esa conexión.'
        : 'Con «Nuevo setter» creas un asistente dentro de tu conexión. Para añadir otra subcuenta de GHL, abre Hermes desde esa subcuenta y se conecta sola.' },
    { route: '/cuentas', sel: 'page:cuentas', title: 'Dentro de un setter', text: 'Al entrar en un setter verás sus pestañas: el PROMPT (quién es y qué dice), COMPORTAMIENTO (tiempos de respuesta, canales, horario), IA (qué cerebro usa), ACTIVACIONES (que entre a hablar cuando tú pongas una etiqueta en GHL, con instrucciones propias) y SEGUIMIENTOS (reenganchar al lead si deja de contestar).' },
    { route: '/cuentas', sel: 'page:cuentas', title: 'Modo prueba, antes de soltarlo', text: 'Cada setter puede tener una etiqueta de prueba: mientras esté en modo test, SOLO hablará con contactos que tengan esa etiqueta en GHL. Así lo ensayas con tu propio número sin tocar leads reales.' },

    // ── Paso 3: Probar agente ──
    { route: '/prueba', sel: 'page:prueba', title: 'Paso 3: pruébalo aquí', text: 'Chatea con tu asistente como si fueras un cliente, sin gastar leads reales. Cada conversación de prueba se guarda a la izquierda para retomarla cuando quieras.' },
    { route: '/prueba', sel: 'page:prueba', title: 'Corrígelo con tus palabras', text: '¿Una respuesta no te gustó? Pulsa corregir y dile el cambio como se lo dirías a un empleado («no ofrezcas descuento tan pronto»). El sistema reescribe el prompt solo y guarda cada versión.' },

    // ── Paso 4: verlo trabajar ──
    { route: '/conversaciones', sel: 'page:conv', title: 'Paso 4: míralo trabajar', text: 'Todos los chats reales con tus clientes potenciales, en tiempo real: qué dijo el lead, qué respondió el asistente y en qué punto va cada uno.' },
    { route: '/conversaciones', sel: 'conv-filtros', title: 'Encuentra cualquier chat', text: 'Busca por nombre o correo, o filtra por conexión, por asistente o por etapa. También puedes ver solo las conversaciones donde intervino un humano.' },
    { route: '/conversaciones', sel: 'page:conv', title: 'Dentro de un chat', text: 'Entra en cualquiera para leerlo completo, pausar al asistente o escribir tú en persona. Y tranquilidad: si alguien de tu equipo contesta desde GHL o desde el móvil, el asistente se aparta solo.' },

    // ── Etiquetas ──
    { route: '/etiquetas', sel: 'page:tags', title: 'Etiquetas', text: 'El tablero de leads: el asistente los clasifica solo (nuevo, en conversación, calificado, agendado…) y aquí los ves ordenados por columnas, como un embudo. Puedes mover cualquier tarjeta a mano.' },

    // ── Archivo ──
    { route: '/archivo', sel: 'page:archivo', title: 'Archivo', text: 'El historial completo de TODO lo que entra y sale: mensajes del asistente, de humanos y de automatizaciones, y también los comentarios de Instagram.' },
    { route: '/archivo', sel: 'archivo-filtros', title: 'Filtros y descarga', text: 'Filtra por canal (WhatsApp, Instagram…) o por quién envió cada mensaje (asistente, humano o automatización), y descárgalo todo a Excel cuando lo necesites.' },

    // ── Versus ──
    { route: '/versus', sel: 'page:versus', title: 'Versus', text: 'Pon a competir a dos asistentes con leads reales: el sistema reparte los leads entre ambos y te dice cuál agenda más. Ideal para probar dos formas de vender.' },

    // ── Errores ──
    { route: '/errores', sel: 'page:errores', title: 'Reportar error', text: '¿Algo falló? Cuéntanoslo aquí con una captura si quieres. Te respondemos dentro del propio reporte, y verás cuándo queda resuelto.' },

    // ── Configuración (admin) ──
    { route: '/configuracion', sel: 'page:config', title: 'Configuración', text: 'Los ajustes generales del sistema: la conexión con GoHighLevel (la app y sus webhooks), los prompts maestros del arquitecto y el corrector, y el registro de eventos para ver todo lo que llega.' },

    // ── Usuarios ──
    { route: '/usuarios', sel: 'page:usuarios', title: 'Usuarios', text: 'Crea accesos para tu equipo o tus clientes y decide qué puede tocar cada uno: gestionar su agente o solo ver los mensajes.' },
    { route: '/usuarios', sel: 'users-tour', adminOnly: true, title: 'Progreso del tutorial', text: 'Y aquí ves quién ha hecho este mismo tutorial y hasta dónde llegó cada usuario, con su porcentaje.' },

    // ── Cierre ──
    { sel: null, title: '¡Eso es todo! 🎉', text: hasAgentes
        ? `Ya conoces el sistema completo. El orden para arrancar: ${isAdmin ? 'API de IA → conexión → setter → pruébalo → modo test → a producción' : 'entra en «Mis agentes», configura tu asistente y pruébalo antes de soltarlo'}. Y si te pierdes, el botón «Tutorial» está siempre abajo a la izquierda.`
        : 'Ya conoces el panel. Explora tus Conversaciones y el Archivo: todo lo que pasa con tus clientes queda ahí. Y si te pierdes, el botón «Tutorial» está siempre abajo a la izquierda.' },
  ];
}

export function Tour({ me, onClose }) {
  const navigate = useNavigate();
  const location = useLocation();
  // pasos del rol: un paso con ruta solo entra si su sección existe en el menú de este usuario
  const steps = useMemo(
    () => buildSteps(me, Boolean(document.querySelector('[data-tour="nav:/cuentas"]')))
      .filter((s) => !s.route || document.querySelector(`[data-tour="nav:${s.route}"]`))
      .filter((s) => !s.adminOnly || me?.role === 'admin'),
    [me]
  );
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const dirRef = useRef(1);        // dirección de viaje: si un objetivo no aparece, se salta hacia ahí
  const cardRef = useRef(null);
  const maxRef = useRef(0);        // paso máximo alcanzado (para el % que ve el admin)
  const step = steps[i];
  const total = steps.length;

  // arrancar desde una pantalla de detalle (p. ej. un setter a medio editar) implica navegar y
  // perder lo no guardado: avisar antes de empezar
  useEffect(() => {
    if (/^\/[^/]+\/.+/.test(window.location.pathname)
      && !window.confirm('El tutorial te llevará por las secciones del panel y saldrás de esta pantalla (lo que no hayas guardado se perdería). ¿Empezamos?')) {
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { cardRef.current?.focus(); }, [i]);

  // progreso al servidor: solo el máximo, en segundo plano
  useEffect(() => {
    if (i + 1 > maxRef.current) {
      maxRef.current = i + 1;
      api.post('/api/tour/progress', { paso: i + 1, total }).catch(() => {});
    }
  }, [i, total]);

  const finish = (completado) => {
    if (completado) api.post('/api/tour/progress', { paso: total, total, terminado: true }).catch(() => {});
    onClose();
  };

  // localizar el objetivo: navegar a su página si hace falta y esperar a que exista.
  // Si tras ~3s no aparece (elemento de otro rol, sección vacía…), se salta el paso solo.
  useEffect(() => {
    if (!step) return;
    if (!step.sel) { setRect(null); return; }
    let cancelled = false;
    if (step.route && location.pathname !== step.route) navigate(step.route);
    setRect(null);
    let tries = 0;
    const measure = (el) => {
      const r = el.getBoundingClientRect();
      if (!cancelled) setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    const tick = () => {
      if (cancelled) return;
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
      if (++tries > 25) { // ~5s: la página puede estar en «Cargando…» tras navegar
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

  if (!step) return null;
  const last = i === total - 1;

  // Colocación de la tarjeta: a la derecha del foco si cabe (menú lateral); si el foco es ancho
  // (títulos de página), debajo — o encima si no hay sitio. La flecha SIEMPRE apunta al objetivo.
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
          Hay un tutorial guiado que recorre todo el sistema contigo, sección por sección, con palabras sencillas. ¿Quieres verlo ahora?
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
