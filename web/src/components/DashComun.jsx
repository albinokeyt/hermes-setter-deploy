import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { Select } from './ui.jsx';

// Lo que comparten el dashboard (resumen) y su hoja de detalle: rango de fechas y conexión en la URL (así el
// ojito abre el detalle con el MISMO periodo), la carga de /api/dashboard y los controles de filtro.
export const fmtUsd = (v) => { const n = Number(v || 0); return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`; };
export const dstr = (d) => d.toISOString().slice(0, 10);
export const short = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : '');
export const TYPE_LABEL = { reply: 'Chat', seguimiento: 'Seguimientos', vision: 'Imagen (visión)', audio: 'Audio (transcripción)', playground: 'Pruebas', simulador: 'Simulador', corrector: 'Ajustes de prompt', arquitecto: 'Arquitecto de prompt' };

export const PRESETS = [
  { key: 'hoy', label: 'Hoy', days: 0 },
  { key: '7d', label: '7 días', days: 6 },
  { key: '30d', label: '30 días', days: 29 },
  { key: '90d', label: '90 días', days: 89 },
];

export function useDashData() {
  const [sp, setSp] = useSearchParams();
  const preset = sp.get('p') || '30d';
  const from = sp.get('desde') || dstr(new Date(Date.now() - 29 * 86400000));
  const to = sp.get('hasta') || dstr(new Date());
  const accountId = sp.get('cuenta') || '';
  const [data, setData] = useState(null);
  const [accounts, setAccounts] = useState([]);

  useEffect(() => { api.get('/api/accounts').then(setAccounts).catch(() => {}); }, []);
  useEffect(() => {
    const params = new URLSearchParams();
    if (accountId) params.set('account_id', accountId);
    params.set('from', from);
    params.set('to', to);
    api.get(`/api/dashboard?${params}`).then(setData).catch(() => {});
  }, [accountId, from, to]);

  const setParams = (patch) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setSp(next, { replace: true });
  };
  const applyPreset = (p) => setParams({ p: p.key, desde: dstr(new Date(Date.now() - p.days * 86400000)), hasta: dstr(new Date()) });
  return { data, accounts, accountId, preset, from, to, setParams, applyPreset, qs: sp.toString(), rango: `${short(from)} – ${short(to)}` };
}

export function DashCuenta({ d, me }) {
  if (me?.account_id) return null;
  return (
    <Select value={d.accountId} onChange={(e) => d.setParams({ cuenta: e.target.value })} className="!w-52" title="Conexión">
      <option value="">Todos los setters</option>
      {d.accounts.map((a) => <option key={a.id} value={a.id}>{a.alias || a.name}</option>)}
    </Select>
  );
}

export function DashRango({ d }) {
  const boton = (activo) => `rounded-xl px-3.5 py-2 text-sm font-semibold transition ${activo ? 'bg-violet-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'}`;
  return (
    <div data-tour="dash-rango" className="mb-5 flex flex-wrap items-center gap-2">
      {PRESETS.map((p) => <button key={p.key} type="button" onClick={() => d.applyPreset(p)} className={boton(d.preset === p.key)}>{p.label}</button>)}
      <button type="button" onClick={() => d.setParams({ p: 'custom' })} className={boton(d.preset === 'custom')}>Personalizado</button>
      {d.preset === 'custom' && (
        <div className="flex items-center gap-2">
          <input type="date" value={d.from} max={d.to} onChange={(e) => d.setParams({ desde: e.target.value })} aria-label="Desde" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400" />
          <span className="text-slate-400">→</span>
          <input type="date" value={d.to} min={d.from} max={dstr(new Date())} onChange={(e) => d.setParams({ hasta: e.target.value })} aria-label="Hasta" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400" />
        </div>
      )}
    </div>
  );
}

// ¿Modo oscuro? (la clase .dark en <html> la pone el ThemeToggle): la torta usa los tonos validados de cada modo.
export function useIsDark() {
  const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(el.classList.contains('dark')));
    obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}
