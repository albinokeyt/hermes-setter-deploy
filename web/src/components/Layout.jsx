import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, MessagesSquare, Tags, Building2, Plug, FlaskConical, Settings, UsersRound, LogOut, Bot, Database, Swords, Bug, Compass } from 'lucide-react';
import { api } from '../api.js';
import { ThemeToggle } from './ui.jsx';
import { Tour, TourInvite } from './Tour.jsx';

const AuthContext = createContext(null);
export function useMe() {
  return useContext(AuthContext);
}

function NavItem({ to, label, icon: Icon, end }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition ${
          isActive
            ? 'bg-violet-50 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
        }`
      }
    >
      <Icon size={18} strokeWidth={2} />
      {label}
    </NavLink>
  );
}

function RenameModal({ me, onClose, onSaved }) {
  const [val, setVal] = useState(me.account_name || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    const v = val.trim();
    const label = v || 'el nombre técnico';
    if (!window.confirm(`¿Poner «${label}» como nombre visible de tu panel?`)) return;
    if (!window.confirm(`Confírmalo de nuevo: se mostrará «${label}».`)) return;
    setSaving(true); setErr('');
    try { await api.put(`/api/accounts/${me.account_id}/alias`, { alias: v }); onSaved(); }
    catch (e) { setErr(e.message); setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-bold text-slate-800">🏷️ Nombre visible de tu panel</h3>
        <p className="mt-1 text-xs text-slate-400">Ponle un nombre que reconozcas. Es solo visual; no afecta a la conexión con GHL. Vacío = nombre técnico.</p>
        <input autoFocus value={val} onChange={(e) => setVal(e.target.value)}
          className="mt-3 w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-violet-400" placeholder="Ej. Despierta en Pareja" />
        {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl px-3.5 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-100">Cancelar</button>
          <button onClick={save} disabled={saving} className="rounded-xl bg-violet-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50">{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </div>
    </div>
  );
}

export default function Layout() {
  const navigate = useNavigate();
  const [me, setMe] = useState(null);
  const [renaming, setRenaming] = useState(false);
  // 🧭 Tutorial guiado: la PRIMERA vez se ofrece (nunca obligatorio); después vive en el botón del menú.
  const [tourOpen, setTourOpen] = useState(false);
  const [tourInvite, setTourInvite] = useState(false);

  useEffect(() => {
    api.get('/api/auth/me').then((m) => {
      setMe(m);
      const key = `hermes_tour_v1_${m?.username || m?.account_id || 'x'}`;
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, '1'); // se pregunta UNA sola vez
        setTourInvite(true);
      }
    }).catch(() => {});
  }, []);

  if (!me) return <div className="py-24 text-center text-sm text-slate-400">Cargando…</div>;

  const isAdmin = me.role === 'admin';
  // Vista "solo mensajes": IA apagada en la conexión (SaaS) o usuario limitado. Oculta TODO lo de
  // IA (Mis agentes, Versus, Probar agente, y el "hablar con la IA" del Archivo). Los mensajes,
  // conversaciones, etiquetas y el Archivo (entrantes/salientes/comentarios/descargar) SÍ se ven.
  const restricted = !isAdmin && (me.ai_enabled === false || me.can_manage_agents === false);
  const nav = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/conversaciones', label: 'Conversaciones', icon: MessagesSquare },
    { to: '/etiquetas', label: 'Status', icon: Tags },
    ...(isAdmin
      ? [
          { to: '/cuentas', label: 'Conexiones', icon: Building2 },
          { to: '/versus', label: 'Versus', icon: Swords },
          { to: '/apis', label: 'APIs de IA', icon: Plug },
        ]
      : !restricted
        ? [
            { to: '/cuentas', label: 'Mis agentes', icon: Bot },
            { to: '/versus', label: 'Versus', icon: Swords },
          ]
        : []),
    ...(restricted ? [] : [{ to: '/prueba', label: 'Probar agente', icon: FlaskConical }]),
    // Archivo (mensajes entrantes/salientes + comentarios + descargar) NO depende de la IA → siempre visible.
    { to: '/archivo', label: 'Archivo', icon: Database },
    { to: '/errores', label: 'Reportar error', icon: Bug },
  ];
  const navBottom = [
    ...(isAdmin ? [{ to: '/configuracion', label: 'Configuración', icon: Settings }] : []),
    ...(!me.portal ? [{ to: '/usuarios', label: 'Usuarios', icon: UsersRound }] : []),
  ];

  return (
    <AuthContext.Provider value={me}>
      {renaming && me.account_id && (
        <RenameModal me={me} onClose={() => setRenaming(false)} onSaved={() => { setRenaming(false); api.get('/api/auth/me').then(setMe); }} />
      )}
      {tourInvite && (
        <TourInvite
          onStart={() => { setTourInvite(false); setTourOpen(true); }}
          onDismiss={() => setTourInvite(false)}
        />
      )}
      {tourOpen && <Tour me={me} onClose={() => setTourOpen(false)} />}
      <div className="flex min-h-screen">
        <aside className="fixed inset-y-0 left-0 z-20 flex w-60 flex-col border-r border-slate-200 bg-white px-4 py-5">
          <div className="mb-8 flex items-center gap-2.5 px-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600 text-white shadow-sm">
              <Bot size={19} strokeWidth={2.2} />
            </span>
            <div className="flex-1">
              <div className="text-[15px] font-bold tracking-tight text-slate-900">Hermes</div>
              <div className="text-[11px] font-medium text-slate-400 -mt-0.5">
                {me.portal && me.account_id ? (
                  <button onClick={() => setRenaming(true)} className="inline-flex items-center gap-1 hover:text-violet-600" title="Cambiar el nombre visible de tu panel">
                    <span className="truncate max-w-[120px]">{me.account_name || 'Mi panel'}</span>
                    <span className="text-[10px]">✏️</span>
                  </button>
                ) : (me.portal ? me.account_name || 'Portal' : 'Setter IA')}
              </div>
            </div>
            <ThemeToggle className="-mr-1" />
          </div>
          <nav className="flex flex-col gap-1">{nav.map((n) => <div key={n.to} data-tour={`nav:${n.to}`}><NavItem {...n} /></div>)}</nav>
          <div className="mt-auto flex flex-col gap-1 border-t border-slate-100 pt-4">
            {/* 🧭 Tutorial guiado: minimalista, siempre disponible */}
            <button
              data-tour="tour-btn"
              onClick={() => setTourOpen(true)}
              className="flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-violet-600"
            >
              <Compass size={18} /> Tutorial
            </button>
            {navBottom.map((n) => <div key={n.to} data-tour={`nav:${n.to}`}><NavItem {...n} /></div>)}
            {!me.portal && (
              <button
                onClick={async () => { await api.post('/api/auth/logout'); navigate('/login'); }}
                className="flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
              >
                <LogOut size={18} /> Salir
              </button>
            )}
            {me.portal && (
              <div className="px-3.5 py-2 text-[11px] text-slate-400">
                Conectado como {me.username}
              </div>
            )}
          </div>
        </aside>
        <main className="ml-60 flex-1 px-8 py-8">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </AuthContext.Provider>
  );
}
