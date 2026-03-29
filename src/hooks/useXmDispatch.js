import { useState, useEffect, useCallback, useRef } from "react";

// Map internal unit IDs to XM codes.
// GEC3 is split into sub-units in XM (5G3O, 5G3S, etc.) — we sum them.
const UNIT_XM_MAP = {
  GEC3:  { codes: ["5G3O", "5G3S", "5G3T", "5G3U"], aggregate: "sum" },
  GEC32: { codes: ["GE32"] },
  TGJ1:  { codes: ["TGJ1"] },
  TGJ2:  { codes: ["TGJ2"] },
};

const ALL_XM_CODES = Object.values(UNIT_XM_MAP).flatMap(m => m.codes);
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

  // Parse all relevant XM codes into arrays of MW values
  const byCode = {};
  for (const item of records) {
    const vals = item.HourlyEntities?.[0]?.Values;
    if (!vals) continue;
    const code = (vals.code || "").trim();
    if (!ALL_XM_CODES.includes(code)) continue;
    byCode[code] = HOUR_KEYS.map(k => {
      const raw = vals[k];
      if (raw == null || raw === "") return 0;
      return parseFloat(raw) / 1000;
    });
  }

  // Aggregate into internal unit IDs (sum sub-units for GEC3)
  const byUnit = {};
  for (const [unitId, mapping] of Object.entries(UNIT_XM_MAP)) {
    const arrays = mapping.codes.map(c => byCode[c]).filter(Boolean);
    if (arrays.length === 0) continue;
    byUnit[unitId] = HOUR_KEYS.map((_, i) => {
      const sum = arrays.reduce((acc, arr) => acc + (arr[i] || 0), 0);
      return Math.round(sum * 10) / 10;
    });
  }
  return byUnit;
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
      for (const unitId of Object.keys(UNIT_XM_MAP)) {
        result[unitId] = {
          despacho: prevData?.[unitId]?.despacho || null,
          redespacho: redespData[unitId] || null,
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
      for (const unitId of Object.keys(UNIT_XM_MAP)) {
        result[unitId] = {
          despacho: despData[unitId] || null,
          redespacho: redespData[unitId] || null,
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
