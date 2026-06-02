export const FONT = "system-ui, -apple-system, sans-serif";
export const MONO = "ui-monospace, 'Cascadia Code', 'Courier New', monospace";

export const C = {
  bg: "#060b14", bg2: "#0a0f1a", card: "#0d1320", cardAlt: "#101827",
  border: "#162038", text: "#e4eaf4", textSec: "#8899b8", textMuted: "#7a9cca", textDark: "#6080a8",
  green: "#00d4aa", greenBright: "#00f5c8", greenDim: "rgba(0,212,170,0.12)", greenBorder: "rgba(0,212,170,0.25)",
  cyan: "#06b6d4", cyanBright: "#22d3ee", blue: "#3b82f6", blueBright: "#60a5fa",
  amber: "#f59e0b", amberDim: "rgba(245,158,11,0.12)", amberBorder: "rgba(245,158,11,0.28)",
  red: "#ef4444",
  darkGreen: "#2d8a4e", darkGreenBright: "#38a85c", darkGreenDim: "rgba(45,138,78,0.12)", darkGreenBorder: "rgba(45,138,78,0.25)",
};

// Tiñe la superficie `baseHex` con el color de acento de la planta, devolviendo un tono
// MUY oscuro de ese hue. Clave: blue/green/cyan son mucho más brillantes que el verde
// oscuro de GEC32, así que mezclarlos al mismo % subiría demasiado el brillo del fondo y
// estorbaría la lectura de la tabla/gráfica. Por eso primero NORMALIZAMOS la luminancia del
// acento a la de C.darkGreen (la referencia que se ve bien) — todos los hues quedan igual
// de oscuros — y recién ahí mezclamos `amount` (0..1) sobre la base. Args en hex #rrggbb.
export const tint = (baseHex, accentHex, amount) => {
  const REL = [0.299, 0.587, 0.114];
  const rgb = (hex) => { const c = parseInt(hex.slice(1), 16); return [(c >> 16) & 255, (c >> 8) & 255, c & 255]; };
  const lum = (a) => REL[0] * a[0] + REL[1] * a[1] + REL[2] * a[2];
  const base = rgb(baseHex), acc = rgb(accentHex);
  // Factor para igualar brillo al de GEC32. El exponente 1.5 oscurece MÁS a los hues más
  // brillantes (blue/green/cyan) sin tocar GEC32: su ratio es exactamente 1, y 1^1.5 = 1.
  const f = Math.min(1, (lum(rgb(C.darkGreen)) / (lum(acc) || 1)) ** 1.5);
  const m = (i) => Math.round(base[i] + (acc[i] * f - base[i]) * amount);
  return `rgb(${m(0)},${m(1)},${m(2)})`;
};
