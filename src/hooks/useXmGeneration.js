import { useState, useEffect, useCallback } from "react";
import { PLANT_NAME_MAP } from "../data/plantNames";
import { seedRng } from "../data/units";

export function useXmGeneration(intervalMs = 300000) {
  const [plants, setPlants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [isSimulated, setIsSimulated] = useState(false);

  const fetchData = useCallback(async () => {
    const today = new Date();
    const dateStr = today.toISOString().split("T")[0];
    const hourKey = `Hour${String(today.getHours() + 1).padStart(2, "0")}`;

    try {
      const res = await fetch("/api/xm/hourly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          MetricId: "GeneProgDesp",
          StartDate: dateStr,
          EndDate: dateStr,
          Entity: "Recurso",
          Filter: [],
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      const records = json?.Items || [];
      if (records.length === 0) throw new Error("Sin datos para hoy");

      const all = records.map(item => {
        const vals = item.HourlyEntities[0].Values;
        const code = vals.code?.trim() || "";
        const name = PLANT_NAME_MAP[code] || code;
        const raw = vals[hourKey] ?? "";
        const gen = raw !== "" ? Math.round(parseFloat(raw) / 1000 * 10) / 10 : 0;
        return { code, name, gen };
      });

      const top10 = all
        .sort((a, b) => b.gen - a.gen)
        .slice(0, 10);

      const maxGen = top10[0]?.gen || 1;
      const mapped = top10.map(p => ({ ...p, pct: Math.round((p.gen / maxGen) * 100) }));

      setPlants(mapped);
      setLastUpdate(new Date());
      setIsSimulated(false);
      setLoading(false);
    } catch {
      const rng = seedRng(today.getHours() * 1000 + today.getMinutes());
      const fallbackCodes = Object.keys(PLANT_NAME_MAP).slice(0, 10);
      const simulated = fallbackCodes.map(code => {
        const gen = Math.round((200 + rng() * 1000) * 10) / 10;
        return { code, name: PLANT_NAME_MAP[code], gen, pct: 0 };
      });
      const maxGen = simulated[0]?.gen || 1;
      simulated.forEach(p => { p.pct = Math.round((p.gen / maxGen) * 100); });
      setPlants(simulated);
      setLastUpdate(new Date());
      setIsSimulated(true);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, intervalMs);
    return () => clearInterval(id);
  }, [fetchData, intervalMs]);

  return { plants, loading, lastUpdate, isSimulated };
}
