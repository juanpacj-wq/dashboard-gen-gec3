import { useState, useEffect, useCallback } from "react";

const UNIT_IDS = ["GEC3", "GEC32", "TGJ1", "TGJ2"];

async function fetchDespScraper() {
  const res = await fetch('/api/despacho/today')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
  // Returns { GEC3: [24 MW], GEC32: [24 MW], TGJ1: [24 MW], TGJ2: [24 MW] }
}

async function fetchRedespScraper() {
  const res = await fetch('/api/redespacho/today')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

export function useXmDispatch(intervalMs = 300000) {
  const [dispatchData, setDispatchData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      const [despResult, redespResult] = await Promise.all([
        fetchDespScraper().catch(e => { console.warn("[XmDispatch] Despacho scraper no disponible:", e.message); return null; }),
        fetchRedespScraper().catch(e => { console.warn("[XmDispatch] Redespacho scraper no disponible:", e.message); return null; }),
      ]);
      const despData = despResult ?? {};
      const redespData = redespResult ?? {};

      const result = {};
      for (const unitId of UNIT_IDS) {
        result[unitId] = {
          despacho: despData[unitId] || null,
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
      return null;
    }
  }, []);

  useEffect(() => {
    fetchAll(); // eslint-disable-line react-hooks/set-state-in-effect
    const intervalId = setInterval(fetchAll, intervalMs);
    return () => clearInterval(intervalId);
  }, [fetchAll, intervalMs]);

  return { dispatchData, loading, error };
}
