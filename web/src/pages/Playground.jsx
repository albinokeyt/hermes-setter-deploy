import { useEffect, useRef, useState } from 'react';
import { Send, RotateCcw, FlaskConical, Wand2, X, Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { Card, SectionTitle, Button, Select, StagePill, Banner, EmptyState } from '../components/ui.jsx';
import { PromptArchitect } from '../components/PromptArchitect.jsx';

export default function Playground() {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [setters, setSetters] = useState([]);
  const [setterId, setSetterId] = useState('');
  const [history, setHistory] = useState([]);
  const [memory, setMemory] = useState({});
  const [importOpen, setImportOpen] = useState(false);
  const [spend, setSpend] = useState(null);
  const [meta, setMeta] = useState(null);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef(null);
  const timerRef = useRef(null);
  const historyRef = useRef([]);
  historyRef.current = history;
  const memoryRef = useRef({});
  memoryRef.current = memory;

  // 🗂️ Conversaciones de prueba guardadas (con sus correcciones y la versión del prompt)
  const [chats, setChats] = useState([]);
  const [chatId, setChatId] = useState(null);
  const [chatCorr, setChatCorr] = useState([]); // correcciones de la prueba seleccionada
  const chatIdRef = useRef(null);
  chatIdRef.current = chatId;
  // Token de generación: reiniciar / abrir otra prueba / cambiar de setter ABORTA la respuesta y el
  // guardado en vuelo (si no, los mensajes del setter anterior caían en la prueba nueva).
  const genRef = useRef(0);

  const loadChats = () => {
    if (!setterId) { setChats([]); return; }
    api.get(`/api/setters/${setterId}/playground-chats`).then(setChats).catch(() => setChats([]));
  };
  useEffect(() => { genRef.current++; clearTimeout(timerRef.current); loadChats(); setChatId(null); setChatCorr([]); }, [setterId]);

  const persistChat = async (hist, mem, sid, gen) => {
    if (genRef.current !== gen) return; // ya no es la prueba/setter activo
    if (!hist.some((m) => m.role === 'lead')) return; // nada que guardar (evita pruebas fantasma)
    try {
      let id = chatIdRef.current;
      if (!id) {
        const firstLead = hist.find((m) => m.role === 'lead');
        const created = await api.post(`/api/setters/${sid}/playground-chats`, { name: String(firstLead?.text || 'Prueba').slice(0, 40) });
        if (genRef.current !== gen) return;
        id = created.id;
        chatIdRef.current = id;
        setChatId(id);
      }
      await api.put(`/api/playground-chats/${id}`, { history: hist, memory: mem });
      loadChats();
    } catch { /* best-effort */ }
  };

  const openChat = async (id) => {
    genRef.current++;
    const gen = genRef.current;
    clearTimeout(timerRef.current); // ANTES del await: un debounce pendiente no debe disparar durante la carga
    try {
      const c = await api.get(`/api/playground-chats/${id}`);
      if (genRef.current !== gen) return;
      setHistory(Array.isArray(c.history) ? c.history : []);
      setMemory(c.memory && typeof c.memory === 'object' ? c.memory : {});
      setChatCorr(Array.isArray(c.corrections) ? c.corrections : []);
      setChatId(c.id);
      chatIdRef.current = c.id;
      setMeta(null); setError('');
    } catch (err) { setError(err.message); }
  };
  const renameChat = async (c) => {
    const name = window.prompt('Nombre de la prueba:', c.name);
    if (!name?.trim()) return;
    try { await api.put(`/api/playground-chats/${c.id}`, { name: name.trim() }); loadChats(); } catch (err) { setError(err.message); }
  };
  const deleteChat = async (c) => {
    if (!window.confirm(`¿Borrar la prueba «${c.name}»?`)) return;
    try { await api.del(`/api/playground-chats/${c.id}`); if (c.id === chatIdRef.current) reset(); loadChats(); } catch (err) { setError(err.message); }
  };
  // el corrector aplicó un cambio: se registra en la prueba activa y se refrescan las versiones
  const onCorrectionApplied = async (resumen) => {
    try {
      if (chatIdRef.current) {
        const upd = await api.put(`/api/playground-chats/${chatIdRef.current}`, { add_correction: resumen || 'cambio aplicado' });
        setChatCorr(Array.isArray(upd.corrections) ? upd.corrections : []);
      }
      loadChats();
    } catch { /* best-effort */ }
  };

  const loadSpend = () => api.get('/api/playground/spend').then(setSpend).catch(() => {});
  useEffect(() => {
    api.get('/api/accounts').then((a) => { setAccounts(a); if (a[0]) setAccountId(String(a[0].id)); }).catch(() => {});
    loadSpend();
    return () => clearTimeout(timerRef.current);
  }, []);

  // al cambiar de conexión, cargar sus setters y preseleccionar el principal
  useEffect(() => {
    if (!accountId) return;
    api.get(`/api/accounts/${accountId}/setters`)
      .then((list) => { setSetters(list); setSetterId(list.length ? String((list.find((s) => s.is_default) || list[0]).id) : ''); })
      .catch(() => { setSetters([]); setSetterId(''); });
  }, [accountId]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [history, thinking]);

  const askBot = async () => {
    setThinking(true);
    setError('');
    const gen = genRef.current;
    const sid = setterId;
    try {
      const r = await api.post('/api/playground/reply', { account_id: Number(accountId), setter_id: setterId ? Number(setterId) : undefined, history: historyRef.current, memory: memoryRef.current });
      if (genRef.current !== gen) return; // reiniciaron / cambiaron de prueba mientras respondía
      loadSpend();
      setMemory(r.memoria_final || {});
      setMeta({ etiqueta: r.etiqueta, motivo: r.motivo, handoff: r.handoff });
      for (let i = 0; i < r.mensajes.length; i++) {
        await new Promise((res) => setTimeout(res, Math.min(r.delays?.[i] || 1500, 3500)));
        if (genRef.current !== gen) return;
        setHistory((h) => [...h, { role: 'bot', text: r.mensajes[i] }]);
      }
      // guardar la prueba (historial + memoria) para poder retomarla aunque navegues a otra sección
      setTimeout(() => persistChat(historyRef.current, memoryRef.current, sid, gen), 100);
    } catch (err) {
      if (genRef.current === gen) setError(err.message);
    } finally {
      setThinking(false);
    }
  };

  const sendLead = (e) => {
    e.preventDefault();
    if (!text.trim() || !accountId) return;
    setHistory((h) => [...h, { role: 'lead', text: text.trim() }]);
    setText('');
    // simula el debounce real: espera por si escribes más mensajes seguidos
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(askBot, 4000);
  };

  const reset = () => { genRef.current++; clearTimeout(timerRef.current); setHistory([]); setMemory({}); setMeta(null); setError(''); setChatId(null); chatIdRef.current = null; setChatCorr([]); };

  if (accounts.length === 0) {
    return (
      <div>
        <SectionTitle tour="page:prueba" title="Probar agente" subtitle="Simula ser un lead y mira cómo responde tu setter" />
        <EmptyState icon={FlaskConical} title="Primero crea una cuenta" subtitle="Necesitas una cuenta con prompt y proveedor de IA configurados para probar el agente." />
      </div>
    );
  }

  return (
    <div>
      <SectionTitle
        tour="page:prueba"
        title="Probar agente"
        subtitle="Escribe como si fueras el lead. El bot espera unos segundos (debounce real) y responde en varios mensajes."
        actions={
          <div className="flex items-center gap-2">
            {accounts.length > 1 && (
              <Select value={accountId} onChange={(e) => { setAccountId(e.target.value); setSetterId(''); reset(); }} className="!w-44" title="Conexión">
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.alias || a.name}</option>)}
              </Select>
            )}
            {setters.length > 0 && (
              <Select value={setterId} onChange={(e) => { setSetterId(e.target.value); reset(); }} className="!w-48" title="Setter a probar">
                {setters.map((s) => <option key={s.id} value={s.id}>🤖 {s.name}</option>)}
              </Select>
            )}
            <Button variant="secondary" onClick={reset}><RotateCcw size={15} /> Reiniciar</Button>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-4">
        {/* 🗂️ Pruebas guardadas de este setter: retomar, renombrar, borrar; vN = versión del prompt */}
        <Card className="flex h-[65vh] flex-col overflow-hidden">
          <button onClick={reset} className="flex items-center justify-center gap-1.5 border-b border-slate-100 px-2 py-2.5 text-xs font-semibold text-violet-600 hover:bg-violet-50">
            <Plus size={14} /> Nueva prueba
          </button>
          <div className="scroll-thin flex-1 overflow-y-auto">
            {chats.length === 0 && <p className="px-3 py-6 text-center text-[11px] text-slate-400">Aún no hay pruebas guardadas de este setter.</p>}
            {chats.map((c) => (
              <div key={c.id} className={`group flex items-center gap-1 border-b border-slate-50 px-2.5 py-2 text-[11px] ${c.id === chatId ? 'bg-violet-50' : 'hover:bg-slate-50'}`}>
                <button onClick={() => openChat(c.id)} className="min-w-0 flex-1 text-left">
                  <span className={`block truncate font-medium ${c.id === chatId ? 'text-violet-700' : 'text-slate-700'}`}>{c.name}</span>
                  <span className="text-[10px] text-slate-400">
                    {new Date(c.updated_at).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })} · {c.n} msg
                    {c.version_num > 0 && <span className="ml-1 rounded bg-violet-100 px-1 font-semibold text-violet-600">v{c.version_num}</span>}
                    {c.n_corr > 0 && <span className="ml-1 rounded bg-amber-100 px-1 font-semibold text-amber-600">✏️{c.n_corr}</span>}
                  </span>
                </button>
                <button onClick={() => renameChat(c)} title="Renombrar" className="hidden shrink-0 text-slate-300 hover:text-violet-600 group-hover:block"><Pencil size={12} /></button>
                <button onClick={() => deleteChat(c)} title="Borrar" className="hidden shrink-0 text-slate-300 hover:text-red-500 group-hover:block"><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
          <p className="border-t border-slate-100 px-2.5 py-1.5 text-[10px] text-slate-400">vN = versión del prompt con la que quedó esa prueba.</p>
        </Card>

        <Card className="flex h-[65vh] flex-col lg:col-span-2">
          <div className="scroll-thin flex-1 space-y-3 overflow-y-auto bg-slate-50/50 px-5 py-4">
            {history.length === 0 && (
              <p className="py-16 text-center text-sm text-slate-400">
                Escribe abajo como lead. Prueba a mandar varios mensajes seguidos<br />("hola" … "quería info") y verás que responde a todo junto 😉
              </p>
            )}
            {history.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'bot' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                  m.role === 'bot' ? 'rounded-br-md bg-violet-600 text-white' : 'rounded-bl-md border border-slate-200 bg-white text-slate-800'
                }`}>
                  {m.text}
                </div>
              </div>
            ))}
            {thinking && (
              <div className="flex justify-end">
                <div className="flex items-center gap-1 rounded-2xl rounded-br-md bg-violet-100 px-4 py-3">
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <form onSubmit={sendLead} className="flex items-center gap-2 border-t border-slate-100 px-4 py-3">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Escribe como el lead…"
              className="flex-1 rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-violet-400 focus:ring-4 focus:ring-violet-100"
            />
            <Button type="submit" className="!px-3.5"><Send size={16} /></Button>
          </form>
        </Card>

        <div className="space-y-4">
          {error && <Banner tone="error">{error}</Banner>}
          <Card className="p-5">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">Decisión del agente</h3>
            {meta ? (
              <div className="space-y-2.5">
                <StagePill stage={meta.etiqueta || 'nuevo'} />
                {meta.motivo && <p className="text-xs text-slate-500">{meta.motivo}</p>}
                {meta.handoff && <Banner tone="warn">El agente pidió pasar a un humano</Banner>}
              </div>
            ) : (
              <p className="text-xs text-slate-400">Habla con el bot y aquí verás qué etiqueta decide y por qué.</p>
            )}
          </Card>
          <Card className="p-5">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">Memoria que va construyendo</h3>
            {Object.keys(memory).length === 0 ? (
              <p className="text-xs text-slate-400">Vacía. Cuéntale cosas (tu nombre, tu negocio…) y mira cómo las guarda.</p>
            ) : (
              <dl className="space-y-1.5">
                {Object.entries(memory).map(([k, v]) => (
                  <div key={k} className="text-xs">
                    <dt className="font-semibold capitalize text-slate-500">{k.replaceAll('_', ' ')}</dt>
                    <dd className="text-slate-700">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>

          <Card className="p-5">
            <h3 className="mb-2 text-sm font-semibold text-slate-700">💸 Gastado en pruebas</h3>
            {spend ? (
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold text-slate-900">${Number(spend.costo || 0).toFixed(4)}</span>
                <span className="text-[11px] text-slate-400">{spend.llamadas} llamadas (pruebas y ajustes de prompt)</span>
              </div>
            ) : (
              <p className="text-xs text-slate-400">—</p>
            )}
          </Card>

          {chatCorr.length > 0 && (
            <Card className="p-5">
              <h3 className="mb-2 text-sm font-semibold text-slate-700">✏️ Correcciones de esta prueba</h3>
              <ul className="scroll-thin max-h-40 space-y-1.5 overflow-y-auto">
                {chatCorr.map((c, i) => (
                  <li key={i} className="text-[11px] text-slate-600">
                    <span className="text-slate-400">{new Date(c.fecha).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}</span> · {c.texto}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="p-5">
            <h3 className="mb-1 text-sm font-semibold text-slate-700">Ajustar el prompt</h3>
            <p className="mb-3 text-xs text-slate-400">¿Ves algo que mejorar mientras pruebas? Dile los cambios (con imágenes si quieres) y los aplica a los 3 bloques.</p>
            <Button variant="secondary" className="w-full" onClick={() => setImportOpen(true)} disabled={!setterId}>
              <Wand2 size={15} /> Importar cambio
            </Button>
          </Card>
        </div>
      </div>

      {importOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setImportOpen(false)}>
          <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
              <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Wand2 size={16} className="text-violet-600" /> Importar cambio al prompt</h3>
              <button onClick={() => setImportOpen(false)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"><X size={18} /></button>
            </div>
            <div className="p-3">
              <PromptArchitect
                targetPath={`/api/setters/${setterId}`}
                mode="edit" compact onApplied={onCorrectionApplied}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
