// server/alertDispatcher.js
// Transport HTTP del alerter. Serializa según ALERT_TARGET y POST a ALERT_WEBHOOK_URL.
// No tira si la URL no está configurada — loguea y sigue.

const SUPPORTED_TARGETS = ['generic', 'teams', 'slack']

function severityColor(sev) {
  // Hex sin '#' para Teams MessageCard themeColor.
  return {
    CRITICAL: 'D32F2F',     // rojo
    WARN: 'F9A825',         // ámbar
    RECOVERED: '2E7D32',    // verde
  }[sev] ?? '607D8B'
}

function serialize(alert, target) {
  if (target === 'teams') {
    return {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: alert.title,
      themeColor: severityColor(alert.severity),
      title: `[${alert.severity}] ${alert.title}`,
      text: alert.body,
      sections: [{
        facts: [
          { name: 'incident_key', value: alert.incidentKey },
          { name: 'first_seen_at', value: alert.firstSeenAt },
          { name: 'emitted_at', value: alert.emittedAt },
        ],
      }],
    }
  }
  if (target === 'slack') {
    const emoji = {
      CRITICAL: ':rotating_light:',
      WARN: ':warning:',
      RECOVERED: ':white_check_mark:',
    }[alert.severity] ?? ':grey_question:'
    return {
      text: `${emoji} *[${alert.severity}]* ${alert.title}`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `${alert.severity}: ${alert.title}` } },
        { type: 'section', text: { type: 'mrkdwn', text: alert.body } },
        { type: 'context', elements: [
          { type: 'mrkdwn', text: `*incident:* \`${alert.incidentKey}\` · *first seen:* ${alert.firstSeenAt} · *emitted:* ${alert.emittedAt}` },
        ] },
      ],
    }
  }
  // generic
  return {
    severity: alert.severity,
    incident_key: alert.incidentKey,
    title: alert.title,
    body: alert.body,
    first_seen_at: alert.firstSeenAt,
    emitted_at: alert.emittedAt,
    source: 'dashboard-gen-gec3',
  }
}

/**
 * Construye un dispatch(alert) que serializa según target y manda HTTP POST.
 * @param {object} opts
 * @param {string|null} opts.webhookUrl       ALERT_WEBHOOK_URL (null/empty → no manda).
 * @param {string} [opts.target='generic']    ALERT_TARGET ∈ {'generic','teams','slack'}.
 * @param {function} [opts.fetch]             Inyectable para tests; default globalThis.fetch.
 * @param {object} [opts.logger=console]      Logger inyectable.
 * @returns {function(alert): Promise<void>}
 */
export function createAlertDispatcher({ webhookUrl, target = 'generic', fetch = globalThis.fetch, logger = console }) {
  const tgt = (target || 'generic').toLowerCase()
  if (!SUPPORTED_TARGETS.includes(tgt)) {
    logger.warn(`[alertDispatcher] ALERT_TARGET='${target}' no soportado; cayendo a 'generic'`)
  }
  const effectiveTarget = SUPPORTED_TARGETS.includes(tgt) ? tgt : 'generic'

  return async function dispatch(alert) {
    const payload = serialize(alert, effectiveTarget)
    if (!webhookUrl) {
      logger.warn(`[alertDispatcher] ALERT_WEBHOOK_URL no configurado; alert NO enviado: ${alert.severity} ${alert.incidentKey}`)
      return
    }
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable>')
        logger.error(`[alertDispatcher] webhook HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
    } catch (err) {
      logger.error(`[alertDispatcher] webhook error: ${err.message}`)
    }
  }
}
