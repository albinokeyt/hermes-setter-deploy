// Recorre el historial git y calcula el md5 de CADA generación de los prompts por defecto
// (DEFAULT_ARCHITECT, DEFAULT_CORRECTOR en promptEditor.js; DEFAULT_GUARDRAIL en agent.js).
// Uso: node scripts/hashes-defaults.mjs  (desde la raíz del repo)
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

// Extrae el template literal `...` completo de `export const NOMBRE = \`...\`;` respetando \\-escapes.
function extraerLiteral(src, nombre) {
  const decl = src.indexOf(`export const ${nombre} = \``);
  if (decl < 0) return null;
  const start = src.indexOf('`', decl);
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '$' && src[i + 1] === '{') return null; // interpolación: no evaluable en frío
    if (ch === '`') return src.slice(start, i + 1);
  }
  return null;
}

const objetivos = [
  ['src/routes/promptEditor.js', ['DEFAULT_ARCHITECT', 'DEFAULT_CORRECTOR']],
  ['src/services/agent.js', ['DEFAULT_GUARDRAIL']],
];

const vistos = new Map(); // hash -> etiqueta
for (const [file, constantes] of objetivos) {
  const commits = execSync(`git log --format=%H -- "${file}"`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  for (const c of commits) {
    let src;
    try { src = execSync(`git show ${c}:"${file}"`, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); } catch { continue; }
    for (const nombre of constantes) {
      const lit = extraerLiteral(src, nombre);
      if (!lit) continue;
      let valor;
      try { valor = (0, eval)(lit); } catch { continue; }
      const t = String(valor).trim(); // el PUT guardaba .trim()
      const h = md5(t);
      if (!vistos.has(h)) vistos.set(h, `${nombre} @ ${c.slice(0, 8)}`);
    }
  }
}

for (const [h, etiqueta] of vistos) console.log(h, ' -- ', etiqueta);
console.log(`\nTOTAL: ${vistos.size} hashes únicos`);
