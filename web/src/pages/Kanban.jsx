import { useEffect, useReducer, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Info, Loader2 } from 'lucide-react';
import { api, timeAgo } from '../api.js';
import { STAGES, CHANNEL_LABEL } from '../stages.js';
import { SectionTitle, Avatar } from '../components/ui.jsx';

const PAGE = 25;

export default function Kanban() {
  const [, force] = useReducer((x) => x + 1, 0);
  const cols = useRef({}); // stage -> { cards, offset, hasMore, loading }
  const [counts, setCounts] = useState({});
  const [ready, setReady] = useState(false);
  const boardRef = useRef(null);
  const topRef = useRef(null);
  const [boardWidth, setBoardWidth] = useState(0);

  const col = (stage) => cols.current[stage] || (cols.current[stage] = { cards: [], offset: 0, hasMore: true, loading: false });

  const loadCounts = () => api.get('/api/kanban/counts').then(setCounts).catch(() => {});

  const loadPage = async (stage, reset = false) => {
    const c = col(stage);
    if (c.loading) return;
    if (reset) { c.cards = []; c.offset = 0; c.hasMore = true; }
    if (!c.hasMore) return;
    c.loading = true; force();
    try {
      const params = new URLSearchParams({ stage, limit: String(PAGE), offset: String(c.offset) });
      const rows = await api.get(`/api/conversations?${params}`);
      c.cards = c.offset === 0 ? rows : [...c.cards, ...rows];
      c.offset += rows.length;
      c.hasMore = rows.length === PAGE;
    } catch { /* noop */ } finally { c.loading = false; force(); }
  };

  const reloadAll = () => { loadCounts(); STAGES.forEach((s) => loadPage(s.key, true)); };

  useEffect(() => { reloadAll(); Promise.resolve().then(() => setReady(true)); }, []);

  // ancho del tablero para la barra de scroll de arriba (columnas de ancho fijo)
  useEffect(() => {
    const measure = () => setBoardWidth(boardRef.current?.scrollWidth || 0);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ready]);

  const move = async (convId, stage) => {
    await api.put(`/api/conversations/${convId}`, { stage });
    reloadAll();
  };

  const syncFromTop = () => { if (boardRef.current && topRef.current) boardRef.current.scrollLeft = topRef.current.scrollLeft; };
  const syncFromBoard = () => { if (boardRef.current && topRef.current) topRef.current.scrollLeft = boardRef.current.scrollLeft; };
  const onColScroll = (stage) => (e) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 140) loadPage(stage);
  };

  return (
    <div>
      <SectionTitle tour="page:tags" title="Etiquetas" subtitle="Tu pipeline de leads: de nuevo a convertido" />

      {/* Barra de desplazamiento horizontal ARRIBA (para no perseguirla cuando hay muchos leads) */}
      <div ref={topRef} onScroll={syncFromTop} className="scroll-thin mb-2 overflow-x-auto overflow-y-hidden">
        <div style={{ width: boardWidth || '100%', height: 1 }} />
      </div>

      <div ref={boardRef} onScroll={syncFromBoard} className="no-scrollbar -mx-2 flex gap-4 overflow-x-auto px-2">
        {STAGES.map((s) => {
          const c = col(s.key);
          const total = counts[s.key] ?? c.cards.length;
          return (
            <div key={s.key} className="flex w-72 shrink-0 flex-col">
              <div className="mb-3 flex items-center gap-1.5 px-1">
                <span className={`h-2.5 w-2.5 rounded-full ${s.dot}`} />
                <span className="text-sm font-bold text-slate-800">{s.label}</span>
                <span title={s.desc}><Info size={13} className="text-slate-300 hover:text-slate-500" /></span>
                <span className="ml-auto rounded-full bg-slate-200/70 px-2 py-0.5 text-xs font-bold text-slate-600">{total}</span>
              </div>
              <div className="scroll-thin space-y-2.5 overflow-y-auto pr-1" style={{ maxHeight: 'calc(100vh - 210px)' }} onScroll={onColScroll(s.key)}>
                {c.cards.map((card) => (
                  <div key={card.id} className="fade-up rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm transition hover:border-violet-300">
                    <Link to={`/conversaciones/${card.id}`} className="flex items-center gap-2.5">
                      <Avatar name={card.lead_name || card.channel} className="!h-8 !w-8" />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-800">{card.lead_name || 'Lead sin nombre'}</div>
                        <div className="text-[11px] text-slate-400">{card.account_name} · {CHANNEL_LABEL[card.channel] || card.channel}</div>
                      </div>
                    </Link>
                    <p className="mt-2 line-clamp-2 text-xs text-slate-500">{card.last_message || '—'}</p>
                    <div className="mt-2.5 flex items-center justify-between">
                      <span className="text-[10px] text-slate-400">{timeAgo(card.updated_at)}</span>
                      <select value={card.stage} onChange={(e) => move(card.id, e.target.value)}
                        className="rounded-lg border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px] font-medium text-slate-600 outline-none hover:border-slate-300">
                        {STAGES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                      </select>
                    </div>
                  </div>
                ))}
                {c.loading && <div className="flex justify-center py-3 text-slate-300"><Loader2 size={16} className="animate-spin" /></div>}
                {!c.cards.length && !c.loading && (
                  <div className="rounded-2xl border border-dashed border-slate-200 py-8 text-center text-xs text-slate-400">Vacío</div>
                )}
                {c.hasMore && c.cards.length > 0 && !c.loading && (
                  <button onClick={() => loadPage(s.key)} className="w-full rounded-xl py-2 text-xs font-semibold text-violet-600 hover:bg-violet-50">Cargar más</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
