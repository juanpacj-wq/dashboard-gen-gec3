// pre-commit (metodología v2): sintaxis de lo que entra, nada de secretos ni residuos en la raíz,
// y con un lote reclamado (LOTE_SESION) nada fuera de su territorio. Lint por repo si existe.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const root = git(['rev-parse', '--show-toplevel']);
const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n').filter(Boolean);
if (staged.length === 0) process.exit(0);
const fallos = [];

// 1. Secretos y residuos.
for (const f of staged) {
  const base = path.basename(f);
  if (base === '.env' || (/^\.env\./.test(base) && base !== '.env.example')) fallos.push(`${f}: los .env no se versionan`);
  if (!f.includes('/') && /\.(xlsx|xls|png|jpe?g|zip|mov|mp4)$/i.test(f)) fallos.push(`${f}: binario suelto en la raíz; muévelo a docs/ (o bórralo)`);
}

// 2. Sintaxis de JS/MJS que entra.
for (const f of staged.filter((s) => /\.m?js$/.test(s) && !s.includes('node_modules'))) {
  const r = spawnSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8' });
  if (r.status !== 0) {
    const detalle = (r.stderr || '').split('\n').slice(0, 2).join(' ');
    fallos.push(`${f}: no parsea (node --check) ${detalle}`);
  }
}

// 3. Territorio del lote reclamado por este chat.
function globARegex(glob) {
  let re = '';
  const especiales = '.+^$' + '{}()|[]\\';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (especiales.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
const sesion = process.env.LOTE_SESION;
if (sesion) {
  const promptsDir = path.join(root, 'prompts');
  if (fs.existsSync(promptsDir)) {
    for (const d of fs.readdirSync(promptsDir)) {
      const f = path.join(promptsDir, d, 'LOTES.json');
      if (!fs.existsSync(f)) continue;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [id, l] of Object.entries(j.lotes)) {
        if (l.sesion !== sesion || l.estado === 'done') continue;
        const permitidos = [...l.territorio, `prompts/*/cierres/${id}.md`].map(globARegex);
        const fuera = staged.filter((s) => !permitidos.some((re) => re.test(s)));
        if (fuera.length) {
          fallos.push(`${id} (${sesion}): archivos fuera de tu territorio: ${fuera.join(', ')}. Regístralo en cierres/${id}.md §Bloqueos y marca el lote blocked.`);
        }
      }
    }
  }
}

// 4. Lint por repo, solo sobre lo que entra (si el repo tiene la herramienta).
const js = staged.filter((s) => /\.m?jsx?$/.test(s) && !s.includes('node_modules') && !s.startsWith('.githooks/'));
if (js.length && fs.existsSync(path.join(root, 'eslint.config.js'))) {
  const r = spawnSync(process.execPath, [path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'), ...js], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) fallos.push('eslint:\n' + (r.stdout || r.stderr).trim().split('\n').slice(-12).join('\n'));
}
const py = staged.filter((s) => /\.py$/.test(s) && s.startsWith('fabric-meter-sink/'));
if (py.length) {
  const venv = path.join(root, 'fabric-meter-sink', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (fs.existsSync(venv)) {
    const r = spawnSync(venv, ['-m', 'ruff', 'check', ...py.map((s) => path.join(root, s))], { encoding: 'utf8' });
    if (r.status !== 0) fallos.push('ruff:\n' + (r.stdout || r.stderr).trim().split('\n').slice(-12).join('\n'));
  }
}

if (fallos.length) {
  console.error('[pre-commit] commit rechazado:\n  - ' + fallos.join('\n  - '));
  process.exit(1);
}
