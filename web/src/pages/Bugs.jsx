import { useEffect, useRef, useState } from 'react';
import { Bug, Image, X, MessageCircle } from 'lucide-react';
import { ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts';
import { api } from '../api.js';
import { useMe } from '../components/Layout.jsx';
import { Card, SectionTitle, Button, Select, Banner } from '../components/ui.jsx';

const TIPOS = [
  { value: 'sistema', label: '🖥️ Error del sistema (panel, algo no carga o falla)' },
  { value: 'setter', label: '🤖 Error del agente setter (respondió mal, no respondió…)' },
  { value: 'facturacion', label: '💸 Facturación / consumo' },
  { value: 'otro', label: '❓ Otro' },
];
const TIPO_CORTO = { sistema: '🖥️ sistema', setter: '🤖 setter', facturacion: '💸 facturación', otro: '❓ otro' };
const TIPO_BADGE = { sistema: 'bg-blue-50 text-blue-700', setter: 'bg-violet-50 text-violet-700', facturacion: 'bg-amber-50 text-amber-700', otro: 'bg-slate-100 text-slate-600' };
// abierto → en curso → resuelto (el admin mueve el estado; el usuario lo ve)
const ESTADOS = [
  { value: 'abierto', label: 'Abierto', badge: 'bg-red-50 text-red-500' },
  { value: 'en_curso', label: 'En curso', badge: 'bg-amber-50 text-amber-600' },
  { value: 'resuelto', label: 'Resuelto', badge: 'bg-emerald-50 text-emerald-600' },
];
const estadoDe = (v) => ESTADOS.find((e) => e.value === v) || ESTADOS[0];

const dstr = (d) => d.toISOString().slice(0, 10); // dia UTC (solo para iterar el eje en UTC)
const dstrLocal = (d) => d.toLocaleDateString('sv-SE'); // YYYY-MM-DD en la zona del navegador (la misma del grafico)
const hoy = () => dstrLocal(new Date());
const hace = (dias) => dstrLocal(new Date(Date.now() - dias * 86400000));

// 📈 Incidencias y resoluciones por día — o por HORAS si el rango es un solo día (solo admin)
function BugsChart({ from, to, setFrom, setTo, refreshKey, accountId }) {
  const [data, setData] = useState(null);
  const [preset, setPreset] = useState('30d');

  useEffect(() => {
    if (!from || !to || from > to) return;
    let vivo = true; // dos cambios de rango seguidos: la respuesta vieja no debe pisar a la nueva
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    api.get(`/api/bugs/stats?from=${from}&to=${to}&tz=${encodeURIComponent(tz)}${accountId ? `&account_id=${accountId}` : ''}`)
      .then((r) => {
        if (!vivo) return;
        // eje continuo: horas 00-23 del día, o cada día del rango (los huecos, a 0)
        const inc = Object.fromEntries((r.incidencias || []).map((x) => [x.bucket, x.n]));
        const res = Object.fromEntries((r.resoluciones || []).map((x) => [x.bucket, x.n]));
        const puntos = [];
        if (r.por_horas) {
          for (let h = 0; h < 24; h++) {
            const b = `${String(h).padStart(2, '0')}:00`;
            puntos.push({ x: b, incidencias: inc[b] || 0, resoluciones: res[b] || 0 });
          }
        } else {
          // iterar en UTC puro: con new Date('...T00:00:00') (medianoche LOCAL) en zonas UTC+ salia
          // una barra fantasma del dia anterior al rango
          for (let d = new Date(`${from}T00:00:00Z`); dstr(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
            const b = dstr(d);
            puntos.push({ x: b.slice(8, 10) + '/' + b.slice(5, 7), incidencias: inc[b] || 0, resoluciones: res[b] || 0 });
          }
        }
        setData(puntos);
      })
      .catch(() => { if (vivo) setData([]); });
    return () => { vivo = false; };
  }, [from, to, refreshKey, accountId]);

  const aplicar = (key, f, t) => { setPreset(key); setFrom(f); setTo(t); };

  return (
    <Card data-tour="bugs-grafico" className="mb-4 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-700">📈 Incidencias y resoluciones {from === to ? '· por horas' : '· por día'}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {[
            { key: 'hoy', label: 'Hoy', f: hoy(), t: hoy() },
            { key: '7d', label: '7 días', f: hace(6), t: hoy() },
            { key: '30d', label: '30 días', f: hace(29), t: hoy() },
          ].map((p) => (
            <button key={p.key} onClick={() => aplicar(p.key, p.f, p.t)}
              className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition ${preset === p.key ? 'bg-violet-600 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>
              {p.label}
            </button>
          ))}
          <input type="date" value={from} max={to} onChange={(e) => { setPreset('custom'); setFrom(e.target.value); }}
            className="rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-violet-400" />
          <span className="text-slate-400">→</span>
          <input type="date" value={to} min={from} max={hoy()} onChange={(e) => { setPreset('custom'); setTo(e.target.value); }}
            className="rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-violet-400" />
        </div>
      </div>
      <div className="h-48">
        {data === null ? (
          <p className="pt-16 text-center text-xs text-slate-400">Cargando…</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="x" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} minTickGap={16} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} />
              <Bar dataKey="incidencias" name="Incidencias" fill="#8b5cf6" radius={[4, 4, 0, 0]} maxBarSize={26} />
              <Bar dataKey="resoluciones" name="Resoluciones" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={26} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

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
  // admin: rango del gráfico (también filtra la lista) + filtros de estado y tipo
  const [from, setFrom] = useState(hace(29));
  const [to, setTo] = useState(hoy());
  const [fEstado, setFEstado] = useState('');
  const [fConexion, setFConexion] = useState('');
  const [cuentas, setCuentas] = useState([]);
  const [fTipo, setFTipo] = useState('');
  const [statsKey, setStatsKey] = useState(0); // re-pinta el gráfico tras resolver/crear
  const fileRef = useRef(null);

  const load = () => api.get('/api/bugs').then((r) => { setBugs(r.bugs || []); setStatsKey((k) => k + 1); }).catch(() => setBugs([]));
  const loadAlmacen = () => { if (isAdmin) api.get('/api/bugs/almacen').then(setAlmacen).catch(() => {}); };
  useEffect(() => { load(); loadAlmacen(); if (isAdmin) api.get('/api/accounts').then(setCuentas).catch(() => {}); }, [isAdmin]);

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

  // admin: mover el estado (abierto → en curso → resuelto) y reclasificar el tipo
  const setStatus = async (b, status) => {
    try { await api.put(`/api/bugs/${b.id}`, { status }); load(); }
    catch (err) { setError(err.message); }
  };
  const setTipoBug = async (b, nuevo) => {
    try { await api.put(`/api/bugs/${b.id}`, { tipo: nuevo }); load(); }
    catch (err) { setError(err.message); }
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

  // lista visible: el admin filtra por fecha (el rango del gráfico), estado y tipo
  const visibles = (bugs || []).filter((b) => {
    if (!isAdmin) return true;
    const dia = b.created_at ? dstrLocal(new Date(b.created_at)) : ''; // dia LOCAL: el mismo criterio que el grafico (tz del navegador)
    if (from && dia < from) return false;
    if (to && dia > to) return false;
    if (fEstado && b.status !== fEstado) return false;
    if (fTipo && b.tipo !== fTipo) return false;
    if (fConexion === 'sin' && b.account_id != null) return false;
    if (fConexion && fConexion !== 'sin' && String(b.account_id) !== fConexion) return false;
    return true;
  });

  return (
    <div>
      <SectionTitle tour="page:errores" title="🐞 Reportar errores" subtitle={isAdmin ? 'Todos los errores reportados por los usuarios, con su gráfico de incidencias y resoluciones.' : 'Cuéntanos qué falló y lo revisamos. Puedes adjuntar capturas.'} />

      {isAdmin && <BugsChart from={from} to={to} setFrom={setFrom} setTo={setTo} refreshKey={statsKey} accountId={fConexion} />}

      {isAdmin && (
        <div data-tour="bugs-filtros" className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-500">Filtrar:</span>
          <Select value={fConexion} onChange={(e) => setFConexion(e.target.value)} className="!w-48 !py-2 text-xs" title="Ver solo los reportes de una conexión (a quién solventarle los problemas)">
            <option value="">Todas las conexiones</option>
            {cuentas.map((c) => <option key={c.id} value={String(c.id)}>{c.alias || c.name}</option>)}
            <option value="sin">— Sin conexión (admin) —</option>
          </Select>
          <Select value={fEstado} onChange={(e) => setFEstado(e.target.value)} className="!w-40 !py-2 text-xs">
            <option value="">Todos los estados</option>
            {ESTADOS.map((e2) => <option key={e2.value} value={e2.value}>{e2.label}</option>)}
          </Select>
          <Select value={fTipo} onChange={(e) => setFTipo(e.target.value)} className="!w-44 !py-2 text-xs">
            <option value="">Todos los tipos</option>
            {TIPOS.map((t) => <option key={t.value} value={t.value}>{TIPO_CORTO[t.value]}</option>)}
          </Select>
          {(fEstado || fTipo || fConexion) && (
            <button onClick={() => { setFEstado(''); setFTipo(''); setFConexion(''); }} className="text-xs font-semibold text-violet-600 hover:underline">Quitar filtros</button>
          )}
          <span className="ml-auto text-[11px] text-slate-400">{visibles.length} reporte{visibles.length === 1 ? '' : 's'} en el rango</span>
        </div>
      )}

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
            {bugs !== null && visibles.length === 0 && <p className="px-5 py-10 text-center text-sm text-slate-400">{bugs.length === 0 ? 'Sin reportes todavía. 🎉' : 'Nada que coincida con los filtros.'}</p>}
            {visibles.map((b) => (
              <div key={b.id} className="border-b border-slate-50 px-5 py-3">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
                  {isAdmin ? (
                    // el admin RECLASIFICA: llegó como «sistema» pero era «setter» → lo corrige aquí
                    <select value={b.tipo} onChange={(e) => setTipoBug(b, e.target.value)}
                      title="Cambiar el tipo de este reporte"
                      className={`cursor-pointer rounded-md border-0 px-1.5 py-0.5 font-semibold outline-none ${TIPO_BADGE[b.tipo] || TIPO_BADGE.otro}`}>
                      {TIPOS.map((t) => <option key={t.value} value={t.value}>{TIPO_CORTO[t.value]}</option>)}
                    </select>
                  ) : (
                    <span className={`rounded-md px-1.5 py-0.5 font-semibold ${TIPO_BADGE[b.tipo] || TIPO_BADGE.otro}`}>{TIPO_CORTO[b.tipo] || b.tipo}</span>
                  )}
                  {b.tipo_original && b.tipo_original !== b.tipo && (
                    <span className="text-slate-400" title="El equipo reclasificó este reporte">↪ era {TIPO_CORTO[b.tipo_original] || b.tipo_original}</span>
                  )}
                  <span className={`rounded-md px-1.5 py-0.5 font-semibold ${estadoDe(b.status).badge}`}>{estadoDe(b.status).label.toLowerCase()}</span>
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

                <div className="mt-1.5 flex flex-wrap items-center gap-3">
                  {Number(b.n_imagenes) > 0 && <button onClick={() => openImages(b)} className="text-xs font-semibold text-violet-600 hover:underline">📷 Ver capturas ({b.n_imagenes})</button>}
                  {isAdmin && replying?.id !== b.id && (
                    <button onClick={() => setReplying({ id: b.id, texto: b.respuesta || '' })} className="flex items-center gap-1 text-xs font-semibold text-violet-600 hover:underline">
                      <MessageCircle size={13} /> {b.respuesta ? 'Editar respuesta' : 'Responder'}
                    </button>
                  )}
                  {isAdmin && (
                    // el ciclo de vida: abierto → en curso → resuelto (pulsa el que toque)
                    <div className="ml-auto flex overflow-hidden rounded-lg border border-slate-200">
                      {ESTADOS.map((e2) => (
                        <button key={e2.value} onClick={() => e2.value !== b.status && setStatus(b, e2.value)}
                          className={`px-2 py-0.5 text-[10px] font-bold transition ${b.status === e2.value ? (e2.value === 'resuelto' ? 'bg-emerald-500 text-white' : e2.value === 'en_curso' ? 'bg-amber-400 text-white' : 'bg-red-400 text-white') : 'bg-white text-slate-400 hover:bg-slate-50'}`}>
                          {e2.label}
                        </button>
                      ))}
                    </div>
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
