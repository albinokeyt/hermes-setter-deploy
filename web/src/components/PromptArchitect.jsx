import { useRef, useState } from 'react';
import { Send, Image, X, Check, Sparkles, Eye, PencilLine } from 'lucide-react';
import { api } from '../api.js';
import { Button, Banner } from './ui.jsx';

const BLOCKS = [
  { key: 'prompt_identity', label: '1 · Identidad y personalidad' },
  { key: 'prompt_business', label: '2 · Negocio y oferta' },
  { key: 'prompt_flow', label: '3 · Flujo y objetivo' },
];

// Chat con la IA arquitecta que arma/ajusta los 3 bloques del prompt de un setter.
// mode: 'architect' (entrevista) o 'edit' (aplicar cambios con imágenes).
// targetPath SIEMPRE apunta a un setter (/api/setters/:id): los prompts de la conexión son legacy.
export function PromptArchitect({ targetPath, mode = 'architect', onApplied, compact = false }) {
  const base = targetPath;
  const [chat, setChat] = useState([]);
  const [text, setText] = useState('');
  const [images, setImages] = useState([]); // data URLs, NO se guardan
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState(null);
  const [preview, setPreview] = useState(null); // { current } — comparación antes/después
  const [error, setError] = useState('');
  const [applied, setApplied] = useState(false);
  const bottomRef = useRef(null);
  const fileRef = useRef(null);

  const scroll = () => setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);

  const addImages = (files) => {
    [...files].slice(0, 4).forEach((f) => {
      if (!f.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => setImages((prev) => [...prev, reader.result].slice(0, 4));
      reader.readAsDataURL(f);
    });
  };

  const send = async (e) => {
    e?.preventDefault?.();
    const msg = text.trim();
    if (!msg && !images.length) return;
    setError('');
    setProposal(null);
    const shownImgs = images;
    setChat((c) => [...c, { role: 'user', text: msg, images: shownImgs }]);
    const history = chat.map((m) => ({ role: m.role, text: m.text }));
    setText('');
    setImages([]);
    setBusy(true);
    scroll();
    try {
      const r = await api.post(`${base}/prompt-editor`, { history, message: msg, images: shownImgs, mode });
      setChat((c) => [...c, { role: 'assistant', text: r.reply }]);
      if (r.proposal) setProposal(r.proposal);
    } catch (err) {
      setChat((c) => [...c, { role: 'assistant', text: `⚠️ ${err.message}` }]);
    } finally {
      setBusy(false);
      scroll();
    }
  };

  const apply = async () => {
    if (!proposal) return;
    setBusy(true);
    try {
      // solo aplicamos las secciones con contenido (no borramos un bloque por una propuesta vacía)
      const patch = { prompt_source: mode === 'edit' ? 'corrector' : 'arquitecto' };
      if (proposal.prompt_identity?.trim()) patch.prompt_identity = proposal.prompt_identity;
      if (proposal.prompt_business?.trim()) patch.prompt_business = proposal.prompt_business;
      if (proposal.prompt_flow?.trim()) patch.prompt_flow = proposal.prompt_flow;
      await api.put(base, patch);
      setApplied(true);
      setProposal(null);
      setPreview(null);
      setChat((c) => [...c, { role: 'assistant', text: '✅ Cambios aplicados. La versión anterior quedó guardada en el Historial por si quieres volver atrás.' }]);
      onApplied?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const openPreview = async () => {
    try {
      const cur = await api.get(base);
      setPreview({ current: cur });
    } catch (err) {
      setError(err.message);
    }
  };

  const modifyRequest = () => {
    setProposal(null);
    setPreview(null);
    setChat((c) => [...c, { role: 'assistant', text: '✏️ Vale — dime qué ajusto de la propuesta y te preparo una nueva versión.' }]);
    scroll();
  };

  const cancelProposal = () => {
    setProposal(null);
    setPreview(null);
    setChat((c) => [...c, { role: 'assistant', text: '❌ Cambio descartado. El prompt queda como estaba.' }]);
    scroll();
  };

  return (
    <div className="flex flex-col" style={{ height: compact ? '60vh' : '68vh' }}>
      <div className="scroll-thin flex-1 space-y-3 overflow-y-auto rounded-t-2xl bg-slate-50/50 p-4">
        {chat.length === 0 && (
          <div className="py-8 text-center text-sm text-slate-400">
            <Sparkles className="mx-auto mb-2 text-violet-400" size={22} />
            {mode === 'edit'
              ? 'Escribe qué quieres cambiar (puedes adjuntar imágenes de referencia). Te propondré los cambios y tú los aplicas.'
              : 'Cuéntame de tu negocio y tu cliente ideal. Te haré preguntas y armaré los 3 bloques del prompt.'}
          </div>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm shadow-sm ${m.role === 'user' ? 'rounded-br-md bg-violet-600 text-white' : 'rounded-bl-md border border-slate-200 bg-white text-slate-800'}`}>
              {m.images?.length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {m.images.map((src, j) => <img key={j} src={src} alt="" className="h-14 w-14 rounded-lg object-cover" />)}
                </div>
              )}
              {m.text}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-violet-100 px-3.5 py-3">
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {proposal && (
        <div className="border-x border-slate-100 bg-violet-50/50 p-3">
          <div className="mb-1 text-xs font-bold text-violet-700">✨ He preparado el cambio. Esto es lo que haría:</div>
          {(proposal.cambios || []).length > 0 && (
            <ul className="mb-2 space-y-0.5 text-xs text-slate-600">
              {proposal.cambios.map((c, i) => <li key={i}>• {c}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" className="!py-1.5 text-xs" onClick={openPreview}><Eye size={14} /> Ver antes / después</Button>
            <Button className="!py-1.5 text-xs" onClick={apply} loading={busy}><Check size={14} /> Aplicar</Button>
            <Button variant="secondary" className="!py-1.5 text-xs" onClick={modifyRequest}><PencilLine size={14} /> Modificar solicitud</Button>
            <Button variant="ghost" className="!py-1.5 text-xs" onClick={cancelProposal}><X size={14} /> Cancelar cambio</Button>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">Elige una opción para continuar (el chat queda en pausa mientras decides).</p>
        </div>
      )}

      {preview && proposal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setPreview(null)}>
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
              <h3 className="text-sm font-bold text-slate-800">👀 Antes / después del prompt</h3>
              <button onClick={() => setPreview(null)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"><X size={18} /></button>
            </div>
            <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-5">
              {BLOCKS.map((blk) => {
                const before = String(preview.current?.[blk.key] || '');
                const afterRaw = String(proposal[blk.key] || '');
                const changed = afterRaw.trim() && afterRaw !== before;
                return (
                  <div key={blk.key}>
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-700">{blk.label}</span>
                      {!changed && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400">sin cambios</span>}
                    </div>
                    {changed ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="rounded-xl border border-red-200 bg-red-50/40 p-2.5">
                          <div className="mb-1 text-[10px] font-bold uppercase text-red-400">Antes</div>
                          <pre className="scroll-thin max-h-48 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-slate-600">{before || '(vacío)'}</pre>
                        </div>
                        <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-2.5">
                          <div className="mb-1 text-[10px] font-bold uppercase text-emerald-500">Después</div>
                          <pre className="scroll-thin max-h-48 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-slate-700">{afterRaw}</pre>
                        </div>
                      </div>
                    ) : (
                      <pre className="scroll-thin max-h-24 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-400">{before || '(vacío)'}</pre>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
              <Button variant="ghost" onClick={() => setPreview(null)}>Volver</Button>
              <Button onClick={apply} loading={busy}><Check size={15} /> Aplicar estos cambios</Button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-b-2xl border-t border-slate-100 p-3 space-y-2">
        {error && <Banner tone="error">{error}</Banner>}
        {applied && !proposal && <p className="text-xs font-medium text-emerald-600">✅ Prompt actualizado.</p>}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((src, i) => (
              <div key={i} className="relative">
                <img src={src} alt="" className="h-12 w-12 rounded-lg object-cover" />
                <button onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} className="absolute -right-1 -top-1 rounded-full bg-slate-700 p-0.5 text-white"><X size={10} /></button>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={send} className="flex items-center gap-2">
          {mode === 'edit' && (
            <>
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />
              <button type="button" onClick={() => fileRef.current?.click()} title="Adjuntar imágenes (no se guardan)" className="rounded-xl border border-slate-300 p-2.5 text-slate-500 hover:border-violet-300 hover:text-violet-600">
                <Image size={16} />
              </button>
            </>
          )}
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={Boolean(proposal)}
            placeholder={proposal ? 'Elige una opción arriba para continuar…' : (mode === 'edit' ? 'Instrucciones de cambio…' : 'Escribe aquí…')}
            className="flex-1 rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-violet-400 focus:ring-4 focus:ring-violet-100 disabled:bg-slate-50 disabled:text-slate-400"
          />
          <Button type="submit" className="!px-3.5" loading={busy} disabled={Boolean(proposal)}><Send size={16} /></Button>
        </form>
      </div>
    </div>
  );
}
