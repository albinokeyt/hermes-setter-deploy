import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Banner, Button, Card, SectionTitle, StatCard, Select } from '../components/ui.jsx';
import { CreditCard, RefreshCw, Wallet, ShieldCheck, FlaskConical } from 'lucide-react';

// 💳 Marketplace Disruptivo: qué clientes tienen el uso incluido, quién se quedó sin saldo y qué
// se ha cobrado. Solo admin (el backend ya lo exige; aquí es cuestión de no enseñar el menú).

const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const fecha = (d) => (d ? new Date(d).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

const ESTADO_COBRO = {
  cobrado: { txt: 'Cobrado', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  incluido: { txt: 'Incluido (no se cobra)', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  pendiente: { txt: 'Pendiente', cls: 'bg-slate-50 text-slate-600 border-slate-200' },
  sin_confirmar: { txt: 'Sin confirmar', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  error: { txt: 'Error', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  cortado: { txt: 'Cobros cortados', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
};

const Chip = ({ tone = '', children }) => (
  <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{children}</span>
);

export default function Marketplace() {
  const [datos, setDatos] = useState(null);
  const [cobros, setCobros] = useState([]);
  const [filtro, setFiltro] = useState('');
  const [error, setError] = useState('');
  const [probando, setProbando] = useState(null);
  const [resultado, setResultado] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const d = await api.get('/api/marketplace/estado');
      setDatos(d);
      setError('');
    } catch (e) {
      setError(e.message);
      setDatos({ config: {}, cuentas: [] });
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
      `Se ejecutará un cobro de PRUEBA contra ${cuenta.name}.\n\n`
      + 'Si el administrador del marketplace tiene activado el MODO PRUEBA de Hermes, no se mueve dinero. '
      + 'Si no lo tiene, se cobrará de verdad el precio configurado.\n\n¿Continuar?'
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
      {cfg.activo && (!cfg.precio_valido || !cfg.unidades_validas) && (
        <Banner tone="error">
          Configuración inválida: el precio por unidad debe estar entre 0,01 y 100 USD y las unidades ser mayores que cero.
          Revisa <code>MD_PRECIO_UNIDAD</code> y <code>MD_UNIDADES_POR_COBRO</code>. Mientras esté así no se registra ningún consumo.
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

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Conversaciones cobradas hoy" value={datos.consumo?.hoy?.n ?? 0} sub={usd(datos.consumo?.hoy?.usd)} icon={CreditCard} tone="violet" />
        <StatCard label="Este mes" value={datos.consumo?.mes?.n ?? 0} sub={usd(datos.consumo?.mes?.usd)} icon={Wallet} tone="emerald" />
        <StatCard label="Precio por conversación/día" value={usd(cfg.precio_unidad)} sub={`tarifa «${cfg.meter || '—'}» · día ${datos.dia_natural} (${cfg.zona_horaria})`} icon={ShieldCheck} tone="sky" />
      </div>

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
                <th className="px-4 py-2 text-right">Hoy</th>
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
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{c.conversaciones_hoy}</td>
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
            <p className="text-xs text-slate-400">Una fila = una conversación en un día. El identificador es lo que impide cobrarla dos veces.</p>
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
                    <td className="px-4 py-2 text-right tabular-nums text-slate-600">{c.amount === null || c.amount === undefined ? '—' : usd(c.amount)}</td>
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
