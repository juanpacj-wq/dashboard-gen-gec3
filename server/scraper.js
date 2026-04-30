import { chromium } from 'playwright'
import { writeFileSync } from 'fs'
import { resolve } from 'path'

const RECONNECT_MS = 5_000
const FALLBACK_MS  = 3_000
const DEBOUNCE_MS  = 300

const WATCHDOG_INTERVAL_MS   = 10_000   // chequeo cada 10s
const STALE_WARNING_MS       = 30_000   // aviso a los 30s
const STALE_RESTART_MS       = 60_000   // restart forzado a los 60s
const STALE_VALUE_RESTART_MS = 5 * 60_000  // 5 min sin cambio de valor → reinicio (feed PME muerto)
const HEARTBEAT_MS           = 60_000   // log periódico de vida
const PME_LOG_THROTTLE_MS    = 30_000   // throttle del resumen [PME]

// HEADLESS=false para ventana visible (debug local), cualquier otro valor = headless nuevo
const HEADLESS = process.env.HEADLESS === 'false' ? false : true

export class PMEScraper {
  #pme; #units; #onData
  #browser = null; #page = null; #running = false
  #lastDataAt = 0
  #lastValueChangeAt = 0
  #lastValuesKey = null
  #updateCount = 0
  #errorCount = 0
  #warming = false
  #lastPmeLogAt = 0
  #updateCountAtLastLog = 0
  #watchdogTimer = null
  #heartbeatTimer = null

  constructor({ pme, units, onData }) {
    this.#pme   = pme
    this.#units = units
    this.#onData = onData
  }

  getStatus() {
    const now = Date.now()
    return {
      running: this.#running,
      warming: this.#warming,
      lastDataAt: this.#lastDataAt || null,
      secondsSinceUpdate: this.#lastDataAt ? Math.floor((now - this.#lastDataAt) / 1000) : null,
      lastValueChangeAt: this.#lastValueChangeAt || null,
      secondsSinceValueChange: this.#lastValueChangeAt
        ? Math.floor((now - this.#lastValueChangeAt) / 1000)
        : null,
      updateCount: this.#updateCount,
      errorCount: this.#errorCount,
      stale: this.#lastDataAt > 0 && (now - this.#lastDataAt) > STALE_RESTART_MS,
      valueStale: this.#lastValueChangeAt > 0 && (now - this.#lastValueChangeAt) > STALE_VALUE_RESTART_MS,
    }
  }

  // ── API pública ─────────────────────────────────────────────────────────────

  async start() {
    this.#running = true
    this.#startWatchdog()
    this.#startHeartbeat()
    while (this.#running) {
      try {
        await this.#run()
      } catch (err) {
        console.error('[Scraper] Error en sesión:', err.message)
        await this.#teardown()
        if (!this.#running) break
        console.log(`[Scraper] Reintentando en ${RECONNECT_MS / 1000}s…`)
        await sleep(RECONNECT_MS)
      }
    }
  }

  async stop() {
    this.#running = false
    if (this.#watchdogTimer)  { clearInterval(this.#watchdogTimer);  this.#watchdogTimer  = null }
    if (this.#heartbeatTimer) { clearInterval(this.#heartbeatTimer); this.#heartbeatTimer = null }
    await this.#teardown()
  }

  // ── Watchdog / Heartbeat ────────────────────────────────────────────────────

  #startWatchdog() {
    if (this.#watchdogTimer) return
    this.#watchdogTimer = setInterval(() => {
      // No chequear durante setup ni mientras no haya browser activo
      if (this.#warming || !this.#browser || !this.#page) return
      if (this.#lastDataAt === 0) return // aún sin primera lectura

      const gap = Date.now() - this.#lastDataAt
      if (gap > STALE_RESTART_MS) {
        this.#errorCount++
        console.error(
          `[Scraper] WATCHDOG: sin datos hace ${(gap / 1000).toFixed(0)}s. ` +
          `Forzando reinicio del navegador (errorCount=${this.#errorCount})…`
        )
        // Cerrar el browser desencadena el cierre de page, lo que resuelve el
        // waitForEvent('close') en #observe(); #run() retorna y el while loop
        // de start() reabre todo desde cero.
        this.#teardown().catch(() => {})
        return
      } else if (gap > STALE_WARNING_MS) {
        console.warn(`[Scraper] sin datos hace ${(gap / 1000).toFixed(0)}s (warning)`)
      }

      // Detección de freeze: el feed PME murió pero el setInterval de la página
      // sigue re-leyendo el DOM estático. El watchdog basado en lastDataAt nunca
      // dispararía. Forzamos restart si los valores no cambian por mucho tiempo.
      const valueGap = Date.now() - this.#lastValueChangeAt
      if (this.#lastValueChangeAt > 0 && valueGap > STALE_VALUE_RESTART_MS) {
        this.#errorCount++
        console.error(
          `[Scraper] VALUE-WATCHDOG: valores congelados hace ${(valueGap / 1000) | 0}s ` +
          `(errorCount=${this.#errorCount}). Forzando reinicio del navegador…`
        )
        this.#teardown().catch(() => {})
      }
    }, WATCHDOG_INTERVAL_MS)
  }

  #startHeartbeat() {
    if (this.#heartbeatTimer) return
    this.#heartbeatTimer = setInterval(() => {
      const status = this.getStatus()
      const ago    = status.secondsSinceUpdate      != null ? `${status.secondsSinceUpdate}s`      : 'nunca'
      const agoVal = status.secondsSinceValueChange != null ? `${status.secondsSinceValueChange}s` : 'nunca'
      console.log(
        `[PME Heartbeat] última lectura hace ${ago} · ` +
        `último cambio de valor hace ${agoVal} · ` +
        `${status.updateCount} actualizaciones · ` +
        `running=${status.running} warming=${status.warming} errors=${status.errorCount}`
      )
    }, HEARTBEAT_MS)
  }

  // ── Ciclo de vida ───────────────────────────────────────────────────────────

  async #teardown() {
    try { await this.#browser?.close() } catch {}
    this.#browser = null
    this.#page    = null
    // Resetear marcadores de freeze para que el browser nuevo no herede
    // el timestamp viejo y se auto-reinicie de inmediato.
    this.#lastValueChangeAt = 0
    this.#lastValuesKey = null
  }

  async #run() {
    this.#warming = true
    console.log(`[Scraper] Iniciando navegador (headless=${HEADLESS})…`)
    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    if (HEADLESS) args.push('--headless=new')
    this.#browser = await chromium.launch({ headless: HEADLESS, args })

    const ctx = await this.#browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    })
    this.#page = await ctx.newPage()

    await this.#login()
    await this.#navigateToDiagram()
    await this.#diagnose()   // ← imprime DOM y guarda screenshot, solo en arranque
    await this.#observe()
  }

  // ── Login ───────────────────────────────────────────────────────────────────

  async #login() {
    const { loginUrl, user, password } = this.#pme
    console.log('[Scraper] Navegando a login:', loginUrl)

    await this.#page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    const pwField = await this.#page.$('input[type="password"]')
    if (!pwField) {
      console.log('[Scraper] Sin formulario — sesión activa o auth integrada.')
      return
    }

    for (const sel of [
      'input[name*="user" i]', 'input[name*="login" i]',
      'input[id*="user" i]',  'input[id*="UserName" i]',
      'input[type="text"]:first-of-type',
    ]) {
      const el = await this.#page.$(sel)
      if (el) { await el.fill(user); break }
    }

    await pwField.fill(password)

    const btn = await this.#page.$(
      'input[type="submit"], button[type="submit"], button[class*="login" i]'
    )
    btn ? await btn.click() : await this.#page.keyboard.press('Enter')

    await this.#page
      .waitForNavigation({ waitUntil: 'networkidle', timeout: 15_000 })
      .catch(() => {})

    console.log('[Scraper] Login OK. URL:', this.#page.url())
  }

  // ── Diagrama ────────────────────────────────────────────────────────────────

  async #navigateToDiagram() {
    console.log('[Scraper] Cargando diagrama…')
    await this.#page.goto(this.#pme.diagramUrl, { waitUntil: 'load', timeout: 40_000 })

    await this.#page
      .waitForFunction(() => document.body?.children.length > 0, { timeout: 10_000 })
      .catch(() => {})

    // Espera extra para que JS del diagrama termine de renderizar
    await sleep(3_000)
    console.log('[Scraper] Diagrama cargado. URL:', this.#page.url())
  }

  // ── Diagnóstico (se ejecuta UNA vez al arrancar) ────────────────────────────

  async #diagnose() {
    console.log('\n[Diagnóstico] ═══════════════════════════════════════════')

    // Screenshot
    const screenshotPath = resolve('debug-screenshot.png')
    await this.#page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
    console.log(`[Diagnóstico] Screenshot guardado en: ${screenshotPath}`)

    // Análisis del DOM
    const info = await this.#page.evaluate((units) => {
      const result = {
        title:        document.title,
        url:          location.href,
        iframes:      [...document.querySelectorAll('iframe')].map(f => f.src || f.name || '(sin src)'),
        svgCount:     document.querySelectorAll('svg').length,
        tableRows:    document.querySelectorAll('tr').length,
        svgTexts:     [...document.querySelectorAll('text')].slice(0, 60).map(t => t.textContent.trim()).filter(Boolean),
        allText:      [...document.querySelectorAll('td, span, div, p, label')]
                        .map(e => e.textContent.trim())
                        .filter(t => t.length > 0 && t.length < 80)
                        .slice(0, 80),
        numericCells: [],
        unitSearch:   {},
      }

      // Buscar celdas con valores numéricos en rango de generación (50–500k kW)
      for (const el of document.querySelectorAll('td, span, div, text')) {
        const raw = el.textContent.trim().replace(/[^\d.,]/g, '')
        const val = parseFloat(raw.replace(',', '.'))
        if (!isNaN(val) && val > 1000 && val < 500000) {
          result.numericCells.push({
            tag:  el.tagName,
            text: el.textContent.trim().slice(0, 40),
            val,
          })
        }
      }
      result.numericCells = result.numericCells.slice(0, 20)

      // Buscar las referencias de cada unidad
      for (const unit of units) {
        const found = [...document.querySelectorAll('*')]
          .filter(e => e.textContent.trim() === unit.referencia)
          .map(e => ({
            tag:    e.tagName,
            class:  e.className?.toString?.()?.slice(0, 50) ?? '',
            parent: e.parentElement?.tagName ?? '',
            next:   e.nextElementSibling?.textContent?.trim?.()?.slice(0, 30) ?? '',
          }))
        result.unitSearch[unit.referencia] = found.slice(0, 5)
      }

      return result
    }, this.#units)

    console.log('[Diagnóstico] Título:', info.title)
    console.log('[Diagnóstico] Iframes:', info.iframes.length ? info.iframes : 'ninguno')
    console.log('[Diagnóstico] SVGs:', info.svgCount, '| SVG <text> encontrados:', info.svgTexts.length)
    console.log('[Diagnóstico] Filas de tabla (<tr>):', info.tableRows)

    if (info.svgTexts.length) {
      console.log('[Diagnóstico] Textos SVG (primeros 60):')
      console.log(' ', info.svgTexts.join(' | '))
    }

    console.log('[Diagnóstico] Celdas con valores numéricos en rango generación:')
    if (info.numericCells.length) {
      info.numericCells.forEach(c => console.log(`  <${c.tag}> "${c.text}" → ${c.val}`))
    } else {
      console.log('  ⚠ Ninguna celda con valores en rango 1000–500000')
    }

    console.log('[Diagnóstico] Búsqueda por referencia de unidad:')
    for (const [ref, matches] of Object.entries(info.unitSearch)) {
      if (matches.length) {
        console.log(`  "${ref}" encontrado en:`)
        matches.forEach(m => console.log(`    <${m.tag}> class="${m.class}" parent=<${m.parent}> next="${m.next}"`))
      } else {
        console.log(`  "${ref}" → NO encontrado en el DOM`)
      }
    }

    // Guardar dump completo en archivo para análisis
    const dumpPath = resolve('debug-dom.json')
    writeFileSync(dumpPath, JSON.stringify(info, null, 2))
    console.log(`[Diagnóstico] Dump completo en: ${dumpPath}`)
    console.log('[Diagnóstico] ═══════════════════════════════════════════\n')
  }

  // ── Observación en tiempo real ──────────────────────────────────────────────

  async #observe() {
    await this.#page.exposeFunction('__onPMEData', (rawUnits) => {
      const anyValid = rawUnits.some(u => u.valueMW !== null)
      if (!anyValid) return

      this.#lastDataAt = Date.now()
      this.#updateCount++

      // Detección de freeze: cuantizamos a 0.01 (10 kW) para normalizar la
      // comparación. Marcador 'x' para nulls evita que un fallo parcial de
      // selector enmascare un freeze real.
      const valuesKey = rawUnits
        .map(u => u.valueMW != null ? u.valueMW.toFixed(2) : 'x')
        .join('|')
      if (valuesKey !== this.#lastValuesKey) {
        this.#lastValueChangeAt = Date.now()
        this.#lastValuesKey = valuesKey
      }

      this.#onData({
        type:      'update',
        units:     rawUnits,
        timestamp: new Date().toISOString(),
      })

      // Throttle: 1 línea cada PME_LOG_THROTTLE_MS con resumen de la ventana
      if (this.#lastDataAt - this.#lastPmeLogAt >= PME_LOG_THROTTLE_MS) {
        const delta = this.#updateCount - this.#updateCountAtLastLog
        const summary = rawUnits
          .map(u => `${u.label}: ${u.valueMW !== null ? u.valueMW.toFixed(1) + ' MW' : '?'}`)
          .join(' | ')
        console.log(`[PME] ${summary} · (+${delta} updates en ventana)`)
        this.#lastPmeLogAt = this.#lastDataAt
        this.#updateCountAtLastLog = this.#updateCount
      }
    })

    await this.#page.evaluate(
      ({ units, fallbackMs, debounceMs }) => {

        // Formato europeo: "145.636,3" → 145636.3
        // Formato inglés:  "145,636.3" → 145636.3
        function parseEuropean(text) {
          if (!text) return null
          const s = text.trim()
          // Detectar si usa coma como decimal (formato europeo)
          const euroPattern = /^-?[\d.]+,\d{1,3}$/
          let normalized
          if (euroPattern.test(s.replace(/[^\d.,-]/g, ''))) {
            normalized = s.replace(/[^\d,\-]/g, '').replace('.', '').replace(',', '.')
          } else {
            normalized = s.replace(/[^\d.\-]/g, '')
          }
          const val = parseFloat(normalized)
          return isNaN(val) ? null : val
        }

        function findValue(unit) {
          // Encontrar la Nth ocurrencia (unit.occurrence) del span con el texto de referencia.
          // Esto diferencia unidades con la misma etiqueta (ej. ambas Guajiras = "kW tot").
          const allMatches = [...document.querySelectorAll('span')]
            .filter(s => s.textContent.trim() === unit.referencia)

          const span = allMatches[unit.occurrence ?? 0]
          if (!span) return null

          const td = span.closest('td, th')
          if (!td) return null

          // Opción A: span → ":" → span_valor
          const colonSibling = span.nextElementSibling
          if (colonSibling?.nextElementSibling) {
            const n = parseEuropean(colonSibling.nextElementSibling.textContent)
            if (n !== null) return n
          }

          // Opción B: texto del TD completo después del ":"
          const afterColon = td.textContent.split(':').slice(1).join(':').trim()
          if (afterColon) {
            const n = parseEuropean(afterColon)
            if (n !== null) return n
          }

          return null
        }

        function readAll() {
          return units.map(unit => ({
            id:      unit.id,
            label:   unit.label,
            valueMW: (() => { const r = findValue(unit); return r !== null ? r / 1000 : null })(),
            maxMW:   unit.maxMW,
          }))
        }

        let debounceTimer
        function push() {
          clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => window.__onPMEData(readAll()), debounceMs)
        }

        const observer = new MutationObserver(push)
        observer.observe(document.body, { subtree: true, childList: true, characterData: true })

        for (const iframe of document.querySelectorAll('iframe')) {
          try { observer.observe(iframe.contentDocument.body, { subtree: true, childList: true, characterData: true }) } catch {}
        }

        setInterval(push, fallbackMs)
        push()
      },
      { units: this.#units, fallbackMs: FALLBACK_MS, debounceMs: DEBOUNCE_MS }
    )

    console.log('[Scraper] Observación activa…')
    // Resetear timestamps para dar al observer un ciclo de gracia antes de
    // que el watchdog lo evalúe (la primera mutación llega dentro de FALLBACK_MS).
    this.#lastDataAt = Date.now()
    this.#lastValueChangeAt = Date.now()
    this.#warming = false
    await this.#page.waitForEvent('close', { timeout: 0 }).catch(() => {})
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
