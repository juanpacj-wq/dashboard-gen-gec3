// commit-msg (metodología v2): sin firmas de IA; con un lote reclamado, scope (D-NNN LNN).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const archivo = process.argv[2];
const msg = fs.readFileSync(archivo, 'utf8');
const cuerpo = msg.split('\n').filter((l) => !l.startsWith('#')).join('\n');
const fallos = [];

if (/co-authored-by/i.test(cuerpo)) fallos.push('el mensaje trae "Co-Authored-By": los commits de este repo no llevan coautores ni firmas de IA');
if (/generated with/i.test(cuerpo)) fallos.push('el mensaje trae "Generated with": sin firmas de IA');

// Con un lote reclamado por este chat (LOTE_SESION) el scope tiene que citar el lote: tipo(D-NNN LNN): …
const sesion = process.env.LOTE_SESION;
if (sesion) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const promptsDir = path.join(root, 'prompts');
  let lote = null;
  let impl = null;
  if (fs.existsSync(promptsDir)) {
    for (const d of fs.readdirSync(promptsDir)) {
      const f = path.join(promptsDir, d, 'LOTES.json');
      if (!fs.existsSync(f)) continue;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [id, l] of Object.entries(j.lotes)) {
        if (l.sesion === sesion && l.estado !== 'done') { lote = id; impl = j.implementacion; }
      }
    }
  }
  if (lote) {
    const primera = cuerpo.split('\n').find((l) => l.trim()) || '';
    const scope = `(${impl} ${lote})`;
    if (!primera.includes(scope)) {
      fallos.push(`la sesión ${sesion} tiene reclamado ${lote}: el título debe llevar el scope "${scope}" (p. ej. "feat${scope}: …")`);
    }
  }
}

if (fallos.length) {
  console.error('[commit-msg] commit rechazado:\n  - ' + fallos.join('\n  - '));
  process.exit(1);
}
