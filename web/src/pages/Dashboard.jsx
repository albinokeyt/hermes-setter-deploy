import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessagesSquare, Flame, ArrowDownToLine, ArrowUpFromLine, Wallet, CalendarCheck, Info } from 'lucide-react';
import { useMe } from '../components/Layout.jsx';
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api, timeAgo } from '../api.js';
import { STAGES, stageByKey } from '../stages.js';
import { Card, SectionTitle, StatCard, StagePill, Avatar, Select, EmptyState } from '../components/ui.jsx';

const fmtUsd = (v) => `$${Number(v || 0).toFixed(2)}`;

export default function Dashboard() {
  const me = useMe();
  const isAdmin = me?.role === 'admin';
  const [data, setData] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');

  useEffect(() => { api.get('/api/accounts').then(setAccounts).catch(() => {}); }, []);
  useEffect(() => {
    api.get(`/api/dashboard${accountId ? `?account_id=${accountId}` : ''}`).then(setData).catch(() => {});
  }, [accountId]);

  if (!data) return <div className="py-24 text-center text-sm text-slate-400">Cargando…</div>;

  const t = data.totals || {};
  const stageCount = Object.fromEntries((data.byStage || []).map((r) => [r.stage, r.total]));
  const tasa = t.conversaciones ? Math.round((t.respondidas / t.conversaciones) * 100) : 0;

  return (
    <div>
      <SectionTitle
        title="Dashboard"
        subtitle="Cómo va el seteo, de un vistazo"
        actions={
          me?.account_id ? null : (
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="!w-52">
              <option value="">Todas las cuentas</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          )
        }
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Conversaciones" value={t.conversaciones ?? 0} sub={`${t.nuevas_24h ?? 0} nuevas en 24 h`} icon={MessagesSquare} tone="violet" />
        <StatCard label="Activas (24 h)" value={t.activas_24h ?? 0} sub={`tasa de respuesta ${tasa}%`} icon={Flame} tone="amber" />
        <StatCard label="Recibidos (24 h)" value={t.recibidos_24h ?? 0} sub="mensajes de leads" icon={ArrowDownToLine} tone="blue" />
        <StatCard label="Enviados (24 h)" value={t.enviados_24h ?? 0} sub="respuestas del setter" icon={ArrowUpFromLine} tone="emerald" />
        <StatCard label="Agendas (30 d)" value={t.agendas_30d ?? 0} sub={`${t.canceladas_30d ?? 0} canceladas`} icon={CalendarCheck} tone="emerald" />
        <StatCard label="Gasto IA (30 d)" value={fmtUsd(t.gasto_30d)} sub={`hoy ${fmtUsd(t.gasto_24h)} · total ${fmtUsd(t.gasto_total)}`} icon={Wallet} tone="violet" />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {STAGES.map((s) => (
          <Link key={s.key} to={`/etiquetas`} className="group">
            <Card className="p-4 transition group-hover:border-violet-300">
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${s.dot}`} />
                <span className="truncate text-xs font-medium text-slate-500">{s.label}</span>
                <span className="ml-auto shrink-0" title={s.desc} onClick={(e) => e.preventDefault()}>
                  <Info size={13} className="text-slate-300 hover:text-slate-500" />
                </span>
              </div>
              <div className="mt-1.5 text-2xl font-bold text-slate-900">{stageCount[s.key] || 0}</div>
            </Card>
          </Link>
        ))}
      </div>

      {(data.gastoPorTipo || []).length > 0 && (
        <Card className="mt-4 p-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Gasto de IA por tipo (últimos 30 días)</h3>
          <div className="flex flex-wrap gap-2">
            {(data.gastoPorTipo || []).map((g) => {
              const label = { reply: 'Chat', seguimiento: 'Seguimientos', vision: 'Imagen (visión)', audio: 'Audio (transcripción)', playground: 'Pruebas' }[g.source] || g.source;
              return (
                <span key={g.source} className="inline-flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-1.5 text-xs">
                  <span className="font-medium text-slate-600">{label}</span>
                  <span className="font-bold text-slate-900">{fmtUsd(g.total)}</span>
                </span>
              );
            })}
          </div>
        </Card>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="p-5 lg:col-span-3">
          <h3 className="mb-4 text-sm font-semibold text-slate-700">Actividad — últimos 14 días</h3>
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data.daily || []} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#c99b34" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#c99b34" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="dia" tick={{ fontSize: 11, fill: '#94a3b8' }} tickFormatter={(d) => d.slice(5)} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} />
                <Area type="monotone" dataKey="recibidos" name="Recibidos" stroke="#b58a2e" strokeWidth={2} fill="url(#gIn)" />
                <Area type="monotone" dataKey="enviados" name="Enviados" stroke="#10b981" strokeWidth={2} fill="url(#gOut)" />
                <Line type="monotone" dataKey="agendas" name="Agendas" stroke="#0d9488" strokeWidth={2.5} dot={{ r: 2.5 }} />
                <Line type="monotone" dataKey="leads_nuevos" name="Leads nuevos" stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 3" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5 lg:col-span-2">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Actividad reciente</h3>
          {(data.recientes || []).length === 0 && <p className="py-8 text-center text-sm text-slate-400">Aún no hay conversaciones</p>}
          <div className="space-y-1">
            {(data.recientes || []).map((c) => (
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

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 className="text-sm font-semibold text-slate-700">Rendimiento por cuenta</h3>
        </div>
        {(data.perAccount || []).length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-400">Crea tu primera cuenta en la sección Cuentas</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400">
                <th className="px-5 py-3 font-medium">Cuenta</th>
                <th className="px-3 py-3 font-medium">Conversaciones</th>
                <th className="px-3 py-3 font-medium">Activas 24 h</th>
                <th className="px-3 py-3 font-medium">En seguimiento</th>
                <th className="px-3 py-3 font-medium">Calificados</th>
                <th className="px-3 py-3 font-medium">En conversión</th>
                <th className="px-3 py-3 font-medium">Gasto 30 d</th>
                <th className="px-5 py-3 font-medium text-right">Bot</th>
              </tr>
            </thead>
            <tbody>
              {(data.perAccount || []).map((a) => (
                <tr key={a.id} className="border-t border-slate-50 hover:bg-slate-50/60">
                  <td className="px-5 py-3 font-semibold text-slate-800">
                    <Link to={`/cuentas/${a.id}`} className="hover:text-violet-600">{a.name}</Link>
                  </td>
                  <td className="px-3 py-3">{a.conversaciones}</td>
                  <td className="px-3 py-3">{a.activas_24h}</td>
                  <td className="px-3 py-3">{a.en_seguimiento}</td>
                  <td className="px-3 py-3 font-semibold text-violet-600">{a.calificados}</td>
                  <td className="px-3 py-3 font-semibold text-emerald-600">{a.en_conversion}</td>
                  <td className="px-3 py-3 text-slate-600">{fmtUsd(a.gasto_30d)}</td>
                  <td className="px-5 py-3 text-right">
                    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${a.bot_enabled ? 'text-emerald-600' : 'text-slate-400'}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${a.bot_enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                      {a.bot_enabled ? 'Activo' : 'Apagado'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
