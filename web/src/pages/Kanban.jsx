import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, timeAgo } from '../api.js';
import { STAGES, CHANNEL_LABEL } from '../stages.js';
import { SectionTitle, Avatar } from '../components/ui.jsx';

export default function Kanban() {
  const [board, setBoard] = useState(null);

  const load = () => api.get('/api/kanban').then(setBoard).catch(() => {});
  useEffect(() => { load(); }, []);

  const move = async (convId, stage) => {
    await api.put(`/api/conversations/${convId}`, { stage });
    load();
  };

  if (!board) return <div className="py-24 text-center text-sm text-slate-400">Cargando…</div>;

  return (
    <div>
      <SectionTitle title="Etiquetas" subtitle="Tu pipeline de leads: de nuevo a convertido" />
      <div className="scroll-thin -mx-2 flex gap-4 overflow-x-auto px-2 pb-4">
        {STAGES.map((s) => (
          <div key={s.key} className="w-72 shrink-0">
            <div className="mb-3 flex items-center gap-2 px-1">
              <span className={`h-2.5 w-2.5 rounded-full ${s.dot}`} />
              <span className="text-sm font-bold text-slate-800">{s.label}</span>
              <span className="ml-auto rounded-full bg-slate-200/70 px-2 py-0.5 text-xs font-bold text-slate-600">
                {(board[s.key] || []).length}
              </span>
            </div>
            <div className="space-y-2.5">
              {(board[s.key] || []).map((c) => (
                <div key={c.id} className="fade-up rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm transition hover:border-violet-300">
                  <Link to={`/conversaciones/${c.id}`} className="flex items-center gap-2.5">
                    <Avatar name={c.lead_name || c.channel} className="!h-8 !w-8" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-800">{c.lead_name || 'Lead sin nombre'}</div>
                      <div className="text-[11px] text-slate-400">{c.account_name} · {CHANNEL_LABEL[c.channel] || c.channel}</div>
                    </div>
                  </Link>
                  <p className="mt-2 line-clamp-2 text-xs text-slate-500">{c.last_message || '—'}</p>
                  <div className="mt-2.5 flex items-center justify-between">
                    <span className="text-[10px] text-slate-400">{timeAgo(c.updated_at)}</span>
                    <select
                      value={c.stage}
                      onChange={(e) => move(c.id, e.target.value)}
                      className="rounded-lg border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px] font-medium text-slate-600 outline-none hover:border-slate-300"
                    >
                      {STAGES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                    </select>
                  </div>
                </div>
              ))}
              {(board[s.key] || []).length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-200 py-8 text-center text-xs text-slate-400">Vacío</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
