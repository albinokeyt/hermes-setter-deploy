import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Textarea, Banner } from './ui.jsx';

// 🏛️ Correos que NUNCA pueden ser el «Correo del Club» de un cliente (GET/PUT /api/settings/club-correos ·
// services/club.js · motivoNoClub). Siempre los dos de soporte y los administradores de Hermes; aquí se añaden otros.
export default function CorreosClub() {
  const [data, setData] = useState(null);
  const [texto, setTexto] = useState('');
  const [error, setError] = useState('');
  const [guardado, setGuardado] = useState(false);

  const aplicar = (d) => { setData(d); setTexto((d.no_club || []).join('\n')); };
  useEffect(() => { api.get('/api/settings/club-correos').then(aplicar).catch((e) => setError(e.message)); }, []);
  if (!data) return error ? <div className="mb-4"><Banner tone="error">Correo del Club: {error}</Banner></div> : null;

  const guardar = async () => {
    setError('');
    try {
      aplicar(await api.put('/api/settings/club-correos', { no_club: texto }));
      setGuardado(true);
      setTimeout(() => setGuardado(false), 2000);
    } catch (e) { setError(e.message); }
  };

  return (
    <Card className="mb-4 space-y-3 p-6">
      <h3 className="text-sm font-bold text-slate-800">🏛️ Correo del Club · correos que nunca se confirman</h3>
      <p className="text-xs text-slate-500">
        Soporte confirma en cada conexión del Club el <b>correo de la compra</b> («Correo del Club», en la ficha → Conexión GHL). Estos
        correos <b>no se pueden confirmar nunca</b> en la conexión de un cliente: el servidor lo rechaza y la ficha no los ofrece con «Usar».
        Con uno de ellos confirmado, una prueba del interruptor o una devolución hecha con ese correo acabarían en ese cliente.
      </p>
      <div className="space-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
        <div><b>Siempre:</b> {(data.fijos || []).join(' · ')}</div>
        <div><b>Administradores de Hermes:</b> {data.admins?.length ? data.admins.join(' · ') : 'ninguno tiene un correo como usuario'}</div>
      </div>
      <Textarea label="Además (uno por línea; «@dominio.com» = ese dominio y sus subdominios)" rows={4} value={texto}
        onChange={(e) => setTexto(e.target.value)} placeholder="p. ej. el correo personal de quien atiende el soporte" />
      {data.en_uso?.length > 0 && (
        <Banner tone="warn">
          Estas conexiones ya tienen confirmado como correo del Club uno de esta lista: cámbialo en su ficha.{' '}
          {data.en_uso.map((c) => `#${c.id} ${c.nombre} (${c.club_email})`).join(' · ')}
        </Banner>
      )}
      {error && <Banner tone="error">{error}</Banner>}
      <Button onClick={guardar}>{guardado ? '✓ Guardado' : 'Guardar correos'}</Button>
    </Card>
  );
}
