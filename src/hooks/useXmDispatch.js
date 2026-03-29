import { useState, useEffect, useCallback, useRef } from "react";

// Map internal unit IDs to XM codsic_planta codes
const UNIT_XM_CODE = {
  GEC3: "GEC3",
  GEC32: "GE32",
  TGJ1: "TGJ1",
  TGJ2: "TGJ2",
};

const XM_CODES = Object.values(UNIT_XM_CODE);
const HOUR_KEYS = Array.from({ length: 24 }, (_, i) => `Hour${String(i + 1).padStart(2, "0")}`);

// Returns { value: number, missing: boolean } per hour
// missing=true means the API returned null/undefined/empty for that period
async function fetchMetric(metricId, dateStr) {
  const res = await fetch("/api/xm/hourly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      MetricId: metricId,
      StartDate: dateStr,
      EndDate: dateStr,
      Entity: "Recurso",
      Filter: [],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const records = json?.Items || [];
  if (records.length === 0) throw new Error(`Sin datos ${metricId}`);

  const byCode = {};
  for (const item of records) {
    const vals = item.HourlyEntities?.[0]?.Values;
    if (!vals) continue;
    const code = (vals.code || "").trim();
    if (!XM_CODES.includes(code)) continue;
    // When a unit exists in the response, null/empty means 0 MW (not "missing")
    byCode[code] = HOUR_KEYS.map(k => {
      const raw = vals[k];
      if (raw == null || raw === "") return 0;
      return Math.round(parseFloat(raw) / 1000 * 10) / 10;
    });
  }
  return byCode;
}

export function useXmDispatch(redespIntervalMs = 300000) {
  const [dispatchData, setDispatchData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const despFetched = useRef(false);

  const fetchRedespacho = useCallback(async (prevData) => {
    const dateStr = new Date().toISOString().split("T")[0];
    try {
      const redespData = await fetchMetric("GeneProgRedesp", dateStr);
      const result = {};
      for (const [unitId, xmCode] of Object.entries(UNIT_XM_CODE)) {
        result[unitId] = {
          despacho: prevData?.[unitId]?.despacho || null,
          redespacho: redespData[xmCode] || null,
        };
      }
      setDispatchData(result);
      setError(null);
      setLoading(false);
      return result;
    } catch (e) {
      setError(e.message);
      setLoading(false);
      return prevData;
    }
  }, []);

  const fetchAll = useCallback(async () => {
    const dateStr = new Date().toISOString().split("T")[0];
    try {
      const [despData, redespData] = await Promise.all([
        fetchMetric("GeneProgDesp", dateStr),
        fetchMetric("GeneProgRedesp", dateStr),
      ]);

      const result = {};
      for (const [unitId, xmCode] of Object.entries(UNIT_XM_CODE)) {
        result[unitId] = {
          despacho: despData[xmCode] || null,
          redespacho: redespData[xmCode] || null,
        };
      }

      setDispatchData(result);
      setError(null);
      setLoading(false);
      despFetched.current = true;
      return result;
    } catch (e) {
      setError(e.message);
      setLoading(false);
      return null;
    }
  }, []);

  useEffect(() => {
    let currentData = null;
    let intervalId;

    // Fetch both on mount, then only redespacho on interval
    fetchAll().then(data => { // eslint-disable-line react-hooks/set-state-in-effect
      currentData = data;
      intervalId = setInterval(async () => {
        currentData = await fetchRedespacho(currentData);
      }, redespIntervalMs);
    });

    return () => { if (intervalId) clearInterval(intervalId); };
  }, [fetchAll, fetchRedespacho, redespIntervalMs]);

  return { dispatchData, loading, error };
}
