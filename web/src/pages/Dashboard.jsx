import { Link, useNavigate } from 'react-router-dom';
import { MessagesSquare, Wallet, CalendarCheck, ShoppingBag, Eye } from 'lucide-react';
import { useMe } from '../components/Layout.jsx';
import { ComposedChart, Area, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { timeAgo, fmtMonedas } from '../api.js';
import { Card, SectionTitle, StatCard, StagePill, Avatar } from '../components/ui.jsx';
import { StatusDonut } from '../components/StatusDonut.jsx';
import { useDashData, DashCuenta, DashRango, fmtUsd, useIsDark } from '../components/DashComun.jsx';

// 📊 Dashboard = RESUMEN: solo lo que importa de un vistazo (conversaciones, agendas, ventas, gasto), la torta de
// status y la evolución de lo que se persigue. Todo lo demás (status uno por uno, mensajes, comentarios, gasto por
// tipo, tabla por setter) vive en la hoja de detalle, que se abre con el ojito.
export default function Dashboard() {
  const me = useMe();
  const d = useDashData();
  const navigate = useNavigate();
  const dark = useIsDark();
  const detalleHref = `/dashboard/detalle${d.qs ? `?${d.qs}` : ''}`;

  if (!d.data) return <div className="py-24 text-center text-sm text-slate-400">Cargando…</div>;
  const t = d.data.totals || {};
  // mismos tonos que la torta: nuevos (violeta), agendas (azul), ventas (verde)
  const C = dark ? { nuevos: '#9085e9', agendas: '#3987e5', ventas: '#008300' } : { nuevos: '#4a3aa7', agendas: '#2a78d6', ventas: '#008300' };

  return (
    <div>
      <SectionTitle tour="page:dash" title="Dashboard" subtitle={`Resumen del ${d.rango}`} actions={<DashCuenta d={d} me={me} />} />
      <DashRango d={d} />

      <div data-tour="dash-stats" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Conversaciones nuevas" value={t.nuevas ?? 0} sub={`${t.conversaciones_total ?? 0} en total`} icon={MessagesSquare} tone="violet" />
        <StatCard label="Agendas" value={t.agendas ?? 0} sub={`${t.canceladas ?? 0} canceladas`} icon={CalendarCheck} tone="blue" />
        <StatCard label="Ventas" value={t.ventas ?? 0} sub={fmtMonedas(t.ingresos_por_moneda) || 'sin ingresos'} icon={ShoppingBag} tone="emerald" />
        {me?.role === 'admin'
          ? <StatCard label="Costo IA" value={fmtUsd(t.gasto)} sub={`facturado ${fmtUsd(t.facturado)} · clic: desglose`} icon={Wallet} tone="violet" onClick={() => navigate(`${detalleHref}#gasto`)} />
          : <StatCard label="Gasto IA" value={fmtUsd(t.facturado ?? t.gasto)} sub="consumo de IA del periodo" icon={Wallet} tone="violet" />}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <StatusDonut byStage={d.data.byStage} detalleHref={detalleHref} className="lg:col-span-2" />

        <Card data-tour="dash-grafica" className="p-5 lg:col-span-3">
          <h3 className="text-sm font-semibold text-slate-700">Evolución · {d.rango}</h3>
          <p className="mb-2 text-xs text-slate-400">Leads que entran cada día y lo que se consigue con ellos (cada uno con su escala).</p>
          <div className="text-[11px] font-semibold text-slate-500">Leads nuevos</div>
          <div className="h-28">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={d.data.daily || []} syncId="evolucion" margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={dark ? '#2e323a' : '#f1f5f9'} vertical={false} />
                <XAxis dataKey="dia" hide />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} allowDecimals={false} width={40} />
                <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                <Area type="monotone" dataKey="leads_nuevos" name="Leads nuevos" stroke={C.nuevos} strokeWidth={2} fill={C.nuevos} fillOpacity={0.12} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 text-[11px] font-semibold text-slate-500">Agendas y ventas</div>
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={d.data.daily || []} syncId="evolucion" margin={{ top: 4, right: 8, left: -20, bottom: 0 }} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke={dark ? '#2e323a' : '#f1f5f9'} vertical={false} />
                <XAxis dataKey="dia" tick={{ fontSize: 11, fill: '#94a3b8' }} tickFormatter={(x) => x.slice(5)} axisLine={false} tickLine={false} minTickGap={20} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} allowDecimals={false} width={40} />
                <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} cursor={{ fill: dark ? '#23262d' : '#f8fafc' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} />
                <Bar dataKey="agendas" name="Agendas" fill={C.agendas} radius={[4, 4, 0, 0]} maxBarSize={10} />
                <Bar dataKey="ventas" name="Ventas" fill={C.ventas} radius={[4, 4, 0, 0]} maxBarSize={10} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <Card className="mt-4 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">Actividad reciente</h3>
          <Link to={detalleHref} className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-600 hover:underline"><Eye size={14} /> Ver todo el detalle</Link>
        </div>
        {(d.data.recientes || []).length === 0 && <p className="py-8 text-center text-sm text-slate-400">Aún no hay conversaciones</p>}
        <div className="grid gap-1 md:grid-cols-2">
          {(d.data.recientes || []).map((c) => (
            <Link key={c.id} to={`/conversaciones/${c.id}`} className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-slate-50">
              <Avatar name={c.lead_name || c.channel} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-slate-800">{c.lead_name || 'Lead sin nombre'}</span>
                  <span className="text-[11px] text-slate-400">{timeAgo(c.updated_at)}</span>
                </div>
                <p className="truncate text-xs text-slate-500">{c.last_message || '—'}</p>
              </div>
              <StagePill stage={c.stage} />
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}
