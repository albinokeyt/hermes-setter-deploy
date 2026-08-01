import { useEffect, useRef, useState } from 'react';
import { Send, Image, X, Check, Sparkles, Eye, PencilLine, Plus, Trash2, Pencil, MessagesSquare } from 'lucide-react';
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

  // 💬 Gestión de conversaciones (persisten en el servidor: al navegar no se pierde nada)
  const [chats, setChats] = useState([]);
  const [chatId, setChatId] = useState(null);
  const chatIdRef = useRef(null);
  chatIdRef.current = chatId;
  // Token de generación: cambiar de conversación/setter invalida los envíos y guardados EN VUELO
  // (si no, la respuesta del setter anterior aparecía bajo el nuevo, o se guardaba donde no era).
  const genRef = useRef(0);
  // Cola de guardado: serializa los persist para que dos seguidos no creen DOS conversaciones.
  const persistQueueRef = useRef(Promise.resolve());

  const loadChats = () => api.get(`${base}/editor-chats?mode=${mode}`).then(setChats).catch(() => {});
  useEffect(() => {
    genRef.current++;
    loadChats();
    setChat([]); setChatId(null); chatIdRef.current = null;
    setProposal(null); setPreview(null); setText(''); setImages([]); setError(''); setApplied(false);
  }, [base, mode]);

  // Guarda la conversación (crea una si aún no existe). Serializado y atado a la generación.
  const persist = (msgs) => {
    const gen = genRef.current;
    persistQueueRef.current = persistQueueRef.current.then(async () => {
      if (genRef.current !== gen) return; // el usuario ya cambió de conversación/setter
      try {
        let id = chatIdRef.current;
        if (!id) {
          const firstUser = msgs.find((m) => m.role === 'user');
          const created = await api.post(`${base}/editor-chats`, { mode, name: String(firstUser?.text || 'Conversación').slice(0, 40) });
          if (genRef.current !== gen) return; // no adoptar un chat creado para otra generación
          id = created.id;
          chatIdRef.current = id; // sync inmediato: el siguiente persist de la cola ya lo ve
          setChatId(id);
        }
        await api.put(`/api/editor-chats/${id}`, {
          messages: msgs.map((m) => ({ role: m.role, text: m.text || (m.images?.length ? '(imagen adjunta)' : '') })),
        });
        loadChats();
      } catch { /* persistencia best-effort */ }
    });
    return persistQueueRef.current;
  };

  const openChat = async (id) => {
    genRef.current++;
    const gen = genRef.current;
    try {
      const c = await api.get(`/api/editor-chats/${id}`);
      if (genRef.current !== gen) return;
      setChat(Array.isArray(c.messages) ? c.messages : []);
      setChatId(c.id);
      chatIdRef.current = c.id;
      setProposal(null); setPreview(null); setError(''); setApplied(false);
      scroll();
    } catch (err) { setError(err.message); }
  };
  const newChat = () => {
    genRef.current++;
    setChat([]); setChatId(null); chatIdRef.current = null;
    setProposal(null); setPreview(null); setError(''); setApplied(false);
  };
  const renameChat = async (c) => {
    const name = window.prompt('Nombre de la conversación:', c.name);
    if (!name?.trim()) return;
    try { await api.put(`/api/editor-chats/${c.id}`, { name: name.trim() }); loadChats(); } catch (err) { setError(err.message); }
  };
  const deleteChat = async (c) => {
    if (!window.confirm(`¿Borrar la conversación «${c.name}»?`)) return;
    try { await api.del(`/api/editor-chats/${c.id}`); if (c.id === chatIdRef.current) newChat(); loadChats(); } catch (err) { setError(err.message); }
  };

  const scroll = () => setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);

  // Comprime en el navegador (máx 1280px, JPEG): una foto de móvil en base64 pesa varios MB y dispara
  // los tokens del modelo (o revienta el límite del proveedor) — causa típica del "foto+texto da error".
  const compressImage = (file) => new Promise((resolve) => {
    const img = new window.Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });

  const addImages = (files) => {
    [...files].slice(0, 4).forEach(async (f) => {
      if (!f.type.startsWith('image/')) return;
      const data = await compressImage(f);
      if (data) setImages((prev) => [...prev, data].slice(0, 4));
    });
  };

  const send = async (e) => {
    e?.preventDefault?.();
    if (busy || proposal) return; // no enviar mientras procesa o hay una propuesta pendiente
    const msg = text.trim();
    if (!msg && !images.length) return;
    setError('');
    setProposal(null);
    const shownImgs = images;
    const afterUser = [...chat, { role: 'user', text: msg, images: shownImgs }];
    setChat(afterUser);
    const history = chat.map((m) => ({ role: m.role, text: m.text }));
    setText('');
    setImages([]);
    setBusy(true);
    scroll();
    const gen = genRef.current; // si el usuario cambia de conversación mientras responde, se descarta
    try {
      const r = await api.post(`${base}/prompt-editor`, { history, message: msg, images: shownImgs, mode });
      if (genRef.current !== gen) return;
      const afterAssistant = [...afterUser, { role: 'assistant', text: r.reply }];
      setChat(afterAssistant);
      if (r.proposal) setProposal(r.proposal);
      persist(afterAssistant);
    } catch (err) {
      if (genRef.current !== gen) return;
      const afterErr = [...afterUser, { role: 'assistant', text: `⚠️ ${err.message}` }];
      setChat(afterErr);
      persist(afterErr);
    } finally {
      setBusy(false);
      scroll();
    }
  };

  const apply = async () => {
    if (!proposal) return;
    setBusy(true);
    const gen = genRef.current; // si abren otra conversación con el PUT en vuelo, no pisar su chat
    try {
      // solo aplicamos las secciones con contenido (no borramos un bloque por una propuesta vacía)
      const patch = { prompt_source: mode === 'edit' ? 'corrector' : 'arquitecto' };
      if (proposal.prompt_identity?.trim()) patch.prompt_identity = proposal.prompt_identity;
      if (proposal.prompt_business?.trim()) patch.prompt_business = proposal.prompt_business;
      if (proposal.prompt_flow?.trim()) patch.prompt_flow = proposal.prompt_flow;
      await api.put(base, patch);
      const resumen = (proposal.cambios || []).join(' · ') || 'cambio aplicado';
      onApplied?.(resumen); // el prompt del setter SÍ quedó aplicado, pase lo que pase con la UI
      if (genRef.current !== gen) return; // cambiaron de conversación: no pisar su chat ni su guardado
      setApplied(true);
      setProposal(null);
      setPreview(null);
      const after = [...chat, { role: 'assistant', text: '✅ Cambios aplicados. La versión anterior quedó guardada en el Historial por si quieres volver atrás.' }];
      setChat(after);
      persist(after);
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
    const after = [...chat, { role: 'assistant', text: '✏️ Vale — dime qué ajusto de la propuesta y te preparo una nueva versión.' }];
    setChat(after);
    persist(after);
    scroll();
  };

  const cancelProposal = () => {
    setProposal(null);
    setPreview(null);
    const after = [...chat, { role: 'assistant', text: '❌ Cambio descartado. El prompt queda como estaba.' }];
    setChat(after);
    persist(after);
    scroll();
  };

  return (
    <div className="flex gap-3" style={{ height: compact ? '60vh' : '68vh' }}>
      {/* 💬 Conversaciones guardadas: crear, retomar, renombrar y borrar (persisten en el servidor) */}
      <aside className="flex w-44 shrink-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <button onClick={newChat} className="flex items-center justify-center gap-1.5 border-b border-slate-100 px-2 py-2.5 text-xs font-semibold text-violet-600 hover:bg-violet-50">
          <Plus size={14} /> Nueva conversación
        </button>
        <div className="scroll-thin flex-1 overflow-y-auto">
          {chats.length === 0 && (
            <p className="px-3 py-6 text-center text-[11px] text-slate-400"><MessagesSquare size={16} className="mx-auto mb-1" />Aún no hay conversaciones guardadas.</p>
          )}
          {chats.map((c) => (
            <div key={c.id} className={`group flex items-center gap-1 border-b border-slate-50 px-2.5 py-2 text-left text-[11px] ${c.id === chatId ? 'bg-violet-50' : 'hover:bg-slate-50'}`}>
              <button onClick={() => openChat(c.id)} className="min-w-0 flex-1 text-left">
                <span className={`block truncate font-medium ${c.id === chatId ? 'text-violet-700' : 'text-slate-700'}`}>{c.name}</span>
                <span className="text-[10px] text-slate-400">{new Date(c.updated_at).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })} · {c.n} msg</span>
              </button>
              <button onClick={() => renameChat(c)} title="Renombrar" className="hidden shrink-0 text-slate-300 hover:text-violet-600 group-hover:block"><Pencil size={12} /></button>
              <button onClick={() => deleteChat(c)} title="Borrar" className="hidden shrink-0 text-slate-300 hover:text-red-500 group-hover:block"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200">
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
        <form onSubmit={send} className="flex items-end gap-2">
          {mode === 'edit' && (
            <>
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />
              <button type="button" onClick={() => fileRef.current?.click()} title="Adjuntar imágenes (no se guardan)" className="rounded-xl border border-slate-300 p-2.5 text-slate-500 hover:border-violet-300 hover:text-violet-600">
                <Image size={16} />
              </button>
            </>
          )}
          {/* Párrafo adaptable (crece hacia abajo), Enter envía y Shift+Enter hace salto de línea.
              Bloqueado mientras la IA procesa (antes se podía seguir escribiendo y enviando). */}
          <textarea
            value={text}
            rows={1}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            disabled={busy || Boolean(proposal)}
            placeholder={busy ? '⏳ Espera… la IA está preparando el cambio' : proposal ? 'Elige una opción arriba para continuar…' : (mode === 'edit' ? 'Instrucciones de cambio… (Shift+Enter = salto de línea)' : 'Escribe aquí… (Shift+Enter = salto de línea)')}
            className="scroll-thin max-h-40 flex-1 resize-none rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm leading-relaxed outline-none focus:border-violet-400 focus:ring-4 focus:ring-violet-100 disabled:bg-slate-50 disabled:text-slate-400"
          />
          <Button type="submit" className="!px-3.5" loading={busy} disabled={busy || Boolean(proposal)}><Send size={16} /></Button>
        </form>
      </div>
      </div>
    </div>
  );
}
