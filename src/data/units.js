import { C } from "../theme";

export const UNITS = [
  { id: "GEC3", name: "Gecelca 3", capacity: 164, color: C.blue },
  { id: "GEC32", name: "Gecelca 32", capacity: 270, color: C.darkGreen },
  { id: "TGJ1", name: "Guajira 1", capacity: 145, color: C.green },
  { id: "TGJ2", name: "Guajira 2", capacity: 130, color: C.cyan },
];

export function seedRng(s) { return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

export function genUnitData(unit, seed) {
  const r = seedRng(seed); const cap = unit.capacity; const rows = [];
  for (let p = 1; p <= 24; p++) {
    const base = cap * (0.55 + r() * 0.35);
    const despacho = Math.round(base * 10) / 10;
    const redespacho = Math.round((despacho + (r() - 0.5) * cap * 0.08) * 10) / 10;
    const final_ = Math.round(((despacho + redespacho) / 2 + (r() - 0.5) * cap * 0.04) * 10) / 10;
    rows.push({ periodo: p, despacho, redespacho, final: final_ });
  }
  return rows;
}

export const ALL_DATA = {};
UNITS.forEach((u, i) => { ALL_DATA[u.id] = genUnitData(u, 1000 + i * 777); });

