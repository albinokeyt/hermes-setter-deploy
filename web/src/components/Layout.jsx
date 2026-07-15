import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, MessagesSquare, Tags, Building2, Plug, FlaskConical, Settings, UsersRound, LogOut, Bot, Database, Swords } from 'lucide-react';
import { api } from '../api.js';
import { ThemeToggle } from './ui.jsx';

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

export default function Layout() {
  const navigate = useNavigate();
  const [me, setMe] = useState(null);

  useEffect(() => {
    api.get('/api/auth/me').then(setMe).catch(() => {});
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
    { to: '/etiquetas', label: 'Etiquetas', icon: Tags },
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
  ];
  const navBottom = [
    ...(isAdmin ? [{ to: '/configuracion', label: 'Configuración', icon: Settings }] : []),
    ...(!me.portal ? [{ to: '/usuarios', label: 'Usuarios', icon: UsersRound }] : []),
  ];

  return (
    <AuthContext.Provider value={me}>
      <div className="flex min-h-screen">
        <aside className="fixed inset-y-0 left-0 z-20 flex w-60 flex-col border-r border-slate-200 bg-white px-4 py-5">
          <div className="mb-8 flex items-center gap-2.5 px-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600 text-white shadow-sm">
              <Bot size={19} strokeWidth={2.2} />
            </span>
            <div className="flex-1">
              <div className="text-[15px] font-bold tracking-tight text-slate-900">Hermes</div>
              <div className="text-[11px] font-medium text-slate-400 -mt-0.5">
                {me.portal ? me.account_name || 'Portal' : 'Setter IA'}
              </div>
            </div>
            <ThemeToggle className="-mr-1" />
          </div>
          <nav className="flex flex-col gap-1">{nav.map((n) => <NavItem key={n.to} {...n} />)}</nav>
          <div className="mt-auto flex flex-col gap-1 border-t border-slate-100 pt-4">
            {navBottom.map((n) => <NavItem key={n.to} {...n} />)}
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
