import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Banner, Button, Card, SectionTitle, StatCard, Select, Input } from '../components/ui.jsx';
import { CreditCard, RefreshCw, Wallet, ShieldCheck, FlaskConical, TrendingUp, Save, ExternalLink } from 'lucide-react';

// 💳 Marketplace Disruptivo: qué clientes tienen el uso incluido, quién se quedó sin saldo y qué
// se ha cobrado. Solo admin (el backend ya lo exige; aquí es cuestión de no enseñar el menú).

const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
// importes de IA: por debajo de 1 USD con 4 decimales (una respuesta cuesta milésimas)
const usdIa = (n) => { const v = Number(n) || 0; return `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(Math.abs(v) < 1 ? 4 : 2)}`; };
const hoyIso = () => new Date().toISOString().slice(0, 10);
const inicioMes = () => `${hoyIso().slice(0, 8)}01`;
const fecha = (d) => (d ? new Date(d).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

const ESTADO_COBRO = {
  cobrado: { txt: 'Cobrado', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  incluido: { txt: 'Incluido (no se cobra)', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  pendiente: { txt: 'Pendiente', cls: 'bg-slate-50 text-slate-600 border-slate-200' },
  sin_confirmar: { txt: 'Sin confirmar', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  error: { txt: 'Error', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  cortado: { txt: 'Cobros cortados', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  sin_saldo: { txt: 'Sin saldo (espera recarga)', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
};

const Chip = ({ tone = '', children }) => (
  <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{children}</span>
);

// ── 💵 Dinero real ──
// null/undefined = no se sabe (sin management key, marketplace sin responder…): se enseña «—», nunca un 0 que engañe
const cifra = (v, f = usdIa) => (v === null || v === undefined ? '—' : f(v));
const tonoResultado = (v) => (v === null || v === undefined ? 'text-slate-500' : v >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400');
const cortesiaNeta = (b) => (b ? (Number(b.cortesia_concedida) || 0) - (Number(b.cortesia_retirada) || 0) : null);
// lo pagado con dinero real: recargas (tarjeta + monedero de GHL − revertidas) + lo cobrado a Hermes directamente del monedero
const pagadoReal = (b) => (b ? (Number(b.real_recargado) || 0) + (Number(b.cobrado_monedero_app) || 0) : null);
// lo consumido en Hermes con dinero real: lo pagado con el saldo real + lo cobrado a Hermes directamente del monedero de GHL
const consumoRealHermes = (b) => (b ? (Number(b.consumo_app_real) || 0) + (Number(b.cobrado_monedero_app) || 0) : null);
// mismo texto que manda el servidor (aviso_rango), por si se ve en los campos antes de que responda
const AVISO_RANGO_INVERTIDO = 'La fecha «Desde» es posterior a «Hasta»: no hay cifras de ese periodo. Cambia una de las dos.';
const OPENROUTER_CREDITOS = 'https://openrouter.ai/settings/credits';

// una línea «etiqueta ······ cifra» de los dos bloques de arriba
const Linea = ({ etiqueta, valor, nota, tono = 'text-slate-800', fuerte = false }) => (
  <div className="flex items-start justify-between gap-3 py-1.5">
    <div className="min-w-0">
      <div className={`text-sm ${fuerte ? 'font-semibold text-slate-700' : 'text-slate-600'}`}>{etiqueta}</div>
      {nota && <div className="text-[11px] text-slate-400">{nota}</div>}
    </div>
    <div className={`shrink-0 text-right text-sm tabular-nums ${fuerte ? 'font-bold' : 'font-semibold'} ${tono}`}>{valor}</div>
  </div>
);

export default function Marketplace() {
  const [datos, setDatos] = useState(null);
  const [cobros, setCobros] = useState([]);
  const [filtro, setFiltro] = useState('');
  const [error, setError] = useState('');
  const [probando, setProbando] = useState(null);
  const [resultado, setResultado] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [fac, setFac] = useState(null);           // ajustes de facturación (multiplicador, umbral, fuentes)
  const [fuentes, setFuentes] = useState([]);
  const [facMsg, setFacMsg] = useState('');
  const [rango, setRango] = useState(null);      // se fija con el día natural del servidor (la zona del cobro)
  const [rent, setRent] = useState(null);         // rentabilidad por cliente
  const [fin, setFin] = useState(null);           // dinero real: OpenRouter y clientes (mismo rango que rentabilidad)
  const [refrescandoOr, setRefrescandoOr] = useState(false);
  const finTurno = useRef(0);                     // solo vale la respuesta de la última petición

  const cargarFin = useCallback(async (r, { signal, refrescar = false } = {}) => {
    if (!r) return;
    const turno = ++finTurno.current;
    try {
      const d = await api.get(`/api/marketplace/finanzas?desde=${r.desde || ''}&hasta=${r.hasta || ''}${refrescar ? '&refrescar=1' : ''}`, { signal });
      if (turno === finTurno.current) setFin(d);
    } catch (e) { if (e.name !== 'AbortError' && turno === finTurno.current) setFin({ error: e.message }); }
  }, []);
  useEffect(() => {
    // igual que rentabilidad: si se cambian las fechas seguido, la respuesta vieja no pisa a la nueva
    const ac = new AbortController();
    cargarFin(rango, { signal: ac.signal });
    return () => ac.abort();
  }, [cargarFin, rango]);
  const actualizarOr = async () => {
    setRefrescandoOr(true);
    try { await cargarFin(rango, { refrescar: true }); } finally { setRefrescandoOr(false); }
  };

  const cargarFac = useCallback(async () => {
    try { const d = await api.get('/api/marketplace/facturacion'); setFac(d.facturacion); setFuentes(d.fuentes || []); } catch (e) { setFacMsg(e.message); }
  }, []);
  const cargarRent = useCallback(async (r, signal) => {
    if (!r) return;
    try { setRent(await api.get(`/api/marketplace/rentabilidad?desde=${r.desde}&hasta=${r.hasta}`, { signal })); }
    catch (e) { if (e.name !== 'AbortError') setRent({ error: e.message }); }
  }, []);
  useEffect(() => { cargarFac(); }, [cargarFac]);
  useEffect(() => {
    // si se cambian las fechas seguido, la respuesta vieja no pisa a la nueva
    const ac = new AbortController();
    cargarRent(rango, ac.signal);
    return () => ac.abort();
  }, [cargarRent, rango]);

  const guardarFac = async () => {
    setFacMsg('');
    try {
      const d = await api.put('/api/marketplace/facturacion', fac);
      setFac(d.facturacion);
      setFacMsg('✓ Guardado. Se aplica a las llamadas de IA desde ahora (lo ya registrado no cambia).');
      cargarRent(rango);
    } catch (e) { setFacMsg(e.message); }
  };
  const cerrarLotes = async () => {
    if (!window.confirm('Se cerrarán YA los lotes de todo el consumo acumulado (desde 0,01 USD) y se mandarán a cobrar a los clientes que no tengan el uso incluido. ¿Seguir?')) return;
    setOcupado(true);
    try {
      const r = await api.post('/api/marketplace/lotes/cerrar', {});
      setFacMsg(`Lotes cerrados: ${r.lotes || 0} (${usd(r.importe)}).${r.motivo ? ` ${r.motivo}` : ''}`);
      await Promise.all([cargar(), cargarCobros(filtro), cargarRent(rango)]);
    } catch (e) { setFacMsg(e.message); } finally { setOcupado(false); }
  };

  const cargar = useCallback(async () => {
    try {
      const d = await api.get('/api/marketplace/estado');
      setDatos(d);
      setError('');
      setRango((r) => r || { desde: `${String(d.dia_natural || hoyIso()).slice(0, 8)}01`, hasta: d.dia_natural || hoyIso() });
    } catch (e) {
      setError(e.message);
      setDatos({ config: {}, cuentas: [] });
      setRango((r) => r || { desde: inicioMes(), hasta: hoyIso() });
    }
  }, []);

  const cargarCobros = useCallback(async (estado) => {
    try {
      const d = await api.get(`/api/marketplace/cobros${estado ? `?estado=${estado}` : ''}`);
      setCobros(d.cobros || []);
    } catch {
      setCobros([]);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { cargarCobros(filtro); }, [cargarCobros, filtro]);

  // Diagnóstico sin mover dinero (access + fondos + tarifas). Con «cobrar» hace el ciclo real.
  const probar = async (cuenta, cobrar) => {
    if (cobrar && !window.confirm(
      `Se ejecutará un cobro de PRUEBA de 0,01 USD contra ${cuenta.name}.\n\n`
      + 'Si el administrador del marketplace tiene activado el MODO PRUEBA de Hermes, no se mueve dinero. '
      + 'Si no lo tiene, se cobrará de verdad ese céntimo.\n\n¿Continuar?'
    )) return;
    setProbando(`${cuenta.id}:${cobrar ? 'cobro' : 'diag'}`);
    setResultado(null);
    try {
      const r = await api.post('/api/marketplace/probar', { account_id: cuenta.id, cobrar: Boolean(cobrar) });
      setResultado(r);
      await Promise.all([cargar(), cargarCobros(filtro)]);
    } catch (e) {
      setResultado({ ok: false, error: e.message });
    } finally {
      setProbando(null);
    }
  };

  const reintentar = async (c) => {
    setOcupado(true);
    try {
      await api.post(`/api/marketplace/cobros/${encodeURIComponent(c.event_id)}/reintentar`);
      await cargarCobros(filtro);
    } catch (e) {
      setError(e.message);
    } finally {
      setOcupado(false);
    }
  };

  if (datos === null) return <p className="py-16 text-center text-sm text-slate-400">Cargando…</p>;

  const cfg = datos.config || {};
  const cuentas = datos.cuentas || [];
  const sinSaldo = cuentas.filter((c) => c.md_sin_fondos_at);
  const alertaOr = fin?.resumen?.alerta_openrouter;
  // «Desde» después de «Hasta» (lo dice el servidor o se ve ya en los campos): un solo aviso bajo las fechas
  const rangoInvertido = Boolean(rent?.rango_invalido) || Boolean(rango?.desde && rango?.hasta && rango.desde > rango.hasta);

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Marketplace · saldo y cobros"
        subtitle="Hermes no cobra por su cuenta: pregunta al Marketplace Disruptivo si el cliente tiene el uso incluido y, si no, descuenta su consumo del saldo que tenga allí."
        actions={<Button variant="secondary" onClick={() => { cargar(); cargarCobros(filtro); }}><RefreshCw size={15} /> Actualizar</Button>}
      />

      {error && <Banner tone="error">{error}</Banner>}

      {!cfg.activo && (
        <Banner tone="warn">
          La integración está <strong>apagada</strong>: falta la variable de entorno <code>MD_API_KEY</code> en EasyPanel.
          Hermes funciona con normalidad, pero no comprueba accesos ni cobra nada.
        </Banner>
      )}
      {cfg.activo && !cfg.cobros_activos && (
        <Banner tone="info">
          Modo observación (<code>MD_COBROS=false</code>): se comprueba el acceso y el saldo, pero <strong>no se cobra</strong>.
        </Banner>
      )}
      {datos.tarifas && datos.tarifas.status !== 200 && (
        <Banner tone="error">
          El marketplace no acepta nuestra clave (HTTP {datos.tarifas.status}). Revisa <code>MD_API_KEY</code>.
        </Banner>
      )}
      {sinSaldo.length > 0 && (
        <Banner tone="error">
          <strong>{sinSaldo.length} {sinSaldo.length === 1 ? 'conexión se quedó' : 'conexiones se quedaron'} sin saldo</strong>
          {' '}y el setter no responde a sus leads: {sinSaldo.map((c) => c.name).join(', ')}. Avísales para que recarguen.
        </Banner>
      )}
      {(alertaOr?.nivel === 'agotado' || alertaOr?.nivel === 'bajo') && (
        <Banner tone={alertaOr.nivel === 'agotado' ? 'error' : 'warn'}>
          {alertaOr.texto}{' '}
          <a href={OPENROUTER_CREDITOS} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold underline">
            Recargar en OpenRouter <ExternalLink size={12} />
          </a>
        </Banner>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Cobrado hoy" value={usd(datos.consumo?.hoy?.usd)} sub={`${datos.consumo?.hoy?.n ?? 0} cargos`} icon={CreditCard} tone="violet" />
        <StatCard label="Cobrado este mes" value={usd(datos.consumo?.mes?.usd)} sub={`${datos.consumo?.mes?.n ?? 0} cargos`} icon={Wallet} tone="emerald" />
        <StatCard label="Precio al cliente" value={fac ? `coste × ${fac.multiplicador}` : '…'} sub={`por consumo de IA · tarifa «${cfg.meter || '—'}» · día ${datos.dia_natural} (${cfg.zona_horaria})`} icon={ShieldCheck} tone="blue" />
      </div>

      <Card className="p-5">
        <h3 className="text-sm font-semibold text-slate-700">💰 Cobro por consumo de IA</h3>
        <p className="mt-0.5 text-xs text-slate-400">
          A cada cliente se le cobra lo que nos cuesta su IA (el coste que da OpenRouter o los precios de cada API) multiplicado por este número.
          Se descuenta del SALDO que el cliente recarga en el Marketplace Disruptivo (nunca de su monedero de GHL): el consumo se acumula y se cobra en un solo cargo al llegar al umbral o, como mucho, una vez al día.
          Cuando su saldo ya no cubre lo consumido, su setter se pausa hasta que recarga. A los clientes con el uso incluido (prueba o plan) no se les cobra.
        </p>
        {fac && (
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Input label="Multiplicador (precio al cliente = coste × …)" type="number" min="1" max="20" step="0.1"
              value={fac.multiplicador} onChange={(e) => setFac({ ...fac, multiplicador: e.target.value })} hint="Precio al cliente = coste × este número" />
            <Input label="Cobrar cada (USD acumulados)" type="number" min="0.1" max="50" step="0.1"
              value={fac.umbral_usd} onChange={(e) => setFac({ ...fac, umbral_usd: e.target.value })} hint="Y como mucho una vez al día aunque no llegue" />
            <div>
              <span className="mb-1.5 block text-sm font-medium text-slate-700">Qué se le cobra al cliente</span>
              <div className="space-y-1">
                {fuentes.map((f) => (
                  <label key={f.key} className="flex items-center gap-2 text-xs text-slate-600">
                    <input type="checkbox" checked={(fac.fuentes || []).includes(f.key)}
                      onChange={(e) => setFac({ ...fac, fuentes: e.target.checked ? [...(fac.fuentes || []), f.key] : (fac.fuentes || []).filter((x) => x !== f.key) })} />
                    {f.txt}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={guardarFac} disabled={!fac}><Save size={15} /> Guardar</Button>
          <Button variant="secondary" onClick={cerrarLotes} disabled={ocupado || !cfg.activo}>Cobrar ya lo acumulado</Button>
          {facMsg && <span className={`text-xs ${facMsg.startsWith('✓') || facMsg.startsWith('Lotes') ? 'text-emerald-600' : 'text-rose-600'}`}>{facMsg}</span>}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700"><TrendingUp size={15} /> Rentabilidad por cliente</h3>
            <p className="text-xs text-slate-400">Por fecha de cada llamada. Coste = lo que nos ha costado su IA (también pruebas y editor de prompts). Cobrado = lo ya cobrado de ese consumo. Incluido = consumo con prueba o plan (no se cobra). Pendiente = aún sin cobrar. Beneficio = cobrado − coste. «Previsto» = si se cobrara todo su consumo.</p>
            {/* las fechas que de verdad ha usado el servidor (con un campo vacío, del día 1 del mes a hoy) */}
            {rent?.desde && rent?.hasta && !rangoInvertido && <p className="text-[11px] text-slate-500">Del {rent.desde} al {rent.hasta}</p>}
          </div>
          <div className="flex items-end gap-2">
            {/* max/min ayudan en el selector, pero se puede teclear cualquier fecha: el servidor lo vuelve a mirar */}
            <Input label="Desde" type="date" value={rango?.desde || ''} max={rango?.hasta || undefined} onChange={(e) => setRango({ ...rango, desde: e.target.value })} className="!py-1.5" />
            <Input label="Hasta" type="date" value={rango?.hasta || ''} min={rango?.desde || undefined} onChange={(e) => setRango({ ...rango, hasta: e.target.value })} className="!py-1.5" />
          </div>
        </div>
        {rangoInvertido && <div className="p-4"><Banner tone="warn">{rent?.aviso_rango || AVISO_RANGO_INVERTIDO}</Banner></div>}
        {rent?.error && <div className="p-4"><Banner tone="error">{rent.error}</Banner></div>}
        {rent && rent.zona_valida === false && <div className="p-4"><Banner tone="warn">La zona horaria del cobro (<code>MD_ZONA_HORARIA</code>) no es válida: se está usando UTC.</Banner></div>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left">Cliente</th>
                <th className="px-4 py-2 text-right">Coste IA</th>
                <th className="px-4 py-2 text-right">Precio al cliente</th>
                <th className="px-4 py-2 text-right">Cobrado</th>
                <th className="px-4 py-2 text-right">Incluido</th>
                <th className="px-4 py-2 text-right">Pendiente</th>
                <th className="px-4 py-2 text-right">Beneficio</th>
                <th className="px-4 py-2 text-right">Previsto</th>
              </tr>
            </thead>
            <tbody>
              {(rent?.clientes || []).map((c) => (
                <tr key={c.id} className="border-t border-slate-50">
                  <td className="px-4 py-2">
                    <div className="font-medium text-slate-700">{c.name}</div>
                    <div className="text-[10px] text-slate-400">
                      {c.llamadas} llamadas{c.md_acceso === 'incluido' ? ' · uso incluido' : c.md_acceso === 'por_uso' ? ' · por uso' : ''}
                      {c.sin_coste > 0 && <span className="text-amber-600"> · {c.sin_coste} sin coste conocido</span>}
                      {c.con_error > 0 && <span className="text-rose-600"> · {c.con_error} cobros con error</span>}
                      {c.no_cobrable > 0 && <span className="text-amber-600"> · {usdIa(c.no_cobrable)} no cobrable (sin location_id o cobros apagados)</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600">{usdIa(c.coste)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600">{usdIa(c.precio)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold text-slate-800">{usdIa(c.cobrado)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-sky-700">{usdIa(c.incluido)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-amber-700">{usdIa(c.pendiente)}</td>
                  <td className={`px-4 py-2 text-right tabular-nums font-semibold ${c.beneficio >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{usdIa(c.beneficio)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">{usdIa(c.beneficio_previsto)}</td>
                </tr>
              ))}
              {rent?.totales && (
                <tr className="border-t-2 border-slate-200 bg-slate-50/60 font-semibold">
                  <td className="px-4 py-2 text-slate-700">Total{rent.totales.coste_sin_cliente > 0 && <div className="text-[10px] font-normal text-slate-400">+ {usdIa(rent.totales.coste_sin_cliente)} de coste del archivo (sin cliente)</div>}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{usdIa(rent.totales.coste)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{usdIa(rent.totales.precio)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{usdIa(rent.totales.cobrado)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-sky-700">{usdIa(rent.totales.incluido)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-amber-700">{usdIa(rent.totales.pendiente)}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${rent.totales.beneficio >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{usdIa(rent.totales.beneficio)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">{usdIa(rent.totales.beneficio_previsto)}</td>
                </tr>
              )}
              {rent && !rent.error && !rangoInvertido && (rent.clientes || []).length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-400">Sin consumo en ese rango.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="border-t border-slate-100 px-5 py-2 text-[11px] text-slate-400">GHL no cobra comisión por los cargos del marketplace hasta el 31-12-2026; desde 2027 está prevista en torno al 15 % y habrá que descontarla del beneficio.</p>
      </Card>

      <DineroReal fin={fin} rango={rango} onActualizar={actualizarOr} refrescando={refrescandoOr} />

      <Card className="overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-slate-700">Conexiones</h3>
          <p className="text-xs text-slate-400">«Incluido» = plan o prueba gratuita en el marketplace: a ese cliente no se le cobra nada.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left">Conexión</th>
                <th className="px-4 py-2 text-left">Acceso</th>
                <th className="px-4 py-2 text-right">Por cobrar</th>
                <th className="px-4 py-2 text-left">Saldo</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {cuentas.map((c) => (
                <tr key={c.id} className="border-t border-slate-50">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-700">{c.name}</div>
                    <code className="text-[10px] text-slate-400">{c.location_id || 'sin location_id'}</code>
                  </td>
                  <td className="px-4 py-2.5">
                    {c.md_acceso === 'incluido'
                      ? <Chip tone="bg-sky-50 text-sky-700 border-sky-200">Incluido</Chip>
                      : c.md_acceso === 'por_uso'
                        ? <Chip tone="bg-violet-50 text-violet-700 border-violet-200">Por uso</Chip>
                        : <Chip tone="bg-slate-50 text-slate-500 border-slate-200">Sin consultar</Chip>}
                    <div className="text-[10px] text-slate-400">{c.md_acceso_at ? fecha(c.md_acceso_at) : ''}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600" title="Consumo de IA a precio de cliente que aún no ha entrado en ningún cargo">{usdIa(c.por_cobrar)}</td>
                  <td className="px-4 py-2.5">
                    {c.md_sin_fondos_at
                      ? <Chip tone="bg-rose-50 text-rose-700 border-rose-200">Sin saldo desde {fecha(c.md_sin_fondos_at)}</Chip>
                      : <span className="text-xs text-slate-400">Con saldo</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => probar(c, false)}
                      disabled={!cfg.activo || !c.location_id || Boolean(probando)}
                      className="text-xs font-semibold text-violet-600 hover:underline disabled:opacity-40"
                    >
                      {probando === `${c.id}:diag` ? 'Comprobando…' : 'Comprobar'}
                    </button>
                    <button
                      type="button"
                      onClick={() => probar(c, true)}
                      disabled={!cfg.activo || !c.location_id || Boolean(probando)}
                      className="ml-3 text-xs font-semibold text-slate-500 hover:underline disabled:opacity-40"
                    >
                      {probando === `${c.id}:cobro` ? 'Cobrando…' : 'Cobro de prueba'}
                    </button>
                  </td>
                </tr>
              ))}
              {cuentas.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">Todavía no hay conexiones.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {resultado && (
        <Card className="p-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700"><FlaskConical size={15} /> Resultado de la prueba</h3>
            <button type="button" onClick={() => setResultado(null)} className="text-xs text-slate-400 hover:text-slate-600">Cerrar</button>
          </div>
          {resultado.nota && <Banner tone={resultado.ok === false ? 'error' : 'info'}>{resultado.nota}</Banner>}
          {resultado.error && <Banner tone="error">{resultado.error}</Banner>}
          <pre className="scroll-thin mt-2 max-h-80 overflow-auto rounded-xl bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-200">
            {JSON.stringify(resultado.pasos ?? resultado, null, 2)}
          </pre>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">Últimos cobros</h3>
            <p className="text-xs text-slate-400">Cada fila es un cargo: los nuevos («hermes-ia-…») son lotes de consumo de IA; los antiguos, una conversación en un día. El identificador es lo que impide cobrarlo dos veces.</p>
          </div>
          <Select value={filtro} onChange={(e) => setFiltro(e.target.value)} className="w-48">
            <option value="">Todos los estados</option>
            {Object.keys(ESTADO_COBRO).map((k) => <option key={k} value={k}>{ESTADO_COBRO[k].txt}</option>)}
          </Select>
        </div>
        <div className="scroll-thin max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left">Identificador</th>
                <th className="px-4 py-2 text-left">Conexión</th>
                <th className="px-4 py-2 text-left">Estado</th>
                <th className="px-4 py-2 text-right">Importe</th>
                <th className="px-4 py-2 text-left">Cuándo</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {cobros.map((c) => {
                const e = ESTADO_COBRO[c.estado] || ESTADO_COBRO.pendiente;
                const resuelto = ['cobrado', 'incluido'].includes(c.estado);
                return (
                  <tr key={c.id} className="border-t border-slate-50">
                    <td className="px-4 py-2"><code className="text-[10px] text-slate-500">{c.event_id}</code></td>
                    <td className="px-4 py-2 text-slate-600">{c.account_name || '—'}</td>
                    <td className="px-4 py-2">
                      <Chip tone={e.cls}>{e.txt}</Chip>
                      {c.test_mode && <span className="ml-1"><Chip tone="bg-amber-50 text-amber-700 border-amber-200">prueba</Chip></span>}
                      {c.ultimo_error && <div className="mt-0.5 max-w-xs truncate text-[10px] text-rose-500" title={c.ultimo_error}>{c.ultimo_error}</div>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-600">
                      {c.amount === null || c.amount === undefined ? (c.tipo === 'consumo_ia' ? usd(c.price) : '—') : usd(c.amount)}
                      {c.tipo === 'consumo_ia' && <div className="text-[10px] text-slate-400">{c.llamadas} llamadas · coste {usdIa(c.cost_usd)}</div>}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-400">{fecha(c.created_at)}</td>
                    <td className="px-4 py-2 text-right">
                      {!resuelto && (
                        <button type="button" onClick={() => reintentar(c)} disabled={ocupado}
                          className="text-xs font-semibold text-violet-600 hover:underline disabled:opacity-40">
                          Reintentar
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {cobros.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-400">Todavía no hay cobros registrados.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// 💵 Dinero real · OpenRouter y clientes: lo que el dueño ha pagado a OpenRouter frente a lo que le han pagado los
// clientes, con el dinero real separado del saldo de cortesía que regala (regla «cortesía primero» del marketplace).
function DineroReal({ fin, rango, onActualizar, refrescando }) {
  const or = fin?.openrouter || {};
  const cuenta = or.cuenta || {};
  const clavesHermes = or.claves_hermes || [];
  const cli = fin?.clientes || {};
  const res = fin?.resumen || {};
  const hermes = fin?.hermes || {};
  const tot = cli.totales || null;
  const hayRango = Boolean(fin?.desde || fin?.hasta);
  const pct = String(or.comision_pct ?? 5.5).replace('.', ',');
  const saldoOr = res.saldo_openrouter;
  const tonoSaldoOr = saldoOr === null || saldoOr === undefined ? 'text-slate-500'
    : saldoOr <= 0.5 ? 'text-rose-600 dark:text-rose-400' : saldoOr < 5 ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400';
  // k = campo del bloque o una función que calcula la cifra a partir de él (p. ej. consumoRealHermes)
  const enRango = (b, k) => (hayRango && b ? <div className="text-[10px] font-normal text-slate-400">rango {usdIa(typeof k === 'function' ? k(b) : b[k])}</div> : null);
  const delMonedero = Number(res.cobrado_monedero_hermes) > 0;
  const delMonederoRango = Number(res.cobrado_monedero_hermes_rango) > 0;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-700">💵 Dinero real · OpenRouter y clientes</h3>
          <p className="text-xs text-slate-400">
            Lo que has pagado a OpenRouter frente a lo que te han pagado los clientes, separando el dinero real del saldo de cortesía que regalas.
            Las cifras «del rango» usan las fechas de Rentabilidad{fin?.desde || fin?.hasta ? ` (${fin?.desde || 'principio'} → ${fin?.hasta || 'hoy'})` : ''}.
          </p>
        </div>
        <Button variant="secondary" onClick={onActualizar} loading={refrescando} disabled={!rango || refrescando}>
          {!refrescando && <RefreshCw size={15} />} Actualizar OpenRouter
        </Button>
      </div>

      {!fin && <p className="px-5 py-8 text-center text-sm text-slate-400">Cargando…</p>}
      {fin?.error && <div className="p-4"><Banner tone="error">{fin.error}</Banner></div>}

      {fin && !fin.error && (
        <div className="space-y-4 p-4 sm:p-5">
          {cuenta.configurada === false && (
            <Banner tone="info">
              Para ver lo comprado y el saldo de OpenRouter, crea en OpenRouter una <strong>management key</strong> (solo sirve para consultar, no para chatear)
              y pégala en EasyPanel como <code>OPENROUTER_MANAGEMENT_KEY</code>. Nunca se muestra en el panel.
            </Banner>
          )}
          {cuenta.configurada && cuenta.error && <Banner tone="warn">No se ha podido leer todo de OpenRouter: {cuenta.error}</Banner>}
          {cli.disponible === false && <Banner tone="warn">{cli.motivo}</Banner>}

          <div className="grid gap-4 md:grid-cols-2">
            {/* ── lo pagado a OpenRouter ── */}
            <div className="rounded-xl border border-slate-200 p-4">
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Lo que has pagado a OpenRouter</h4>
              <div className="divide-y divide-slate-100">
                <Linea
                  etiqueta="Comprado"
                  valor={cifra(res.pagado_openrouter)}
                  nota={res.comision_estimada !== null && res.comision_estimada !== undefined
                    ? `≈ ${usd(res.comision_estimada)} de comisión (${pct} %, mínimo 0,80 $ por compra)`
                    : `Más ≈ ${pct} % de comisión de OpenRouter en cada compra`}
                />
                <Linea etiqueta="Gastado de la cuenta" valor={cifra(res.gastado_openrouter_cuenta)} />
                <Linea etiqueta="Saldo" valor={cifra(saldoOr)} tono={tonoSaldoOr} fuerte />
                <Linea etiqueta="Gasto de las claves de Hermes" valor={cifra(res.gastado_claves_hermes)} nota={`Este mes: ${cifra(res.gastado_claves_hermes_mes)}`} />
              </div>

              {clavesHermes.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Claves de Hermes</div>
                  <ul className="space-y-1.5">
                    {clavesHermes.map((c) => (
                      <li key={`${c.clave}-${(c.proveedores || []).map((p) => p.id).join(',')}`} className="flex items-start justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="truncate text-slate-600">
                            {(c.proveedores || []).map((p) => p.name).join(', ')} <code className="text-[10px] text-slate-400">{c.clave}</code>
                          </div>
                          {c.error
                            ? <div className="text-rose-600 dark:text-rose-400">{c.error}</div>
                            : (
                              <div className="text-slate-400">
                                Este mes {cifra(c.usage_monthly)}
                                {Number.isFinite(c.limit_remaining) ? ` · le quedan ${usdIa(c.limit_remaining)} de su límite` : ' · sin límite propio'}
                              </div>
                            )}
                        </div>
                        <div className="shrink-0 text-right tabular-nums text-slate-700">{cifra(c.usage)}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {clavesHermes.length === 0 && (
                <p className="mt-3 text-xs text-slate-400">No hay ningún proveedor de OpenRouter en Proveedores.</p>
              )}

              {cuenta.configurada && (cuenta.claves || []).length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Todas las claves de la cuenta</div>
                  <ul className="space-y-1.5">
                    {cuenta.claves.map((k, i) => (
                      <li key={`${k.label}-${i}`} className="flex items-start justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="truncate text-slate-600">
                            {k.name || k.label || 'Sin nombre'}
                            {k.disabled && <span className="ml-1"><Chip tone="border-slate-200 bg-slate-50 text-slate-500">desactivada</Chip></span>}
                          </div>
                          <div className="text-slate-400">
                            Este mes {cifra(k.usage_monthly)}
                            {Number.isFinite(k.limit_remaining) ? ` · le quedan ${usdIa(k.limit_remaining)} de su límite` : ''}
                          </div>
                        </div>
                        <div className="shrink-0 text-right tabular-nums text-slate-700">{cifra(k.usage)}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* ── lo pagado por los clientes ── */}
            <div className="rounded-xl border border-slate-200 p-4">
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Lo que te han pagado los clientes</h4>
              <div className="divide-y divide-slate-100">
                <Linea etiqueta="Dinero real recargado" valor={cifra(res.te_han_pagado)} tono="text-emerald-700 dark:text-emerald-400" fuerte
                  nota="Recargas con tarjeta o monedero de GHL (menos las anuladas) y lo cobrado a Hermes del monedero" />
                <Linea etiqueta="Cortesía regalada" valor={cifra(res.cortesia_regalada)} tono="text-sky-700 dark:text-sky-400" nota="Saldo añadido a mano: no es dinero" />
                <Linea etiqueta="Consumido en Hermes con dinero real" valor={cifra(res.consumido_hermes_real)}
                  nota={`Del saldo real y lo cobrado a Hermes directamente del monedero de GHL${delMonedero ? `: de ello, ${cifra(res.cobrado_monedero_hermes)} del monedero` : ''}`} />
                <Linea etiqueta="Consumido en Hermes con cortesía" valor={cifra(res.consumido_hermes_cortesia)} tono="text-sky-700 dark:text-sky-400" />
                <Linea etiqueta="Saldo que les queda · real" valor={cifra(res.saldo_clientes_real)} />
                <Linea etiqueta="Saldo que les queda · cortesía" valor={cifra(res.saldo_clientes_cortesia)} tono="text-sky-700 dark:text-sky-400" />
              </div>
            </div>
          </div>

          {/* ── resultado ── */}
          <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm text-slate-600">
                Dinero real consumido en Hermes <span className="font-semibold tabular-nums">{cifra(res.consumido_hermes_real)}</span>
                {delMonedero && (
                  <>
                    {' '}(del saldo <span className="font-semibold tabular-nums">{cifra(res.consumido_hermes_real_saldo)}</span>
                    {' '}+ cobrado a Hermes del monedero de GHL <span className="font-semibold tabular-nums">{cifra(res.cobrado_monedero_hermes)}</span>)
                  </>
                )}
                {' '}− coste de la IA de Hermes <span className="font-semibold tabular-nums">{cifra(hermes.coste_ia_historico)}</span> =
              </span>
              <span className={`text-lg font-bold tabular-nums ${tonoResultado(res.resultado_real_hermes)}`}>{cifra(res.resultado_real_hermes)}</span>
            </div>
            {hermes.coste_ia_historico === null && (
              <div className="text-[11px] text-amber-700 dark:text-amber-400">No se ha podido leer lo que ha costado la IA de Hermes, así que el resultado sale como «—». Prueba a recargar en un rato.</div>
            )}
            {hayRango && (
              <div className="border-t border-slate-200 pt-2 text-xs">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-slate-500">
                    Del {fin.desde || 'principio'} al {fin.hasta || 'hoy'}: consumido con dinero real <span className="tabular-nums">{cifra(res.consumido_hermes_real_rango)}</span>
                    {delMonederoRango && <>{' '}(de ello, del monedero de GHL <span className="tabular-nums">{cifra(res.cobrado_monedero_hermes_rango)}</span>)</>}
                    {' '}· con cortesía <span className="tabular-nums">{cifra(res.consumido_hermes_cortesia_rango)}</span>
                    {' '}· coste de la IA <span className="tabular-nums">{cifra(hermes.coste_ia_rango)}</span>
                  </span>
                  <span className={`font-semibold tabular-nums ${tonoResultado(res.resultado_real_rango)}`}>{cifra(res.resultado_real_rango)}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  El dinero real cuenta el día en que se cobró cada lote; el coste de lo ya cobrado, ese mismo día; el resto del coste, el día de cada llamada.
                </div>
              </div>
            )}
            {fin.rango_invalido && (
              <div className="border-t border-slate-200 pt-2 text-xs text-amber-700 dark:text-amber-400">{fin.aviso_rango || AVISO_RANGO_INVERTIDO}</div>
            )}
            {Number(hermes.coste_ia_archivo_historico) > 0 && (
              <div className="text-[11px] text-slate-400">Aparte, {usdIa(hermes.coste_ia_archivo_historico)} de coste de IA del Archivo (no es de ningún cliente).</div>
            )}
          </div>

          {/* ── por cliente ── */}
          {cli.disponible && (
            <div className="-mx-4 overflow-x-auto border-t border-slate-100 sm:-mx-5">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th rowSpan={2} className="px-4 py-2 text-left align-bottom">Cliente</th>
                    <th rowSpan={2} className="px-4 py-2 text-right align-bottom">Cortesía regalada</th>
                    <th rowSpan={2} className="px-4 py-2 text-right align-bottom">Pagado (real)</th>
                    <th colSpan={2} className="px-4 pt-2 text-center">Consumido en Hermes</th>
                    <th colSpan={2} className="px-4 pt-2 text-center">Saldo</th>
                  </tr>
                  <tr>
                    <th className="px-4 pb-2 text-right font-medium normal-case">cortesía</th>
                    <th className="px-4 pb-2 text-right font-medium normal-case">real</th>
                    <th className="px-4 pb-2 text-right font-medium normal-case">cortesía</th>
                    <th className="px-4 pb-2 text-right font-medium normal-case">real</th>
                  </tr>
                </thead>
                <tbody>
                  {(cli.filas || []).map((f) => (
                    <tr key={f.location_id} className="border-t border-slate-50">
                      <td className="px-4 py-2">
                        <div className="font-medium text-slate-700">{f.name}</div>
                        <div className="text-[10px] text-slate-400">
                          {f.account_id ? '' : 'sin conexión en Hermes · '}<code>{f.location_id}</code>
                        </div>
                        {f.saldo?.descuadre && (
                          <div className="text-[10px] text-amber-700 dark:text-amber-400">
                            Su saldo según los movimientos ({usdIa(f.saldo.total)}) no cuadra con el registrado ({usdIa(f.saldo.registrado)})
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-sky-700 dark:text-sky-400">{cifra(cortesiaNeta(f.historico))}</td>
                      <td className="px-4 py-2 text-right font-semibold tabular-nums text-slate-800">{cifra(pagadoReal(f.historico))}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-sky-700 dark:text-sky-400">{cifra(f.historico?.consumo_app_cortesia)}{enRango(f.rango, 'consumo_app_cortesia')}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-700">{cifra(consumoRealHermes(f.historico))}{enRango(f.rango, consumoRealHermes)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-sky-700 dark:text-sky-400">{cifra(f.saldo?.cortesia)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-700">{cifra(f.saldo?.real)}</td>
                    </tr>
                  ))}
                  {tot && (cli.filas || []).length > 0 && (
                    <tr className="border-t-2 border-slate-200 bg-slate-50/60 font-semibold">
                      <td className="px-4 py-2 text-slate-700">Total</td>
                      <td className="px-4 py-2 text-right tabular-nums text-sky-700 dark:text-sky-400">{cifra(cortesiaNeta(tot.historico))}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-800">{cifra(pagadoReal(tot.historico))}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-sky-700 dark:text-sky-400">{cifra(tot.historico?.consumo_app_cortesia)}{enRango(tot.rango, 'consumo_app_cortesia')}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-700">{cifra(consumoRealHermes(tot.historico))}{enRango(tot.rango, consumoRealHermes)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-sky-700 dark:text-sky-400">{cifra(tot.saldo?.cortesia)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-700">{cifra(tot.saldo?.real)}</td>
                    </tr>
                  )}
                  {(cli.filas || []).length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">Ningún cliente tiene todavía movimientos de saldo.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-[11px] text-slate-400">
            Regla «cortesía primero»: cada consumo gasta antes el saldo de cortesía del cliente y, cuando se acaba, su dinero real.
            En «Consumido en Hermes · real» entra también lo cobrado directamente del monedero de GHL (cobros antiguos y suscripciones de Hermes), que no pasa por el saldo.
            Las cifras de OpenRouter son de toda la cuenta (incluyen otras apps, como el Brain, si comparten cuenta) y la comisión es una estimación: OpenRouter no la da.
            El coste de la IA de Hermes incluye también las pruebas y el editor de prompts.
          </p>
        </div>
      )}
    </Card>
  );
}
