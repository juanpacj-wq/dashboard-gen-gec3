// server/healthSnapshot.js
// Construye snapshot canónico del estado de todos los servicios de extracción.
// Consumido por GET /health/detailed (server.js) y por el alerter (alerter.js).

/**
 * @param {object} deps
 * @param {object} [deps.scraper]            MeterPoller o PMEScraper top-level (.getStatus()).
 *                                           En este codebase el top-level es ExtractorOrchestrator,
 *                                           que ya encapsula meter+pme — pasar null y usar `orchestrator`.
 * @param {object} [deps.orchestrator]       ExtractorOrchestrator (.getStatus())
 * @param {object} [deps.accumulator]        EnergyAccumulator (.getStatus())
 * @param {object} [deps.emailDispatchGEC]   EmailDispatchService GEC (.getStatus())
 * @param {object} [deps.emailDispatchTGJ]   EmailDispatchService TGJ (.getStatus())
 * @param {object} [deps.despachoScraper]    DespachoscraperService (.getStatus())
 * @param {object} [deps.redespachoScraper]  RedespachoscraperService (.getStatus())
 * @param {number} [deps.clientsCount]       Conexiones WS activas (server.js sabe clients.size)
 * @param {number} [deps.now=Date.now()]     Inyectable para tests
 * @returns {object} snapshot canónico
 */
export function buildHealthSnapshot(deps) {
  const now = deps.now ?? Date.now()
  const safe = (svc) => {
    if (svc == null || typeof svc.getStatus !== 'function') return null
    try { return svc.getStatus() } catch { return null }
  }

  return {
    evaluatedAt: new Date(now).toISOString(),
    services: {
      meterPoller:       safe(deps.scraper),
      orchestrator:      safe(deps.orchestrator),
      accumulator:       safe(deps.accumulator),
      emailDispatchGEC:  safe(deps.emailDispatchGEC),
      emailDispatchTGJ:  safe(deps.emailDispatchTGJ),
      despachoScraper:   safe(deps.despachoScraper),
      redespachoScraper: safe(deps.redespachoScraper),
    },
    summary: {
      clientsConnected: deps.clientsCount ?? null,
    },
  }
}
