// 🔒 Máscara de una API key para enseñarla en el panel sin revelarla: «sk-or-…1c96» (6 primeros y 4 últimos, el criterio
// de siempre de Proveedores). Con una clave corta esos 10 caracteres serían casi toda la clave: entonces solo se enseña
// el final, o nada.
export function mascaraClave(clave) {
  const k = String(clave || '');
  if (!k) return '';
  if (k.length >= 20) return `${k.slice(0, 6)}…${k.slice(-4)}`;
  if (k.length >= 12) return `…${k.slice(-4)}`;
  return '…';
}
