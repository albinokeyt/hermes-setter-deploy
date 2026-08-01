import { useEffect, useMemo, useState } from 'react';

// 🧭 Tutorial guiado: oscurece todo, deja un "foco" sobre el elemento señalado y explica en palabras
// sencillas qué es cada cosa. Hecho a medida (sin librerías): los objetivos se marcan con data-tour.

const PAD = 6; // aire alrededor del elemento enfocado

function buildSteps(me, hasAgentes) {
  const isAdmin = me?.role === 'admin';
  return [
    { sel: 'tour-btn', title: 'Este recorrido, siempre a mano', text: 'Desde este botón puedes volver a ver el tutorial cuando quieras. No hace falta memorizar nada.' },
    { sel: 'nav:/', title: 'Dashboard', text: 'Tu resumen general: cuántas personas han escrito, mensajes enviados y recibidos, agendas y la actividad de cada día.' },
    { sel: 'nav:/conversaciones', title: 'Conversaciones', text: 'Todos los chats con tus clientes potenciales. Entra en cualquiera para leerlo, pausar al asistente o escribir tú en persona.' },
    { sel: 'nav:/etiquetas', title: 'Etiquetas', text: 'El tablero de clientes: el asistente los va clasificando (nuevo, calificado, agendado…) y aquí los ves ordenados por columnas.' },
    { sel: 'nav:/cuentas', title: isAdmin ? 'Conexiones' : 'Mis agentes', text: 'La pieza central. Cada conexión es una cuenta de GoHighLevel, y dentro viven tus setters: los asistentes que chatean por ti. Aquí decides qué dicen, cómo se comportan y cuándo entran a hablar.' },
    { sel: 'nav:/versus', title: 'Versus', text: 'Pon a competir a dos asistentes con clientes reales y descubre cuál funciona mejor.' },
    { sel: 'nav:/apis', title: 'APIs de IA', text: 'Aquí conectas los «cerebros» (los modelos de inteligencia artificial) que usarán tus asistentes, con su costo y el precio que cobras.' },
    { sel: 'nav:/prueba', title: 'Probar agente', text: 'Chatea con tu asistente como si fueras un cliente. Y si algo no te gusta, pídele el cambio ahí mismo con tus palabras.' },
    { sel: 'nav:/archivo', title: 'Archivo', text: 'El historial completo: todos los mensajes y comentarios, con filtros por canal y por quién los envió, y descarga a Excel.' },
    { sel: 'nav:/errores', title: 'Reportar error', text: '¿Algo falló? Cuéntanoslo aquí (puedes adjuntar una captura de pantalla) y te respondemos dentro del propio reporte.' },
    { sel: 'nav:/configuracion', title: 'Configuración', text: 'Los ajustes generales del sistema: la conexión con GoHighLevel, los prompts maestros y el registro de eventos.' },
    { sel: 'nav:/usuarios', title: 'Usuarios', text: 'Gestiona quién puede entrar al panel y qué puede tocar cada persona.' },
    { sel: null, title: '¡Eso es todo! 🎉', text: hasAgentes
        ? `Ya conoces el panel. Un buen primer paso: entra en ${isAdmin ? '«Conexiones»' : '«Mis agentes»'} y configura tu primer asistente. Y si te pierdes, el botón «Tutorial» está siempre abajo a la izquierda.`
        : 'Ya conoces el panel. Explora tus Conversaciones y el Archivo: todo lo que pasa con tus clientes queda ahí. Y si te pierdes, el botón «Tutorial» está siempre abajo a la izquierda.' },
  ];
}

export function Tour({ me, onClose }) {
  // solo los pasos cuyo elemento existe en pantalla (cada rol ve secciones distintas)
  const steps = useMemo(
    () => buildSteps(me, Boolean(document.querySelector('[data-tour="nav:/cuentas"]')))
      .filter((s) => !s.sel || document.querySelector(`[data-tour="${s.sel}"]`)),
    [me]
  );
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const step = steps[i];

  useEffect(() => {
    const measure = () => {
      if (!step?.sel) { setRect(null); return; }
      const el = document.querySelector(`[data-tour="${step.sel}"]`);
      if (!el) { setRect(null); return; }
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [step]);

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  if (!step) return null;
  const last = i === steps.length - 1;

  // tarjeta: a la derecha del foco (el menú vive a la izquierda); centrada si no hay foco.
  // El top se clampa (los botones del fondo del menú subirían la tarjeta fuera de pantalla), así que
  // la FLECHA se calcula respecto al OBJETIVO, no fija: siempre apunta al elemento enfocado.
  const cardTop = rect ? Math.max(12, Math.min(rect.top - 8, window.innerHeight - 240)) : 0;
  const arrowTop = rect ? Math.max(10, Math.min(rect.top + rect.height / 2 - cardTop - 6, 196)) : 0;
  const cardStyle = rect
    ? {
        position: 'fixed',
        left: Math.min(rect.left + rect.width + 18, window.innerWidth - 340),
        top: cardTop,
        width: 320,
      }
    : { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 360 };

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-label="Tutorial">
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

      <div style={cardStyle} className="rounded-2xl bg-white p-4 shadow-2xl">
        {rect && (
          <span
            className="absolute -left-1.5 block h-3 w-3 rotate-45 bg-white"
            style={{ top: arrowTop }}
            aria-hidden="true"
          />
        )}
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900">{step.title}</h3>
          <span className="text-[11px] font-medium text-slate-400">{i + 1} / {steps.length}</span>
        </div>
        <p className="text-[13px] leading-relaxed text-slate-600">{step.text}</p>
        <div className="mt-3 flex items-center gap-2">
          {i > 0 && (
            <button onClick={() => setI(i - 1)} className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
              Anterior
            </button>
          )}
          <button
            onClick={() => (last ? onClose() : setI(i + 1))}
            className="rounded-xl bg-violet-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-violet-700"
          >
            {last ? 'Terminar' : 'Siguiente'}
          </button>
          {!last && (
            <button onClick={onClose} className="ml-auto text-[11px] font-medium text-slate-400 hover:text-slate-600">
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
          Hay un tutorial guiado que te muestra qué es cada cosa, en un par de minutos y con palabras sencillas. ¿Quieres verlo ahora?
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
