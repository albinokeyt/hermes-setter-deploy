import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessagesSquare, Flame, ArrowDownToLine, ArrowUpFromLine, Wallet, CalendarCheck, Info, ChevronDown } from 'lucide-react';
import { useMe } from '../components/Layout.jsx';
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api, timeAgo } from '../api.js';
import { STAGES } from '../stages.js';
import { Card, SectionTitle, StatCard, StagePill, Avatar, Select } from '../components/ui.jsx';

const fmtUsd = (v) => { const n = Number(v || 0); return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`; };
const dstr = (d) => d.toISOString().slice(0, 10);
const short = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : '');
const TYPE_LABEL = { reply: 'Chat', seguimiento: 'Seguimientos', vision: 'Imagen (visión)', audio: 'Audio (transcripción)', playground: 'Pruebas' };

const PRESETS = [
  { key: 'hoy', label: 'Hoy', days: 0 },
  { key: '7d', label: '7 días', days: 6 },
  { key: '30d', label: '30 días', days: 29 },
  { key: '90d', label: '90 días', days: 89 },
];

export default function Dashboard() {
  const me = useMe();
  const [data, setData] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [preset, setPreset] = useState('30d');
  const [from, setFrom] = useState(dstr(new Date(Date.now() - 29 * 86400000)));
  const [to, setTo] = useState(dstr(new Date()));
  const [showSpend, setShowSpend] = useState(false);

  useEffect(() => { api.get('/api/accounts').then(setAccounts).catch(() => {}); }, []);
  useEffect(() => {
    const params = new URLSearchParams();
    if (accountId) params.set('account_id', accountId);
    params.set('from', from);
    params.set('to', to);
    api.get(`/api/dashboard?${params}`).then(setData).catch(() => {});
  }, [accountId, from, to]);

  const applyPreset = (p) => {
    setPreset(p.key);
    setFrom(dstr(new Date(Date.now() - p.days * 86400000)));
    setTo(dstr(new Date()));
  };

  if (!data) return <div className="py-24 text-center text-sm text-slate-400">Cargando…</div>;

  const t = data.totals || {};
  const stageCount = Object.fromEntries((data.byStage || []).map((r) => [r.stage, r.total]));
  const rango = `${short(from)} – ${short(to)}`;

  return (
    <div>
      <SectionTitle
        title="Dashboard"
        subtitle={`Datos del ${short(from)} al ${short(to)}`}
        actions={
          me?.account_id ? null : (
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="!w-52">
              <option value="">Todos los setters</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.alias || a.name}</option>)}
            </Select>
          )
        }
      />

      {/* Rango de fechas */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => applyPreset(p)}
            className={`rounded-xl px-3.5 py-2 text-sm font-semibold transition ${preset === p.key ? 'bg-violet-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'}`}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setPreset('custom')}
          className={`rounded-xl px-3.5 py-2 text-sm font-semibold transition ${preset === 'custom' ? 'bg-violet-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'}`}
        >
          Personalizado
        </button>
        {preset === 'custom' && (
          <div className="flex items-center gap-2">
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400" />
            <span className="text-slate-400">→</span>
            <input type="date" value={to} min={from} max={dstr(new Date())} onChange={(e) => setTo(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400" />
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Conversaciones nuevas" value={t.nuevas ?? 0} sub={`${t.conversaciones_total ?? 0} en total`} icon={MessagesSquare} tone="violet" />
        <StatCard label="Activas" value={t.activas ?? 0} sub="con actividad en el rango" icon={Flame} tone="amber" />
        <StatCard label="Recibidos" value={t.recibidos ?? 0} sub="mensajes de leads" icon={ArrowDownToLine} tone="blue" />
        <StatCard label="Enviados" value={t.enviados ?? 0} sub="respuestas del setter" icon={ArrowUpFromLine} tone="emerald" />
        <StatCard label="Agendas" value={t.agendas ?? 0} sub={`${t.canceladas ?? 0} canceladas`} icon={CalendarCheck} tone="emerald" />
        <StatCard label="Gasto IA" value={fmtUsd(t.gasto)} sub="clic para ver el desglose" icon={Wallet} tone="violet" onClick={() => setShowSpend((v) => !v)} />
      </div>

      {showSpend && (
        <Card className="mt-4 p-5 fade-up">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700">Gasto de IA por tipo · {rango}</h3>
            <ChevronDown size={16} className="rotate-180 text-slate-400 cursor-pointer" onClick={() => setShowSpend(false)} />
          </div>
          {(data.gastoPorTipo || []).length === 0 ? (
            <p className="text-xs text-slate-400">Sin gasto de IA en este rango.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {(data.gastoPorTipo || []).map((g) => (
                <span key={g.source} className="inline-flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm">
                  <span className="font-medium text-slate-600">{TYPE_LABEL[g.source] || g.source}</span>
                  <span className="font-bold text-slate-900">{fmtUsd(g.total)}</span>
                </span>
              ))}
              <span className="inline-flex items-center gap-2 rounded-xl bg-violet-50 px-3 py-2 text-sm">
                <span className="font-medium text-violet-600">Total</span>
                <span className="font-bold text-violet-700">{fmtUsd(t.gasto)}</span>
              </span>
            </div>
          )}
        </Card>
      )}

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
        {/* Comentarios de Instagram — rellenan la fila de etiquetas y enlazan al Archivo */}
        {[
          { key: 'comentarios', label: '💬 Comentarios', value: t.comentarios ?? 0, accent: 'text-violet-600', desc: 'Comentarios de Instagram recibidos por webhook en el rango.' },
          { key: 'comentarios_nuevos', label: '✨ De nuevos usuarios', value: t.comentarios_nuevos ?? 0, accent: 'text-fuchsia-600', desc: 'Comentarios cuyo autor comenta por primera vez (su primer comentario).' },
          { key: 'comentaristas', label: '👥 Comentaristas', value: t.comentaristas ?? 0, accent: 'text-blue-600', desc: 'Personas distintas que comentaron en el rango (nuevas + recurrentes).' },
        ].map((cm) => (
          <Link key={cm.key} to="/archivo" className="group">
            <Card className="p-4 transition group-hover:border-violet-300">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium text-slate-500">{cm.label}</span>
                <span className="ml-auto shrink-0" title={cm.desc} onClick={(e) => e.preventDefault()}>
                  <Info size={13} className="text-slate-300 hover:text-slate-500" />
                </span>
              </div>
              <div className={`mt-1.5 text-2xl font-bold ${cm.accent}`}>{cm.value}</div>
            </Card>
          </Link>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="p-5 lg:col-span-3">
          <h3 className="mb-4 text-sm font-semibold text-slate-700">Actividad · {rango}</h3>
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
                <XAxis dataKey="dia" tick={{ fontSize: 11, fill: '#94a3b8' }} tickFormatter={(d) => d.slice(5)} axisLine={false} tickLine={false} minTickGap={20} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} />
                <Area type="monotone" dataKey="recibidos" name="Recibidos" stroke="#b58a2e" strokeWidth={2} fill="url(#gIn)" />
                <Area type="monotone" dataKey="enviados" name="Enviados" stroke="#10b981" strokeWidth={2} fill="url(#gOut)" />
                <Line type="monotone" dataKey="agendas" name="Agendas" stroke="#0d9488" strokeWidth={2.5} dot={{ r: 2.5 }} />
                <Line type="monotone" dataKey="leads_nuevos" name="Leads nuevos" stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 3" dot={false} />
                <Line type="monotone" dataKey="comentarios" name="Comentarios" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="comentarios_nuevos" name="Coment. nuevos" stroke="#d946ef" strokeWidth={2} strokeDasharray="4 3" dot={false} />
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
          <h3 className="text-sm font-semibold text-slate-700">Rendimiento por setter · {rango}</h3>
        </div>
        {(data.perAccount || []).length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-400">Crea tu primera cuenta en la sección Cuentas</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400">
                  <th className="px-5 py-3 font-medium">Setter</th>
                  <th className="px-3 py-3 font-medium">Conversaciones</th>
                  <th className="px-3 py-3 font-medium">Activas</th>
                  <th className="px-3 py-3 font-medium">En seguimiento</th>
                  <th className="px-3 py-3 font-medium">Calificados</th>
                  <th className="px-3 py-3 font-medium">En conversión</th>
                  <th className="px-3 py-3 font-medium">Gasto</th>
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
                    <td className="px-3 py-3">{a.activas}</td>
                    <td className="px-3 py-3">{a.en_seguimiento}</td>
                    <td className="px-3 py-3 font-semibold text-violet-600">{a.calificados}</td>
                    <td className="px-3 py-3 font-semibold text-emerald-600">{a.en_conversion}</td>
                    <td className="px-3 py-3 text-slate-600">{fmtUsd(a.gasto)}</td>
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
          </div>
        )}
      </Card>
    </div>
  );
}
