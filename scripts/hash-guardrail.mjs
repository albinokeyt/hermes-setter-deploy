// md5 del DEFAULT_GUARDRAIL actual (declaración con el backtick en la línea siguiente).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const src = readFileSync('src/services/agent.js', 'utf8');
const decl = src.indexOf('export const DEFAULT_GUARDRAIL');
const start = src.indexOf('`', decl);
let lit = null;
for (let i = start + 1; i < src.length; i++) {
  const ch = src[i];
  if (ch === '\\') { i++; continue; }
  if (ch === '$' && src[i + 1] === '{') { console.error('tiene interpolación'); process.exit(1); }
  if (ch === '`') { lit = src.slice(start, i + 1); break; }
}
const valor = (0, eval)(lit).trim();
console.log(createHash('md5').update(valor, 'utf8').digest('hex'), ' -- DEFAULT_GUARDRAIL actual,', valor.length, 'chars');
