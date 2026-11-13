import { useEffect, useState } from 'react';
import { RefreshCw, Send } from 'lucide-react';
import { api, timeAgo } from '../api.js';
import { Card, Button, Input, Select, Banner, CopyField } from './ui.jsx';

// 🏛️ Devoluciones del Club (POST /api/club/devolucion): ajustes de la regla y solicitudes con su decisión.
const DECISION = {
  aprobada: { txt: 'Aprobada', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  denegada: { txt: 'Denegada', cls: 'bg-red-50 text-red-700 ring-red-200' },
  revision: { txt: 'Revisión', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
};
const ENVIO = {
  enviado: { txt: 'enviado', cls: 'text-emerald-600' },
  pendiente: { txt: 'pendiente', cls: 'text-slate-500' },
  enviando: { txt: 'enviando…', cls: 'text-slate-500' },
  error: { txt: 'error', cls: 'text-red-600' },
  sin_url: { txt: 'sin URL', cls: 'text-slate-400' },
};
const PRODUCTO = { cuenta: 'Cuenta', brain: 'Brain', desconocido: '¿?' };

const num = (v) => String(v ?? '').replace('.', ',');
function medidaTexto(m = {}) {
  const partes = [];
  if (m.consumo_usd !== undefined && m.consumo_usd !== null) partes.push(`${num(Math.round(m.consumo_usd * 100) / 100)} USD de IA`);
  if (m.tareas !== undefined && m.tareas !== null) partes.push(`${m.tareas} tareas`);
  if (m.dias !== undefined && m.dias !== null) partes.push(`día ${m.dias}`);
  return partes.join(' · ') || '—';
}

export default function DevolucionesClub() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [filtro, setFiltro] = useState('');
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [guardado, setGuardado] = useState(false);
  const [ocupado, setOcupado] = useState(null);

  const cargar = (f = filtro) =>
    api.get(`/api/settings/devoluciones?limit=100${f ? `&decision=${f}` : ''}`)
      .then((d) => { setData(d); setForm((prev) => prev || { ...d.ajustes }); })
      .catch((e) => setError(e.message));
  useEffect(() => { cargar(); }, []);
  if (!data || !form) return error ? <Banner tone="error">Devoluciones del Club: {error}</Banner> : null;

  const set = (k, v) => setForm({ ...form, [k]: v });
  const guardar = async () => {
    setError(''); setAviso('');
    try {
      const r = await api.put('/api/settings/devoluciones', form);
      setForm({ ...r.ajustes });
      setGuardado(true);
      setTimeout(() => setGuardado(false), 2000);
      cargar();
    } catch (e) { setError(e.message); }
  };
  const reenviar = async (s) => {
    if (s.ghl_estado === 'enviado' && !window.confirm('Esta solicitud ya se envió a GHL. ¿Reenviarla? El cliente podría recibir el aviso dos veces.')) return;
    setError(''); setAviso(''); setOcupado(s.id);
    try {
      const r = await api.post(`/api/settings/devoluciones/${s.id}/enviar`);
      setAviso(r.ok ? `Solicitud ${s.id} enviada a GHL.` : `GHL no la aceptó: ${r.error || 'error'}`);
    } catch (e) { setError(e.message); }
    setOcupado(null);
    cargar();
  };
  const t = data.totales || {};

  return (
    <Card className="mb-4 space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-800">🏛️ Devoluciones del Club · se evalúan solas</h3>
        <span className="text-xs text-slate-500">{t.aprobada || 0} aprobadas · {t.denegada || 0} denegadas · {t.revision || 0} en revisión</span>
      </div>
      <p className="text-xs text-slate-500">
        El formulario de devoluciones llama a este endpoint desde un workflow de GHL. <b>Cuenta</b>: se aprueba si la IA de su Hermes ha
        consumido como mucho el máximo desde el cobro. <b>Brain</b>: si ha hecho como mucho el máximo de tareas (lo dice el Brain).
        Fuera de plazo se deniega; si falta un dato o no se puede medir, queda en <b>revisión</b> para soporte. Nunca se aprueba por un fallo.
      </p>
      {!data.configurado && <Banner tone="warn">Falta CLUB_WEBHOOK_SECRET en el servidor: el endpoint responde 503 y no evalúa nada.</Banner>}
      <CopyField label="Endpoint (POST, cabecera X-Club-Secret)" value={data.url} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Input label="Plazo (días desde el cobro)" inputMode="numeric" value={form.plazo_dias} onChange={(e) => set('plazo_dias', e.target.value)} />
        <Input label="Máx. IA de la cuenta (USD)" inputMode="decimal" value={form.max_ia_usd} onChange={(e) => set('max_ia_usd', e.target.value)} />
        <Input label="Máx. tareas del Brain" inputMode="numeric" value={form.max_brain_tareas} onChange={(e) => set('max_brain_tareas', e.target.value)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Input label="URL de uso del Brain (GET ?email=&desde=)" placeholder="https://… (vacía = el Brain va a revisión)" value={form.brain_uso_url} onChange={(e) => set('brain_uso_url', e.target.value)} hint={'Recibe la cabecera X-Club-Secret y responde { "tareas": N }.'} />
        <Input label="URL del resultado en GHL (Webhook entrante)" placeholder="https://services.leadconnectorhq.com/hooks/… (vacía = solo se guarda)" value={form.ghl_resultado_url} onChange={(e) => set('ghl_resultado_url', e.target.value)} hint={'Recibe { email, contact_id, producto, decision, motivo, … }.'} />
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {aviso && <Banner tone="ok">{aviso}</Banner>}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={guardar}>{guardado ? '✓ Guardado' : 'Guardar ajustes'}</Button>
        <Button variant="ghost" onClick={() => setForm({ ...form, plazo_dias: data.por_defecto.plazo_dias, max_ia_usd: data.por_defecto.max_ia_usd, max_brain_tareas: data.por_defecto.max_brain_tareas })}>Números por defecto (14 · 5 · 10)</Button>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-2 border-t border-slate-100 pt-4">
        <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500">Solicitudes ({data.solicitudes.length})</h4>
        <div className="flex items-end gap-2">
          <Select value={filtro} onChange={(e) => { setFiltro(e.target.value); cargar(e.target.value); }} className="!py-1.5 text-xs">
            <option value="">Todas</option>
            <option value="aprobada">Aprobadas</option>
            <option value="denegada">Denegadas</option>
            <option value="revision">En revisión</option>
          </Select>
          <Button variant="secondary" className="!px-3 !py-1.5" onClick={() => cargar()} aria-label="Recargar"><RefreshCw size={14} /></Button>
        </div>
      </div>
      {data.solicitudes.length === 0 ? (
        <p className="text-xs text-slate-400">Aún no ha llegado ninguna solicitud.</p>
      ) : (
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="text-[11px] uppercase tracking-wide text-slate-400">
              <tr><th className="py-2 pr-3">Cuándo</th><th className="pr-3">Cliente</th><th className="pr-3">Producto</th><th className="pr-3">Decisión</th><th className="pr-3">Motivo</th><th className="pr-3">Medida</th><th>GHL</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.solicitudes.map((s) => {
                const d = DECISION[s.decision] || DECISION.revision;
                const e = ENVIO[s.ghl_estado] || ENVIO.pendiente;
                return (
                  <tr key={s.id} className="align-top">
                    <td className="py-2 pr-3 text-slate-500" title={new Date(s.created_at).toLocaleString('es-ES')}>{timeAgo(s.created_at)}{s.repeticiones > 0 && <span className="block text-[10px] text-slate-400">repetida ×{s.repeticiones}</span>}</td>
                    <td className="pr-3"><span className="block font-medium text-slate-700">{s.email || '—'}</span><span className="block text-[10px] text-slate-400">{s.contact_id || ''}{s.fecha_dia ? ` · cobro ${s.fecha_dia}` : s.fecha_texto ? ` · cobro «${s.fecha_texto}»` : ''}</span></td>
                    <td className="pr-3 text-slate-600">{PRODUCTO[s.producto] || s.producto}</td>
                    <td className="pr-3"><span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${d.cls}`}>{d.txt}</span></td>
                    <td className="max-w-[260px] pr-3 text-slate-600">{s.motivo}{s.motivo_cliente && <span className="mt-0.5 block text-[10px] italic text-slate-400" title={s.motivo_cliente}>Cliente: {s.motivo_cliente.slice(0, 120)}</span>}</td>
                    <td className="pr-3 text-slate-500">{medidaTexto(s.medida)}</td>
                    <td className="whitespace-nowrap">
                      <span className={`font-semibold ${e.cls}`} title={s.ghl_error || ''}>{e.txt}</span>
                      {s.ghl_intentos > 1 && <span className="text-[10px] text-slate-400"> ×{s.ghl_intentos}</span>}
                      {['error', 'sin_url', 'pendiente', 'enviado'].includes(s.ghl_estado) && (
                        <button type="button" disabled={ocupado === s.id} onClick={() => reenviar(s)} className="ml-2 inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] font-semibold text-violet-600 hover:bg-violet-50 disabled:opacity-50" title={s.ghl_estado === 'enviado' ? 'Reenviar (ya se envió)' : 'Enviar a GHL'}>
                          <Send size={11} /> {s.ghl_estado === 'enviado' ? 'Reenviar' : 'Enviar'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
