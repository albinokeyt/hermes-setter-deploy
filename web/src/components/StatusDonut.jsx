import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { STATUS_GRUPOS } from '../stages.js';
import { Card } from './ui.jsx';
import { useIsDark } from './DashComun.jsx';

// 🥧 Torta de status: estado ACTUAL de todos los leads en 6 porciones (ver STATUS_GRUPOS). Cada porción lleva al
// lado su nombre, número y porcentaje (la identidad nunca va solo por color). El ojito abre la hoja de detalle.
export function StatusDonut({ byStage, detalleHref, className = '' }) {
  const dark = useIsDark();
  const [hover, setHover] = useState(null);
  const count = Object.fromEntries((byStage || []).map((r) => [r.stage, Number(r.total) || 0]));
  const datos = STATUS_GRUPOS.map((g) => ({ ...g, value: g.stages.reduce((s, k) => s + (count[k] || 0), 0), color: dark ? g.dark : g.light }));
  const total = datos.reduce((s, x) => s + x.value, 0);
  const humana = count.atencion_humana || 0;
  const pct = (v) => { if (!total || !v) return '0 %'; const p = (v / total) * 100; return p < 1 ? '<1 %' : `${Math.round(p)} %`; };
  const superficie = dark ? '#191b21' : '#ffffff'; // separación de 2 px entre porciones, del color de la tarjeta

  const Tip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const g = payload[0].payload;
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
        <div className="flex items-center gap-1.5 font-semibold text-slate-800"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: g.color }} />{g.label}</div>
        <div className="mt-0.5 text-slate-600"><b className="text-slate-900">{g.value}</b> leads · {pct(g.value)}</div>
        <div className="mt-0.5 max-w-[220px] text-slate-400">{g.desc}</div>
      </div>
    );
  };

  return (
    <Card data-tour="dash-etapas" className={`p-5 ${className}`}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Status de tus leads</h3>
          <p className="text-xs text-slate-400">Cómo están hoy todos los leads</p>
        </div>
        <Link to={detalleHref} title="Ver el detalle de cada status y del resto de indicadores" aria-label="Ver el detalle"
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-violet-300 hover:text-violet-700">
          <Eye size={15} /> Ver detalle
        </Link>
      </div>

      <div className="flex flex-col items-center gap-4 sm:flex-row">
        <div className="relative h-44 w-44 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={total ? datos.filter((x) => x.value > 0) : [{ key: 'vacio', value: 1, color: dark ? '#2e323a' : '#e2e8f0' }]}
                dataKey="value" nameKey="label" innerRadius="64%" outerRadius="96%" startAngle={90} endAngle={-270} minAngle={4}
                stroke={superficie} strokeWidth={2} isAnimationActive={false}
                onMouseEnter={(_, i) => { const x = total ? datos.filter((y) => y.value > 0)[i] : null; setHover(x?.key || null); }}
                onMouseLeave={() => setHover(null)}
              >
                {(total ? datos.filter((x) => x.value > 0) : [{ key: 'vacio', color: dark ? '#2e323a' : '#e2e8f0' }]).map((x) => (
                  <Cell key={x.key} fill={x.color} fillOpacity={hover && hover !== x.key ? 0.3 : 1} />
                ))}
              </Pie>
              {total > 0 && <Tooltip content={<Tip />} wrapperStyle={{ zIndex: 20 }} />}
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-3xl font-bold text-slate-900">{total}</span>
            <span className="text-[11px] font-medium text-slate-400">{total === 1 ? 'lead' : 'leads'}</span>
          </div>
        </div>

        <ul className="w-full min-w-0 flex-1 space-y-0.5">
          {datos.map((g) => (
            <li key={g.key}>
              <Link to="/etiquetas" onMouseEnter={() => setHover(g.key)} onMouseLeave={() => setHover(null)} title={g.desc}
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition hover:bg-slate-50 ${hover && hover !== g.key ? 'opacity-50' : ''}`}>
                <span className="h-3 w-3 shrink-0 rounded-[3px]" style={{ background: g.color }} />
                <span className="flex-1 whitespace-nowrap text-slate-600">{g.label}</span>
                <span className="font-semibold tabular-nums text-slate-900">{g.value}</span>
                <span className="w-11 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-slate-400">{pct(g.value)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>

      {humana > 0 && (
        <Link to="/etiquetas" className="mt-3 flex items-center gap-2 rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-sm font-semibold text-orange-700 transition hover:border-orange-400 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-300">
          <span aria-hidden>🚨</span> {humana} {humana === 1 ? 'lead necesita' : 'leads necesitan'} atención humana
        </Link>
      )}
    </Card>
  );
}
