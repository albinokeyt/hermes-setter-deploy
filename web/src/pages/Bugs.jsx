import { useEffect, useRef, useState } from 'react';
import { Bug, Image, X, CheckCircle2, RotateCcw, MessageCircle } from 'lucide-react';
import { api } from '../api.js';
import { useMe } from '../components/Layout.jsx';
import { Card, SectionTitle, Button, Select, Banner } from '../components/ui.jsx';

const TIPOS = [
  { value: 'sistema', label: '🖥️ Error del sistema (panel, algo no carga o falla)' },
  { value: 'setter', label: '🤖 Error del agente setter (respondió mal, no respondió…)' },
  { value: 'facturacion', label: '💸 Facturación / consumo' },
  { value: 'otro', label: '❓ Otro' },
];
const TIPO_BADGE = { sistema: 'bg-blue-50 text-blue-700', setter: 'bg-violet-50 text-violet-700', facturacion: 'bg-amber-50 text-amber-700', otro: 'bg-slate-100 text-slate-600' };

export default function Bugs() {
  const me = useMe();
  const isAdmin = me?.role === 'admin';
  const [bugs, setBugs] = useState(null);
  const [tipo, setTipo] = useState('sistema');
  const [descripcion, setDescripcion] = useState('');
  const [imagenes, setImagenes] = useState([]); // hasta 5 capturas por reporte
  const [sending, setSending] = useState(false);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState('');
  const [viewImgs, setViewImgs] = useState(null); // lista de data URLs abierta en modal
  const [almacen, setAlmacen] = useState(null); // admin: espacio ocupado por capturas
  const [purgando, setPurgando] = useState(false);
  const [replying, setReplying] = useState(null); // { id, texto } — respuesta del admin en edición
  const fileRef = useRef(null);

  const load = () => api.get('/api/bugs').then((r) => setBugs(r.bugs || [])).catch(() => setBugs([]));
  const loadAlmacen = () => { if (isAdmin) api.get('/api/bugs/almacen').then(setAlmacen).catch(() => {}); };
  useEffect(() => { load(); loadAlmacen(); }, [isAdmin]);

  // comprime la captura en el navegador (máx 1400px) para que suba rápido y no pese
  const addImage = (file) => {
    if (!file?.type?.startsWith('image/')) return;
    const img = new window.Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      setImagenes((list) => (list.length >= 5 ? list : [...list, canvas.toDataURL('image/jpeg', 0.85)]));
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!descripcion.trim()) return;
    setSending(true); setError(''); setOk(false);
    try {
      await api.post('/api/bugs', { tipo, descripcion: descripcion.trim(), imagenes });
      setDescripcion(''); setImagenes([]); setTipo('sistema');
      setOk(true); setTimeout(() => setOk(false), 3000);
      load(); loadAlmacen();
    } catch (err) { setError(err.message); } finally { setSending(false); }
  };

  const toggleStatus = async (b) => {
    try {
      await api.put(`/api/bugs/${b.id}`, { status: b.status === 'abierto' ? 'resuelto' : 'abierto' });
      load();
    } catch (err) { setError(err.message); }
  };

  // respuesta del admin al reporte (el usuario la ve en el suyo)
  const saveReply = async (id, texto, alsoResolve) => {
    try {
      const body = { respuesta: texto };
      if (alsoResolve) body.status = 'resuelto';
      await api.put(`/api/bugs/${id}`, body);
      setReplying(null);
      load();
    } catch (err) { setError(err.message); }
  };

  const openImages = async (b) => {
    try { const r = await api.get(`/api/bugs/${b.id}/imagenes`); if (r.imagenes?.length) setViewImgs(r.imagenes); } catch { /* noop */ }
  };

  // 🧹 admin: vaciar TODAS las capturas de TODOS los reportes (los textos se conservan)
  const purgarImagenes = async () => {
    const mb = almacen ? (almacen.bytes / 1e6).toFixed(1) : '?';
    if (!window.confirm(`Se borrarán TODAS las capturas de TODOS los reportes (~${mb} MB) para liberar espacio. Los textos y respuestas se conservan. ¿Continuar?`)) return;
    if (!window.confirm('Confírmalo de nuevo: las capturas no se pueden recuperar.')) return;
    setPurgando(true);
    try { await api.del('/api/bugs/imagenes'); load(); loadAlmacen(); }
    catch (err) { setError(err.message); } finally { setPurgando(false); }
  };

  return (
    <div>
      <SectionTitle tour="page:errores" title="🐞 Reportar errores" subtitle={isAdmin ? 'Todos los errores reportados por los usuarios (fecha, usuario, subcuenta y tipo).' : 'Cuéntanos qué falló y lo revisamos. Puedes adjuntar una captura.'} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card data-tour="bugs-form" className="p-5 lg:col-span-1">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Nuevo reporte</h3>
          <form onSubmit={submit} className="space-y-3">
            <Select label="¿Qué tipo de error es?" value={tipo} onChange={(e) => setTipo(e.target.value)}>
              {TIPOS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
            <div>
              <span className="mb-1 block text-sm font-medium text-slate-700">¿Qué pasó?</span>
              <textarea
                value={descripcion}
                rows={4}
                onChange={(e) => { setDescripcion(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 260) + 'px'; }}
                placeholder="Describe el error: qué hiciste, qué esperabas y qué pasó…"
                className="scroll-thin w-full resize-none rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm leading-relaxed outline-none focus:border-violet-400 focus:ring-4 focus:ring-violet-100"
              />
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { const files = Array.from(e.target.files || []); const libres = Math.max(0, 5 - imagenes.length); files.slice(0, libres).forEach(addImage); if (files.length > libres) setError(`Máximo 5 capturas por reporte: se descartaron ${files.length - libres}.`); e.target.value = ''; }} />
            {imagenes.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {imagenes.map((img, idx) => (
                  <div key={idx} className="relative inline-block">
                    <img src={img} alt={`captura ${idx + 1}`} className="h-20 rounded-xl border border-slate-200 object-cover" />
                    <button type="button" onClick={() => setImagenes((list) => list.filter((_, j) => j !== idx))} className="absolute -right-1.5 -top-1.5 rounded-full bg-slate-700 p-0.5 text-white"><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}
            {imagenes.length < 5 && (
              <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
                <Image size={15} /> {imagenes.length ? `Añadir otra captura (${imagenes.length}/5)` : 'Adjuntar capturas'}
              </Button>
            )}
            {error && <Banner tone="error">{error}</Banner>}
            {ok && <p className="text-xs font-medium text-emerald-600">✅ Reporte enviado. ¡Gracias!</p>}
            <Button type="submit" className="w-full" loading={sending} disabled={!descripcion.trim()}><Bug size={15} /> Enviar reporte</Button>
          </form>
        </Card>

        <Card data-tour="bugs-lista" className="overflow-hidden lg:col-span-2">
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
            <h3 className="text-sm font-semibold text-slate-700">{isAdmin ? 'Reportes de todos los usuarios' : 'Tus reportes'}</h3>
            {isAdmin && almacen && almacen.bytes > 0 && (
              <button onClick={purgarImagenes} disabled={purgando} title="Borra TODAS las capturas de todos los reportes (los textos se conservan) para liberar espacio en disco"
                className="shrink-0 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-50">
                {purgando ? 'Liberando…' : `🧹 Liberar espacio (${(almacen.bytes / 1e6).toFixed(1)} MB en capturas)`}
              </button>
            )}
          </div>
          <div className="scroll-thin max-h-[70vh] overflow-y-auto">
            {bugs === null && <p className="px-5 py-10 text-center text-sm text-slate-400">Cargando…</p>}
            {bugs?.length === 0 && <p className="px-5 py-10 text-center text-sm text-slate-400">Sin reportes todavía. 🎉</p>}
            {bugs?.map((b) => (
              <div key={b.id} className="border-b border-slate-50 px-5 py-3">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
                  <span className={`rounded-md px-1.5 py-0.5 font-semibold ${TIPO_BADGE[b.tipo] || TIPO_BADGE.otro}`}>{TIPOS.find((t) => t.value === b.tipo)?.label.split(' ')[0]} {b.tipo}</span>
                  <span className={`rounded-md px-1.5 py-0.5 font-semibold ${b.status === 'resuelto' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'}`}>{b.status}</span>
                  <span className="text-slate-400">{new Date(b.created_at).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  {isAdmin && <span className="font-medium text-slate-500">👤 {b.reporter || '—'}</span>}
                  {isAdmin && b.account_name && <span className="text-slate-400">· {b.account_name}</span>}
                </div>
                <p className="whitespace-pre-wrap text-sm text-slate-700">{b.descripcion}</p>

                {/* respuesta del equipo: la ve también el usuario que reportó */}
                {b.respuesta && replying?.id !== b.id && (
                  <div className="mt-2 rounded-xl border border-violet-100 bg-violet-50/60 p-2.5">
                    <div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-violet-700">
                      <MessageCircle size={12} /> Respuesta del equipo
                      {b.respondida_at && <span className="font-normal text-violet-400">· {new Date(b.respondida_at).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}</span>}
                    </div>
                    <p className="whitespace-pre-wrap text-xs text-slate-700">{b.respuesta}</p>
                  </div>
                )}

                {/* editor de respuesta (solo admin) */}
                {isAdmin && replying?.id === b.id && (
                  <div className="mt-2 space-y-2">
                    <textarea
                      value={replying.texto}
                      rows={3}
                      autoFocus
                      onChange={(e) => setReplying({ ...replying, texto: e.target.value })}
                      placeholder="Escribe la respuesta para el usuario…"
                      className="scroll-thin w-full resize-none rounded-xl border border-violet-300 px-3 py-2 text-xs leading-relaxed outline-none focus:ring-4 focus:ring-violet-100"
                    />
                    <div className="flex gap-2">
                      <Button className="!py-1 text-xs" onClick={() => saveReply(b.id, replying.texto, false)} disabled={!replying.texto.trim() && !b.respuesta}>Responder</Button>
                      <Button variant="secondary" className="!py-1 text-xs" onClick={() => saveReply(b.id, replying.texto, true)} disabled={!replying.texto.trim()}>Responder y resolver</Button>
                      <Button variant="ghost" className="!py-1 text-xs" onClick={() => setReplying(null)}>Cancelar</Button>
                    </div>
                  </div>
                )}

                <div className="mt-1.5 flex items-center gap-3">
                  {Number(b.n_imagenes) > 0 && <button onClick={() => openImages(b)} className="text-xs font-semibold text-violet-600 hover:underline">📷 Ver capturas ({b.n_imagenes})</button>}
                  {isAdmin && replying?.id !== b.id && (
                    <button onClick={() => setReplying({ id: b.id, texto: b.respuesta || '' })} className="flex items-center gap-1 text-xs font-semibold text-violet-600 hover:underline">
                      <MessageCircle size={13} /> {b.respuesta ? 'Editar respuesta' : 'Responder'}
                    </button>
                  )}
                  {isAdmin && (
                    <button onClick={() => toggleStatus(b)} className="flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-emerald-600">
                      {b.status === 'abierto' ? <><CheckCircle2 size={13} /> Marcar resuelto</> : <><RotateCcw size={13} /> Reabrir</>}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {viewImgs && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setViewImgs(null)}>
          <div className="scroll-thin max-h-[92vh] w-full max-w-3xl space-y-3 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            {viewImgs.map((img, idx) => (
              <img key={idx} src={img} alt={`captura ${idx + 1}`} className="w-full rounded-xl shadow-2xl" />
            ))}
            <button onClick={() => setViewImgs(null)} className="mx-auto block rounded-xl bg-white/90 px-4 py-2 text-sm font-semibold text-slate-700">Cerrar</button>
          </div>
        </div>
      )}
    </div>
  );
}
