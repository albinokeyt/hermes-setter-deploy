import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Send, Bot, User, Clock, ExternalLink } from 'lucide-react';
import { api, timeAgo, ghlContactUrl } from '../api.js';
import { STAGES, CHANNEL_LABEL, stageByKey } from '../stages.js';
import { Card, Button, StagePill, Toggle, Select, Banner } from '../components/ui.jsx';

function Bubble({ m }) {
  const mine = m.direction === 'outbound';
  const sourceLabel = { bot: 'Setter IA', humano: 'Humano', seguimiento: 'Seguimiento IA', lead: '' }[m.source] || '';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
        mine ? 'bg-violet-600 text-white rounded-br-md' : 'bg-white border border-slate-200 text-slate-800 rounded-bl-md'
      }`}>
        {m.body}
        <div className={`mt-1 flex items-center gap-1.5 text-[10px] ${mine ? 'text-violet-200' : 'text-slate-400'}`}>
          {sourceLabel && <span>{sourceLabel} ·</span>}
          <span>{new Date(m.created_at).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>
    </div>
  );
}

export default function ConversationDetail() {
  const { id } = useParams();
  const [conv, setConv] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef(null);

  const load = () => api.get(`/api/conversations/${id}`).then(setConv).catch((e) => setError(e.message));
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [id]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [conv?.messages?.length]);

  if (!conv) return <div className="py-24 text-center text-sm text-slate-400">{error || 'Cargando…'}</div>;

  const update = async (patch) => { await api.put(`/api/conversations/${id}`, patch); load(); };

  const sendManual = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    setError('');
    try {
      await api.post(`/api/conversations/${id}/send`, { message: text.trim() });
      setText('');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <Link to="/conversaciones" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
        <ArrowLeft size={15} /> Conversaciones
      </Link>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="flex h-[70vh] flex-col lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-slate-900">{conv.lead_name || 'Lead sin nombre'}</div>
              <div className="truncate text-xs text-slate-400">
                {conv.account_name} · {CHANNEL_LABEL[conv.channel] || conv.channel}
                {conv.lead_email && ` · ${conv.lead_email}`}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {ghlContactUrl(conv.location_id, conv.ghl_contact_id) && (
                <a
                  href={ghlContactUrl(conv.location_id, conv.ghl_contact_id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Ir al perfil del contacto en GHL"
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-500 transition hover:border-violet-300 hover:text-violet-600"
                >
                  Ir a GHL <ExternalLink size={12} />
                </a>
              )}
              <StagePill stage={conv.stage} />
            </div>
          </div>
          <div className="scroll-thin flex-1 space-y-3 overflow-y-auto bg-slate-50/50 px-5 py-4">
            {conv.messages.map((m) => <Bubble key={m.id} m={m} />)}
            <div ref={bottomRef} />
          </div>
          <form onSubmit={sendManual} className="flex items-center gap-2 border-t border-slate-100 px-4 py-3">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Escribir como humano (pausa el bot)…"
              className="flex-1 rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-violet-400 focus:ring-4 focus:ring-violet-100"
            />
            <Button type="submit" loading={sending} className="!px-3.5"><Send size={16} /></Button>
          </form>
        </Card>

        <div className="space-y-4">
          {error && <Banner tone="error">{error}</Banner>}
          <Card className="space-y-4 p-5">
            <h3 className="text-sm font-semibold text-slate-700">Control</h3>
            <Toggle
              checked={!conv.bot_paused}
              onChange={(v) => update({ bot_paused: !v })}
              label={conv.bot_paused ? 'Bot en pausa' : 'Bot activo'}
              description={conv.bot_paused ? 'Un humano está al mando de este chat' : 'El setter responde automáticamente'}
            />
            <Select label="Etiqueta" value={conv.stage} onChange={(e) => update({ stage: e.target.value })}>
              {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </Select>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Clock size={13} />
              Último mensaje del lead: {timeAgo(conv.last_inbound_at)}
            </div>
            {conv.followup_state !== 'ninguno' && (
              <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700">
                Seguimiento: {conv.followup_state.replaceAll('_', ' ')}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <h3 className="mb-2 text-sm font-semibold text-slate-700">Memoria del lead</h3>
            {Object.keys(conv.memory || {}).length === 0 ? (
              <p className="text-xs text-slate-400">El agente aún no ha guardado datos de este lead.</p>
            ) : (
              <dl className="space-y-1.5">
                {Object.entries(conv.memory).map(([k, v]) => (
                  <div key={k} className="text-xs">
                    <dt className="font-semibold capitalize text-slate-500">{k.replaceAll('_', ' ')}</dt>
                    <dd className="text-slate-700">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>

          <Card className="p-5">
            <h3 className="mb-2 text-sm font-semibold text-slate-700">Historial de etiquetas</h3>
            {(conv.stage_history || []).length === 0 ? (
              <p className="text-xs text-slate-400">Sin cambios aún.</p>
            ) : (
              <div className="space-y-2">
                {conv.stage_history.map((h) => (
                  <div key={h.id} className="text-xs text-slate-500">
                    <span className="font-semibold text-slate-700">{stageByKey(h.to_stage).label}</span>
                    {h.reason && <span> — {h.reason}</span>}
                    <span className="block text-[10px] text-slate-400">{timeAgo(h.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
