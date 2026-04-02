import { useState, useEffect, useCallback } from "react";
import { PLANT_NAME_MAP } from "../data/plantNames";
import { seedRng } from "../data/units";

// Colombia is UTC-5, always (no DST)
function colombiaHour() {
  const col = new Date(new Date().getTime() - 5 * 3600000);
  return col.getUTCHours();
}

export function useXmGeneration(intervalMs = 300000) {
  const [plants, setPlants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [isSimulated, setIsSimulated] = useState(false);

  const fetchData = useCallback(async () => {
    const colHour = colombiaHour();

    try {
      const res = await fetch("/api/redespacho/national");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const allPlants = await res.json();

      if (!allPlants || allPlants.length === 0) throw new Error("Sin datos nacionales");

      const all = allPlants.map(p => {
        const gen = p.values?.[colHour] ?? 0;
        // Use the full name from the rDEC file directly
        const name = p.name || PLANT_NAME_MAP[p.code] || p.code;
        return { code: p.code, name, gen };
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
      const rng = seedRng(colHour * 1000 + new Date().getMinutes());
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
