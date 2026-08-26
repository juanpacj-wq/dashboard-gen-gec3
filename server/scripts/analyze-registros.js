#!/usr/bin/env node
// Decide cuál de los IDs duplicados sirve, comparando lado a lado el banco A (40230.., INT32)
// contra el banco B (40091.., Mod10K) sobre las mismas magnitudes y el mismo medidor.
//
// Cuatro evidencias, de menos a más concluyente:
//   1. Concordancia instantánea: ¿los dos bancos publican el MISMO número en cada tick?
//   2. Salud del registro: ¿satura, se malforma, se congela, da la vuelta?
//   3. Identidades internas del banco B: del+rec debe ser del + rec. No depende de nada externo.
//   4. Contraste contra la energía real: la integral de 40204 (kW tot) dice cuánta energía
//      hubo de verdad en la ventana; el registro que sirve es el que la reproduce.
//
// Uso:  npm run shadow:registros:analyze
//       node scripts/analyze-registros.js [dir] [--json]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BANCO_A, BANCO_B, IDENTIDADES, MOD10K_MAX, PARES, REGISTROS } from './lib/regDecode.js'
import { trapezoidIntegral } from './lib/reservaStats.js'

const DEFAULT_DIR = fileURLToPath(new URL('../traces/registros', import.meta.url))
const args = process.argv.slice(2)
const JSON_MODE = args.includes('--json')
const TARGET = args.find((a) => !a.startsWith('--')) || DEFAULT_DIR
const out = (...a) => { if (!JSON_MODE) console.log(...a) }

const POR_REG = new Map(REGISTROS.map((r) => [r.reg, r]))
// Tolerancia del contraste contra la integral. La integral tiene su propio error (muestreo
// cada 5 s de una potencia que fluctúa), así que 2 % es holgado a propósito: sirve para
// distinguir "es esta magnitud" de "es otra cosa", no para calibrar.
const TOL_INTEGRAL_PCT = 2.0

function listar(target) {
  const st = statSync(target)
  if (st.isFile()) return [target]
  return readdirSync(target).filter((f) => f.startsWith('registros-') && f.endsWith('.jsonl')).map((f) => join(target, f))
}

function cargar(files) {
  const recs = []
  let malas = 0
  for (const f of files) {
    for (const linea of readFileSync(f, 'utf8').split('\n')) {
      const t = linea.trim()
      if (!t) continue
      try { recs.push(JSON.parse(t)) } catch { malas++ }
    }
  }
  return { recs, malas }
}

// ─── Salud de un registro a lo largo de la ventana ────────────────────────────
function salud(recs, reg) {
  const serie = []
  let ticksSat = 0, ticksMal = 0, ticksNull = 0
  for (const r of recs) {
    const v = r.regs?.[reg]
    if (!v || v.value == null) { ticksNull++; continue }
    if (v.sat) ticksSat++
    if (v.mal) ticksMal++
    serie.push({ ts: r.ts, tsMs: Date.parse(r.ts), value: v.value, sat: !!v.sat, mal: !!v.mal, w0: v.w0, w1: v.w1, tMs: v.tMs ?? null })
  }

  // Solo cuentan las muestras utilizables: una lectura saturada o malformada no es una medida.
  const buenas = serie.filter((s) => !s.sat && !s.mal)
  const primera = buenas[0] ?? null
  const ultima = buenas[buenas.length - 1] ?? null
  const delta = primera && ultima ? ultima.value - primera.value : null

  // Retrocesos: un acumulador solo debería subir. Un salto hacia atrás es una vuelta del
  // contador (o un formato mal interpretado), y en cualquier caso invalida el Δ de la ventana.
  let retrocesos = 0, saltoMax = 0
  for (let i = 1; i < buenas.length; i++) {
    const d = buenas[i].value - buenas[i - 1].value
    if (d < 0) { retrocesos++; if (Math.abs(d) > Math.abs(saltoMax)) saltoMax = d }
  }
  const congelado = buenas.length >= 2 && delta === 0

  return {
    reg, ...POR_REG.get(reg),
    muestras: serie.length, utilizables: buenas.length,
    ticksSat, ticksMal, ticksNull,
    valorInicial: primera?.value ?? null, valorFinal: ultima?.value ?? null, delta,
    retrocesos, saltoMax, congelado,
    serie,
  }
}

// El orden importa: la saturación y el formato inválido son la CAUSA de que no queden lecturas
// utilizables, así que se informan antes. Al revés, el diagnóstico diría "sin lecturas
// utilizables" y escondería el motivo, que es justo lo que hay que saber.
function motivoInservible(s) {
  if (s.ticksSat > 0) return `saturado en ${s.ticksSat}/${s.muestras} lecturas: el acumulador pasó el techo del formato Mod10K (${MOD10K_MAX.toLocaleString('es-CO')}) y el registro devuelve el centinela 0x7FFF/0`
  if (s.ticksMal > 0) return `formato inválido en ${s.ticksMal}/${s.muestras} lecturas (palabra baja con más de 4 dígitos decimales)`
  if (s.utilizables < 2) return 'sin lecturas utilizables'
  if (s.retrocesos > 0) return `el contador retrocede ${s.retrocesos} vez(ces) (salto máx. ${s.saltoMax.toLocaleString('es-CO')}): da la vuelta dentro de la ventana`
  return null
}

// Una identidad que falla puede fallar por motivos muy distintos, y la diferencia importa:
// un desfase de exactamente ±10.000.000 en TODAS las lecturas no es un error de medición ni de
// decodificación, es el registro dando la vuelta a los 7 dígitos. Decirlo así evita que alguien
// concluya que el banco está roto cuando lo que pasa es que el resultado no le cabe.
const VUELTA = 10_000_000
// Ojo con el orden de las pruebas: un desfase de ±1 también cumple `|d| % 10^7 <= 2`, así que
// el caso de redondeo se descarta PRIMERO. Un múltiplo de la vuelta exige además que la
// magnitud llegue al menos a una vuelta.
const esRedondeo = (d) => Math.abs(d) <= 2
const esVuelta = (d) => {
  const m = Math.abs(d)
  if (m < VUELTA - 2) return false
  const resto = m % VUELTA
  return resto <= 2 || VUELTA - resto <= 2
}

// `paso` = cuánto avanza el contador entre dos lecturas. Los registros del banco B están todos
// en el mismo bloque Modbus, así que entre ellos NO hay desfase de lectura: si la combinación
// difiere de sus términos en uno o dos escalones, es que el medidor actualiza el registro
// combinado un latido después que los términos. Es desfase interno del medidor, no un error.
function clasificarFalla(diffs, paso = 0) {
  if (diffs.length === 0) return { modoFalla: null, explicacion: null }
  const esPaso = (d) => paso > 0 && Math.abs(d) <= 2 * paso + 2

  if (diffs.every(esRedondeo)) {
    return { modoFalla: 'redondeo', explicacion: 'difiere en ±1 o ±2 cuentas: redondeo del último dígito, no un problema real' }
  }
  if (diffs.every(esVuelta)) {
    return {
      modoFalla: 'vuelta-10e7',
      explicacion: `desfase de exactamente ±${VUELTA.toLocaleString('es-CO')} en todas: el registro da la vuelta a los 7 dígitos porque el resultado no le cabe`,
    }
  }
  if (diffs.every(esPaso)) {
    return {
      modoFalla: 'escalon',
      explicacion: `difiere como mucho en 2 escalones del contador (±${(2 * paso).toLocaleString('es-CO')}): el medidor actualiza el registro combinado un latido después que sus términos`,
    }
  }
  const nV = diffs.filter(esVuelta).length
  const nR = diffs.filter((d) => !esVuelta(d) && esRedondeo(d)).length
  const nP = diffs.filter((d) => !esVuelta(d) && !esRedondeo(d) && esPaso(d)).length
  const otras = diffs.length - nV - nR - nP
  const partes = []
  if (nV) partes.push(`${nV} por vuelta a los 7 dígitos`)
  if (nR) partes.push(`${nR} por redondeo`)
  if (nP) partes.push(`${nP} por el latido del contador`)
  if (otras) partes.push(`${otras} por otra causa — revisar`)
  return { modoFalla: otras === 0 ? 'combinado' : 'mixto', explicacion: partes.join(', ') }
}

// Avance típico del contador entre dos lecturas consecutivas. Mediana y no promedio: un
// hueco por un error de lectura metería un salto grande que arruinaría el promedio.
function medianaAvance(serie) {
  const d = []
  for (let i = 1; i < serie.length; i++) {
    if (serie[i].sat || serie[i].mal || serie[i - 1].sat || serie[i - 1].mal) continue
    d.push(Math.abs(serie[i].value - serie[i - 1].value))
  }
  if (d.length === 0) return 0
  d.sort((a, b) => a - b)
  return d[Math.floor(d.length / 2)]
}

// ─── Análisis de un medidor ───────────────────────────────────────────────────
function analizarMedidor(recs) {
  recs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  const ok = recs.filter((r) => r.ok)
  const errores = recs.length - ok.length

  const puntos = ok.filter((r) => Number.isFinite(r.kwTot)).map((r) => ({ tsMs: Date.parse(r.ts), kw: r.kwTot }))
  const integralKwh = Math.abs(trapezoidIntegral(puntos))
  const kwMedio = puntos.length ? puntos.reduce((a, p) => a + p.kw, 0) / puntos.length : null
  const horas = puntos.length >= 2 ? (puntos[puntos.length - 1].tsMs - puntos[0].tsMs) / 3_600_000 : 0

  const saludes = new Map(REGISTROS.map((r) => [r.reg, salud(ok, r.reg)]))

  // 1. Lado a lado: ¿los dos bancos publican el mismo número, tick a tick?
  const pares = PARES.map((p) => {
    const sa = saludes.get(p.a), sb = saludes.get(p.b)
    let iguales = 0, porDesfase = 0, reales = 0, comparables = 0
    const porTs = new Map(sa.serie.map((s) => [s.ts, s]))
    const ejemplos = []
    // Cuánto avanza el contador entre dos ticks, medido sobre los datos (mediana, para que un
    // salto raro no la mueva). Es la escala natural contra la cual juzgar una diferencia A−B.
    const avancePorTick = medianaAvance(sa.serie)
    // Tamaño del escalón del contador: la diferencia no nula más pequeña que se observa entre
    // los dos bancos. Con el latido de 1 Hz del medidor, sale ≈ un segundo de energía.
    const escalones = []
    // Prueba decisiva del desfase: si la diferencia viene de que un banco se lee unos ms
    // después del otro, su signo tiene que seguir al del orden de lectura — y el capturador
    // alterna ese orden tick a tick justamente para poder comprobarlo.
    let concuerdaConOrden = 0, contradiceOrden = 0
    for (const s of sb.serie) {
      const a = porTs.get(s.ts)
      if (!a) continue
      comparables++
      // Se comparan solo lecturas utilizables de los dos lados: comparar contra un centinela
      // de saturación diría "distintos" por una razón que ya cubre el chequeo de salud.
      if (a.sat || a.mal || s.sat || s.mal) continue
      if (a.value === s.value) { iguales++; continue }

      const diff = a.value - s.value
      const gapMs = (a.tMs ?? 0) - (s.tMs ?? 0)      // >0 ⇒ A se leyó después de B
      // El contador NO sube de forma continua: late en escalones discretos (se observó un
      // paso por segundo, del tamaño de un segundo de energía). Por eso la cota no puede ser
      // "lo que acumula durante el hueco": si el hueco cruza un latido, la diferencia es un
      // escalón ENTERO por chico que sea el hueco. La cota correcta es lo que el contador
      // avanza en un tick completo, porque las dos lecturas caen dentro del mismo tick: una
      // diferencia mayor que eso ya no la puede producir el desfase.
      const explicable = Math.abs(diff) <= avancePorTick + 2 &&
        (gapMs === 0 || Math.sign(diff) === Math.sign(gapMs))
      if (explicable) porDesfase++
      else reales++
      escalones.push(Math.abs(diff))
      if (gapMs !== 0) { if (Math.sign(diff) === Math.sign(gapMs)) concuerdaConOrden++; else contradiceOrden++ }
      if (ejemplos.length < 3) ejemplos.push({ ts: s.ts, a: a.value, b: s.value, diff, gapMs, cota: Math.round(avancePorTick + 2), explicable })
    }
    return {
      magnitud: p.magnitud, regA: p.a, regB: p.b,
      comparables, iguales, porDesfase, reales, ejemplos,
      concuerdaConOrden, contradiceOrden,
      avancePorTick: Math.round(avancePorTick),
      escalon: escalones.length ? Math.min(...escalones) : null,
      // "Idéntico" = ninguna diferencia que el desfase de lectura no explique. Exigir
      // igualdad bit a bit sería exigir que dos lecturas separadas en el tiempo coincidan.
      identicos: reales === 0 && iguales + porDesfase > 0,
      deltaA: sa.delta, deltaB: sb.delta,
      inservibleA: motivoInservible(sa), inservibleB: motivoInservible(sb),
    }
  })

  // 2. Identidades internas del banco B.
  const identidades = IDENTIDADES.map((id) => {
    const sr = saludes.get(id.resultado)
    const series = id.terminos.map(([reg, signo]) => ({ signo, mapa: new Map(saludes.get(reg).serie.map((s) => [s.ts, s])) }))
    let ok2 = 0, falla = 0
    const ejemplos = []
    const fallas = []
    for (const s of sr.serie) {
      if (s.sat || s.mal) continue
      let esperado = 0, completo = true
      for (const t of series) {
        const v = t.mapa.get(s.ts)
        if (!v || v.sat || v.mal) { completo = false; break }
        esperado += t.signo * v.value
      }
      if (!completo) continue
      if (s.value === esperado) ok2++
      else {
        falla++
        fallas.push(s.value - esperado)
        if (ejemplos.length < 3) ejemplos.push({ ts: s.ts, publicado: s.value, esperado, diff: s.value - esperado })
      }
    }
    return {
      ...id, ok: ok2, falla, ejemplos, cumple: falla === 0 && ok2 > 0,
      ...clasificarFalla(fallas, medianaAvance(sr.serie)),
    }
  })

  // 3. Contraste contra la energía real: qué registro reproduce la integral de la potencia.
  const contraste = [...saludes.values()]
    .filter((s) => s.magnitud.startsWith('kWh') && s.delta != null && !motivoInservible(s))
    .map((s) => ({
      reg: s.reg, banco: s.banco, magnitud: s.magnitud, delta: s.delta,
      factor: integralKwh > 0 ? s.delta / integralKwh : null,
      errPct: integralKwh > 0 ? ((Math.abs(s.delta) - integralKwh) / integralKwh) * 100 : null,
    }))
    .sort((x, y) => Math.abs(x.errPct ?? 1e9) - Math.abs(y.errPct ?? 1e9))

  return {
    medidor: recs[0].medidor, host: recs[0].host,
    ticks: recs.length, ticksOk: ok.length, errores,
    kwMedio, integralKwh, horas,
    salud: [...saludes.values()].map((s) => ({ ...s, serie: undefined, inservible: motivoInservible(s) })),
    pares, identidades, contraste,
  }
}

// ─── Reporte ──────────────────────────────────────────────────────────────────
function imprimir(m) {
  out(`━━ ${m.medidor}  (${m.host})  ${m.ticksOk}/${m.ticks} lecturas OK${m.errores ? `, ${m.errores} con error` : ''}`)
  out(`   potencia media ${fmt(m.kwMedio, 1)} kW → energía real de la ventana (∫|P|dt sobre 40204) = ${fmt(m.integralKwh, 0)} kWh en ${fmt(m.horas, 3)} h`)
  out('')
  out('   ── LADO A LADO: magnitudes que los dos bancos publican ──')
  out(`   ${'magnitud'.padEnd(12)} ${'banco A'.padEnd(9)} ${'banco B'.padEnd(9)} ${'¿mismo valor?'.padEnd(16)} ${'Δ ventana A'.padStart(14)} ${'Δ ventana B'.padStart(14)}`)
  for (const p of m.pares) {
    const usables = p.iguales + p.porDesfase + p.reales
    const veredicto = usables === 0
      ? 'no comparable'
      : (p.reales === 0
        ? (p.porDesfase === 0 ? `sí, ${p.iguales}/${p.iguales} ✓` : `sí, ${p.iguales}+${p.porDesfase} desf. ✓`)
        : `NO: ${p.reales} difieren`)
    out(`   ${p.magnitud.padEnd(12)} ${String(p.regA).padEnd(9)} ${String(p.regB).padEnd(9)} ${veredicto.padEnd(16)} ${fmtN(p.deltaA).padStart(14)} ${fmtN(p.deltaB).padStart(14)}`)
    if (p.inservibleA) out(`     ⚠ ${p.regA} (banco A): ${p.inservibleA}`)
    if (p.inservibleB) out(`     ⚠ ${p.regB} (banco B): ${p.inservibleB}`)
    if (p.porDesfase > 0) {
      out(`     ${p.porDesfase} lectura(s) difieren por el desfase entre los dos bloques Modbus: ` +
        `el signo sigue al orden de lectura en ${p.concuerdaConOrden} de ${p.concuerdaConOrden + p.contradiceOrden}, ` +
        `y el escalón más chico es ${fmtN(p.escalon)} contra ${fmtN(p.avancePorTick)} que avanza el contador por tick`)
    }
    for (const e of p.ejemplos.slice(0, 2)) {
      out(`       ej. ${e.ts.slice(11, 19)}  A=${fmtN(e.a)}  B=${fmtN(e.b)}  Δ=${fmtN(e.diff)}  ` +
        `hueco ${e.gapMs > 0 ? '+' : ''}${e.gapMs}ms (cota ${e.cota}) → ${e.explicable ? 'lo explica el desfase' : 'NO lo explica el desfase'}`)
    }
  }

  out('')
  out('   ── SALUD DE CADA REGISTRO ──')
  out(`   ${'reg'.padEnd(7)} ${'bco'.padEnd(4)} ${'magnitud'.padEnd(14)} ${'Δ ventana'.padStart(14)}  observación`)
  for (const s of m.salud) {
    const obs = s.inservible || (s.congelado ? 'no se movió en toda la ventana' : 'sube de forma monótona, sin saturar')
    out(`   ${String(s.reg).padEnd(7)} ${s.banco.padEnd(4)} ${s.magnitud.padEnd(14)} ${fmtN(s.delta).padStart(14)}  ${obs}`)
  }

  out('')
  out('   ── IDENTIDADES INTERNAS DEL BANCO B ──')
  for (const id of m.identidades) {
    const est = id.cumple
      ? `✓ se cumple en ${id.ok}/${id.ok} lecturas`
      : (id.ok + id.falla === 0
        ? '· no verificable (registros saturados o malformados)'
        : `${['redondeo','escalon','combinado'].includes(id.modoFalla) ? '~' : '✗'} falla en ${id.falla} de ${id.ok + id.falla}`)
    out(`   ${id.nombre.padEnd(34)} ${est}`)
    if (id.explicacion) out(`     → ${id.explicacion}`)
    for (const e of id.ejemplos.slice(0, 2)) out(`     ej. ${e.ts.slice(11, 19)}  publicado=${fmtN(e.publicado)}  esperado=${fmtN(e.esperado)}  (Δ ${fmtN(e.diff)})`)
  }

  out('')
  out('   ── CONTRASTE CONTRA LA ENERGÍA REAL ──')
  if (m.contraste.length === 0) out('   ningún registro de kWh quedó utilizable en esta ventana.')
  for (const c of m.contraste) {
    const marca = Math.abs(c.errPct) <= TOL_INTEGRAL_PCT ? '✓' : ' '
    out(`   ${marca} ${String(c.reg).padEnd(7)} ${c.banco} ${c.magnitud.padEnd(14)} Δ=${fmtN(c.delta).padStart(12)}  = ${fmt(c.factor, 4)}× la energía real (${c.errPct >= 0 ? '+' : ''}${fmt(c.errPct, 2)}%)`)
  }
  out('')
}

// ─── Veredicto global ─────────────────────────────────────────────────────────
function veredictoGlobal(medidores) {
  const filas = []
  for (const p of PARES) {
    const estado = (reg) => {
      const problemas = medidores
        .map((m) => ({ medidor: m.medidor, motivo: m.salud.find((s) => s.reg === reg)?.inservible }))
        .filter((x) => x.motivo)
      return { reg, problemas, sano: problemas.length === 0 }
    }
    const a = estado(p.a), b = estado(p.b)
    const identicoEnTodos = medidores.every((m) => {
      const par = m.pares.find((x) => x.magnitud === p.magnitud)
      if (!par) return false
      // Un medidor donde el banco B saturó no aporta evidencia en contra: no hay con qué
      // comparar. Su problema ya lo reporta el chequeo de salud.
      return par.identicos || par.iguales + par.porDesfase + par.reales === 0
    })
    filas.push({
      magnitud: p.magnitud, a, b, identicoEnTodos,
      recomendado: a.sano && !b.sano ? p.a : (b.sano && !a.sano ? p.b : (a.sano && b.sano ? p.a : null)),
    })
  }
  return filas
}

function main() {
  let files
  try { files = listar(TARGET) } catch { console.error(`No existe ${TARGET}. Corre primero: npm run shadow:registros`); process.exit(1) }
  if (files.length === 0) { console.error(`No hay archivos registros-*.jsonl en ${TARGET}`); process.exit(1) }

  const { recs, malas } = cargar(files)
  const porMedidor = new Map()
  for (const r of recs) {
    if (!r.medidor) continue
    if (!porMedidor.has(r.medidor)) porMedidor.set(r.medidor, [])
    porMedidor.get(r.medidor).push(r)
  }

  const ts = recs.map((r) => r.ts).filter(Boolean).sort()
  const ventana = ts.length >= 2
    ? { desde: ts[0], hasta: ts[ts.length - 1], horas: (Date.parse(ts[ts.length - 1]) - Date.parse(ts[0])) / 3_600_000 }
    : null

  out(`Analizando ${files.length} archivo(s), ${recs.length} registros (${malas} líneas no parseables)`)
  if (ventana) out(`Ventana: ${ventana.desde} → ${ventana.hasta}  (${ventana.horas.toFixed(2)} h)`)
  out(`Banco A (40230..40238): INT32 base 65536.   Banco B (40091..40105): Mod10K base 10000.\n`)

  const medidores = [...porMedidor.entries()].sort().map(([, rs]) => analizarMedidor(rs))
  for (const m of medidores) imprimir(m)

  const global = veredictoGlobal(medidores)
  out('══════ VEREDICTO: cuál ID usar por magnitud ══════')
  out(`   ${'magnitud'.padEnd(12)} ${'banco A'.padEnd(9)} ${'banco B'.padEnd(9)} ${'¿publican lo mismo?'.padEnd(21)} usar`)
  for (const f of global) {
    const estA = f.a.sano ? 'sano' : `${f.a.problemas.length} medidor(es) con problema`
    const estB = f.b.sano ? 'sano' : `${f.b.problemas.length} medidor(es) con problema`
    out(`   ${f.magnitud.padEnd(12)} ${String(f.a.reg).padEnd(9)} ${String(f.b.reg).padEnd(9)} ${(f.identicoEnTodos ? 'sí, valor idéntico' : 'NO').padEnd(21)} ${f.recomendado ?? '—'}`)
    out(`     A ${String(f.a.reg).padEnd(6)} ${estA}${f.a.problemas.length ? ': ' + f.a.problemas.map((x) => x.medidor).join(', ') : ''}`)
    out(`     B ${String(f.b.reg).padEnd(6)} ${estB}${f.b.problemas.length ? ': ' + f.b.problemas.map((x) => x.medidor).join(', ') : ''}`)
  }

  const soloB = BANCO_B.filter((r) => !PARES.some((p) => p.b === r.reg))
  const soloA = BANCO_A.filter((r) => !PARES.some((p) => p.a === r.reg))
  out('')
  out('   Sin contraparte (existen en un solo banco, no se pueden comparar entre bancos):')
  for (const r of [...soloA, ...soloB]) {
    const conProblema = medidores.filter((m) => m.salud.find((s) => s.reg === r.reg)?.inservible)
    out(`     ${String(r.reg).padEnd(7)} banco ${r.banco}  ${r.magnitud.padEnd(14)} ${conProblema.length ? `⚠ inservible en ${conProblema.length}/${medidores.length} medidores` : 'sano en todos'}`)
  }

  if (JSON_MODE) {
    console.log(JSON.stringify({
      ventana, archivos: files.length, registros: recs.length,
      catalogo: { bancoA: BANCO_A, bancoB: BANCO_B, pares: PARES, identidades: IDENTIDADES },
      medidores, global,
      sinContraparte: [...soloA, ...soloB].map((r) => ({
        ...r,
        inservibleEn: medidores.filter((m) => m.salud.find((s) => s.reg === r.reg)?.inservible).map((m) => m.medidor),
      })),
    }, null, 2))
  }
  process.exit(0)
}

function fmt(n, d = 3) { return n == null || Number.isNaN(n) ? '—' : n.toFixed(d) }
function fmtN(n) { return n == null ? '—' : n.toLocaleString('es-CO') }

main()
