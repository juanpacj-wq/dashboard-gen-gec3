import { useEffect, useState } from "react";

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
  const res = await fetch(`/api/autorizaciones?planta_id=${encodeURIComponent(planta_id)}&fecha=${fecha}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.autorizaciones || [];
}

export function useAutorizaciones(intervalMs = POLL_MS) {
  const [autorizaciones, setAutorizaciones] = useState({});
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const fecha = todayBogota();
      try {
        const results = await Promise.all(
          PLANTAS.map(p => fetchPlanta(p, fecha).catch(e => {
            console.warn(`[autorizaciones] ${p}:`, e.message);
            return [];
          }))
        );
        if (cancelled) return;
        const map = {};
        for (const fila of results.flat()) {
          if (fila.activa) {
            map[`${fila.planta_id}_${fila.periodo}`] = fila;
          }
        }
        setAutorizaciones(map);
        setStatus("ok");
      } catch {
        if (!cancelled) setStatus("error");
      }
    };
    load();
    const t = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(t); };
  }, [intervalMs]);

  return { autorizaciones, status };
}
