import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, MessagesSquare, Tags, Building2, Plug, FlaskConical, Settings, UserRound, LogOut, Zap } from 'lucide-react';
import { api } from '../api.js';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/conversaciones', label: 'Conversaciones', icon: MessagesSquare },
  { to: '/etiquetas', label: 'Etiquetas', icon: Tags },
  { to: '/cuentas', label: 'Cuentas', icon: Building2 },
  { to: '/apis', label: 'APIs de IA', icon: Plug },
  { to: '/prueba', label: 'Probar agente', icon: FlaskConical },
];

const NAV_BOTTOM = [
  { to: '/configuracion', label: 'Configuración', icon: Settings },
  { to: '/usuario', label: 'Usuario', icon: UserRound },
];

function NavItem({ to, label, icon: Icon, end }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition ${
          isActive ? 'bg-violet-50 text-violet-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
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
  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-20 flex w-60 flex-col border-r border-slate-200 bg-white px-4 py-5">
        <div className="mb-8 flex items-center gap-2.5 px-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600 text-white shadow-sm">
            <Zap size={18} strokeWidth={2.5} />
          </span>
          <div>
            <div className="text-[15px] font-bold tracking-tight text-slate-900">Hermes</div>
            <div className="text-[11px] font-medium text-slate-400 -mt-0.5">Setter IA</div>
          </div>
        </div>
        <nav className="flex flex-col gap-1">{NAV.map((n) => <NavItem key={n.to} {...n} />)}</nav>
        <div className="mt-auto flex flex-col gap-1 border-t border-slate-100 pt-4">
          {NAV_BOTTOM.map((n) => <NavItem key={n.to} {...n} />)}
          <button
            onClick={async () => { await api.post('/api/auth/logout'); navigate('/login'); }}
            className="flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
          >
            <LogOut size={18} /> Salir
          </button>
        </div>
      </aside>
      <main className="ml-60 flex-1 px-8 py-8">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
