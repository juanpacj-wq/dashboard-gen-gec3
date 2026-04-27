import { useEffect, useState } from "react";

// F8: agrupa eventos del bitácora-server por (unidad, periodo, tipo). Reemplaza al
// useAutorizaciones (que solo conocía AUTH) — ahora soporta AUTH/REDESP/PRUEBA simultáneos
// para una misma celda (UNIQUE en evento_dashboard permite la coexistencia, F5).
//
// Catch silencioso: si bitácora está caído, el dashboard sigue funcionando sin emojis;
// nunca debe crashear por esto.

const PLANTAS = ["GEC3", "GEC32"];
const POLL_MS = 60_000;

function todayBogota() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function fetchPlanta(planta_id, fecha) {
  const res = await fetch(`/api/eventos-dashboard?planta_id=${encodeURIComponent(planta_id)}&fecha=${fecha}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.eventos || [];
}

export function useEventosBitacora(intervalMs = POLL_MS) {
  // Shape: { [planta_id]: { [periodo]: { AUTH?: row, REDESP?: row, PRUEBA?: row } } }
  const [eventos, setEventos] = useState({});
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const fecha = todayBogota();
      try {
        const results = await Promise.all(
          PLANTAS.map((p) => fetchPlanta(p, fecha).catch((e) => {
            console.warn(`[eventos-bitacora] ${p}:`, e.message);
            return [];
          }))
        );
        if (cancelled) return;
        const map = {};
        for (const fila of results.flat()) {
          if (!fila.activa) continue;
          const planta = fila.planta_id;
          const periodo = fila.periodo;
          const tipo = fila.tipo;
          if (!planta || !periodo || !tipo) continue;
          if (!map[planta]) map[planta] = {};
          if (!map[planta][periodo]) map[planta][periodo] = {};
          map[planta][periodo][tipo] = fila;
        }
        setEventos(map);
        setStatus("ok");
      } catch {
        if (!cancelled) setStatus("error");
      }
    };
    load();
    const t = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(t); };
  }, [intervalMs]);

  return { eventos, status };
}
