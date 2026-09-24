import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, Flame, ArrowDownToLine, ArrowUpFromLine, MessageCircle, Sparkles, CalendarCheck, CalendarX, ShoppingBag, Store, Wallet, Info } from 'lucide-react';
import { ComposedChart, Area, Line, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useMe } from '../components/Layout.jsx';
import { fmtMonedas } from '../api.js';
import { STAGES } from '../stages.js';
import { Card, SectionTitle, StatCard } from '../components/ui.jsx';
import { useDashData, DashCuenta, DashRango, fmtUsd, TYPE_LABEL, useIsDark } from '../components/DashComun.jsx';

// 👁 Hoja de DETALLE del dashboard (se abre con el ojito): todo lo que no cabe en el resumen. Mismo periodo y
// conexión que el resumen (van en la URL).
export default function DashboardDetalle() {
  const me = useMe();
  const d = useDashData();
  const dark = useIsDark();
  const { hash } = useLocation();
  const listo = Boolean(d.data);
  useEffect(() => {
    if (listo && hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [listo, hash]);

  if (!d.data) return <div className="py-24 text-center text-sm text-slate-400">Cargando…</div>;
  const t = d.data.totals || {};
  const stageCount = Object.fromEntries((d.data.byStage || []).map((r) => [r.stage, Number(r.total) || 0]));
  const totalLeads = Object.values(stageCount).reduce((s, v) => s + v, 0);
  const isAdmin = me?.role === 'admin';
  const C = dark
    ? { nuevos: '#9085e9', agendas: '#3987e5', ventas: '#008300', recibidos: '#c98500', enviados: '#199e70', comentarios: '#d55181' }
    : { nuevos: '#4a3aa7', agendas: '#2a78d6', ventas: '#008300', recibidos: '#eda100', enviados: '#1baf7a', comentarios: '#e87ba4' };
  const Seccion = ({ id, titulo, sub, children }) => (
    <section id={id} className="mt-6 scroll-mt-6">
      <h3 className="text-sm font-bold text-slate-700">{titulo}</h3>
      {sub && <p className="mb-3 text-xs text-slate-400">{sub}</p>}
      {children}
    </section>
  );

  return (
    <div>
      <SectionTitle title="Detalle del dashboard" subtitle={`Todos los indicadores del ${d.rango}`} actions={<DashCuenta d={d} me={me} />} />
      <Link to={`/${d.qs ? `?${d.qs}` : ''}`} className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-violet-600 hover:underline"><ArrowLeft size={15} /> Volver al resumen</Link>
      <DashRango d={d} />

      <Seccion id="status" titulo="Status uno por uno" sub="Cómo están hoy todos los leads (la torta del resumen agrupa estos status en 6 porciones). Clic para ir al tablero de Status.">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          {STAGES.map((s) => {
            const alerta = s.key === 'atencion_humana';
            const n = stageCount[s.key] || 0;
            const hot = alerta && n > 0;
            return (
              <Link key={s.key} to="/etiquetas" className="group">
                <Card className={`h-full p-4 transition ${hot ? 'border-orange-400 bg-orange-50 ring-2 ring-orange-200' : 'group-hover:border-violet-300'}`}>
                  <div className="flex items-center gap-1.5">
                    {alerta ? <span className="text-sm leading-none">🚨</span> : <span className={`h-2 w-2 rounded-full ${s.dot}`} />}
                    <span className={`truncate text-xs font-medium ${alerta ? 'text-orange-700' : 'text-slate-500'}`}>{s.label}</span>
                    <span className="ml-auto shrink-0" title={s.desc} onClick={(e) => e.preventDefault()}><Info size={13} className="text-slate-300 hover:text-slate-500" /></span>
                  </div>
                  <div className={`mt-1.5 text-2xl font-bold ${hot ? 'text-orange-600' : 'text-slate-900'}`}>{n}</div>
                  <div className="text-[11px] text-slate-400">{!totalLeads || !n ? '0 %' : (n / totalLeads) * 100 < 1 ? '<1 %' : `${Math.round((n / totalLeads) * 100)} %`} del total</div>
                </Card>
              </Link>
            );
          })}
        </div>
      </Seccion>

      <Seccion titulo="Agendas y ventas" sub="Ventas del setter = compras de leads que ya hablaban con él cuando compraron. «En la subcuenta» incluye también las de quien no habló con el setter.">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Agendas" value={t.agendas ?? 0} sub="citas reservadas en el periodo" icon={CalendarCheck} tone="blue" />
          <StatCard label="Canceladas" value={t.canceladas ?? 0} sub="citas anuladas en el periodo" icon={CalendarX} tone="amber" />
          <StatCard label="Ventas del setter" value={t.ventas ?? 0} sub={fmtMonedas(t.ingresos_por_moneda) || 'sin ingresos'} icon={ShoppingBag} tone="emerald" />
          <StatCard label="Ventas en la subcuenta" value={t.ventas_subcuenta ?? 0} sub="todas las compras pagadas" icon={Store} tone="emerald" />
        </div>
      </Seccion>

      <Seccion titulo="Mensajes y comentarios">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Activas" value={t.activas ?? 0} sub="con actividad en el periodo" icon={Flame} tone="amber" />
          <StatCard label="Recibidos" value={t.recibidos ?? 0} sub="mensajes de leads" icon={ArrowDownToLine} tone="blue" />
          <StatCard label="Enviados" value={t.enviados ?? 0} sub="respuestas del setter" icon={ArrowUpFromLine} tone="emerald" />
          <Link to="/archivo"><StatCard label="Comentarios" value={t.comentarios ?? 0} sub={`${t.comentaristas ?? 0} personas distintas`} icon={MessageCircle} tone="violet" /></Link>
          <Link to="/archivo"><StatCard label="De nuevos usuarios" value={t.comentarios_nuevos ?? 0} sub="comentan por primera vez" icon={Sparkles} tone="violet" /></Link>
        </div>
      </Seccion>

      <Seccion id="gasto" titulo="Gasto de IA">
        <Card className="p-5">
          <div className="flex flex-wrap gap-2">
            {isAdmin ? (
              <>
                <span className="inline-flex items-center gap-2 rounded-xl bg-violet-50 px-3 py-2 text-sm"><Wallet size={14} className="text-violet-600" /><span className="font-medium text-violet-600">Costo</span><b className="text-violet-700">{fmtUsd(t.gasto)}</b></span>
                <span className="inline-flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm"><span className="font-medium text-emerald-700">Facturado</span><b className="text-emerald-700">{fmtUsd(t.facturado)}</b></span>
              </>
            ) : (
              <span className="inline-flex items-center gap-2 rounded-xl bg-violet-50 px-3 py-2 text-sm"><Wallet size={14} className="text-violet-600" /><span className="font-medium text-violet-600">Total</span><b className="text-violet-700">{fmtUsd(t.facturado ?? t.gasto)}</b></span>
            )}
            {(d.data.gastoPorTipo || []).map((g) => (
              <span key={g.source} className="inline-flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm">
                <span className="font-medium text-slate-600">{TYPE_LABEL[g.source] || g.source}</span>
                <b className="text-slate-900">{fmtUsd(g.total)}</b>
              </span>
            ))}
          </div>
          {(d.data.gastoPorTipo || []).length === 0 && <p className="mt-2 text-xs text-slate-400">Sin gasto de IA en este periodo.</p>}
        </Card>
      </Seccion>

      <Seccion titulo="Actividad completa" sub="Cada día, en tres gráficas con su propia escala (los mensajes son cientos y las ventas unas pocas: juntos no se leerían)">
        <Card className="space-y-3 p-5">
          {[
            { titulo: 'Mensajes', alto: 'h-40', series: [['area', 'recibidos', 'Recibidos', C.recibidos], ['area', 'enviados', 'Enviados', C.enviados]] },
            { titulo: 'Leads y comentarios', alto: 'h-36', series: [['line', 'leads_nuevos', 'Leads nuevos', C.nuevos], ['line', 'comentarios', 'Comentarios', C.comentarios]] },
            { titulo: 'Agendas y ventas', alto: 'h-40', series: [['bar', 'agendas', 'Agendas', C.agendas], ['bar', 'ventas', 'Ventas', C.ventas]], ejeX: true },
          ].map((g) => (
            <div key={g.titulo}>
              <div className="text-[11px] font-semibold text-slate-500">{g.titulo}</div>
              <div className={g.alto}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={d.data.daily || []} syncId="detalle" margin={{ top: 4, right: 8, left: -20, bottom: 0 }} barGap={2}>
                    <CartesianGrid strokeDasharray="3 3" stroke={dark ? '#2e323a' : '#f1f5f9'} vertical={false} />
                    <XAxis dataKey="dia" hide={!g.ejeX} tick={{ fontSize: 11, fill: '#94a3b8' }} tickFormatter={(x) => x.slice(5)} axisLine={false} tickLine={false} minTickGap={20} />
                    <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} allowDecimals={false} width={40} />
                    <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} cursor={g.ejeX ? { fill: dark ? '#23262d' : '#f8fafc' } : undefined} />
                    <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} />
                    {g.series.map(([tipo, key, name, color]) => (tipo === 'area'
                      ? <Area key={key} type="monotone" dataKey={key} name={name} stroke={color} strokeWidth={2} fill={color} fillOpacity={0.12} />
                      : tipo === 'bar'
                        ? <Bar key={key} dataKey={key} name={name} fill={color} radius={[4, 4, 0, 0]} maxBarSize={10} />
                        : <Line key={key} type="monotone" dataKey={key} name={name} stroke={color} strokeWidth={2} dot={false} />))}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          ))}
        </Card>
      </Seccion>

      <Seccion titulo={`Rendimiento por setter · ${d.rango}`}>
        <Card className="overflow-hidden">
          {(d.data.perAccount || []).length === 0 ? (
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
                    <th className="px-3 py-3 font-medium">Agendados</th>
                    <th className="px-3 py-3 font-medium">Compradores</th>
                    <th className="px-3 py-3 font-medium">Ventas</th>
                    <th className="px-3 py-3 font-medium">{isAdmin ? 'Costo' : 'Gasto'}</th>
                    {isAdmin && <th className="px-3 py-3 font-medium">Facturado</th>}
                    <th className="px-5 py-3 text-right font-medium">Bot</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.data.perAccount || []).map((a) => (
                    <tr key={a.id} className="border-t border-slate-50 hover:bg-slate-50/60">
                      <td className="px-5 py-3 font-semibold text-slate-800"><Link to={`/cuentas/${a.id}`} className="hover:text-violet-600">{a.name}</Link></td>
                      <td className="px-3 py-3">{a.conversaciones}</td>
                      <td className="px-3 py-3">{a.activas}</td>
                      <td className="px-3 py-3">{a.en_seguimiento}</td>
                      <td className="px-3 py-3 font-semibold text-violet-600">{a.calificados}</td>
                      <td className="px-3 py-3 font-semibold text-emerald-600">{a.en_conversion}</td>
                      <td className="px-3 py-3 font-semibold text-blue-700">{a.agendados ?? 0}</td>
                      <td className="px-3 py-3 font-semibold text-green-700">{a.compradores ?? 0}</td>
                      <td className="px-3 py-3 text-green-700"><b>{a.ventas ?? 0}</b>{fmtMonedas(a.ingresos_por_moneda) && <span className="ml-1 text-xs text-slate-500">{fmtMonedas(a.ingresos_por_moneda)}</span>}</td>
                      <td className="px-3 py-3 text-slate-600">{fmtUsd(isAdmin ? a.gasto : (a.facturado ?? a.gasto))}</td>
                      {isAdmin && <td className="px-3 py-3 font-semibold text-emerald-600">{fmtUsd(a.facturado)}</td>}
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
      </Seccion>
    </div>
  );
}
