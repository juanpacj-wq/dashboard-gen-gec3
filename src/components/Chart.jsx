import { useState, useMemo } from "react";
import { C, FONT, MONO } from "../theme";
import { UNITS, ALL_DATA } from "../data/units";

export function Chart({ unitId, width, height, minuteAvgs, xmDispatch }) {
  const [tip, setTip] = useState(null);

  const unit = UNITS.find(u => u.id === unitId);
  const currentIdx = new Date().getHours();

  const baseRow = ALL_DATA[unitId]?.[currentIdx];
  const xmUnit = xmDispatch?.[unitId];
  const xmRedesp = xmUnit?.redespacho?.[currentIdx];
  const redespacho = (xmRedesp != null) ? xmRedesp : (baseRow?.redespacho ?? 0);

  const chartData = useMemo(() => {
    const raw = minuteAvgs?.[unitId] || [];
    const pts = [];
    for (let m = 0; m < 60; m++) {
      if (raw[m] != null) {
        const rawVal = raw[m];
        const y = Math.max(0, rawVal);
        pts.push({ x: m, y });
      }
    }
    return pts;
  }, [minuteAvgs, unitId]);

  // Límites de control (Críticos ±5%)
  const ucl = redespacho * 1.05;
  const lcl = redespacho * 0.95;
  
  // Límites de advertencia (Warning ±2.5%) - AHORA SE USAN ABAJO
  const uwl = redespacho * 1.025;
  const lwl = redespacho * 0.975;

  const margin = redespacho === 0 ? 10 : redespacho * 0.03;
  const allY = chartData.map(d => d.y);
  
  let yMin = Math.min(lcl - margin, ...allY.length ? allY : [lcl]);
  if (redespacho === 0) yMin = 0; 
  
  const yMax = Math.max(ucl + margin, ...allY.length ? allY : [ucl]);

  const pad = { t: 22, r: 30, b: 28, l: 50 };
  const W = width, H = height;
  const pW = W - pad.l - pad.r, pH = H - pad.t - pad.b;
  
  const tX = m => pad.l + (m / 59) * pW;
  const tY = v => {
    const diff = yMax - yMin;
    const safeDiff = diff <= 0 ? 1 : diff;
    return pad.t + ((yMax - v) / safeDiff) * pH;
  };

  const lp = chartData.map((d, i) => `${i === 0 ? "M" : "L"}${tX(d.x).toFixed(1)},${tY(d.y).toFixed(1)}`).join(" ");

  const yTicks = [];
  const yRange = yMax - yMin;
  const rawStep = (yRange <= 0 ? 10 : yRange) / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
  const nice = [1, 2, 2.5, 5, 10].find(n => n * mag >= rawStep) * mag;
  const yStep = Math.max(0.1, nice);
  for (let v = Math.floor(yMin / yStep) * yStep; v <= yMax + yStep * 0.1; v += yStep) {
    yTicks.push(Math.round(v * 100) / 100);
  }

  const xTicks = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

  const handleMove = e => {
    if (!chartData.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let cl = null, md = 20;
    chartData.forEach(d => { const dist = Math.abs(tX(d.x) - mx); if (dist < md) { md = dist; cl = d; } });
    if (cl) {
      const dev = redespacho !== 0 ? ((cl.y - redespacho) / redespacho) * 100 : (cl.y > 0 ? 100 : 0);
      const s = cl.y > ucl ? "hi" : cl.y < lcl ? "lo" : "ok";
      setTip({ x: tX(cl.x), y: tY(cl.y), mw: cl.y, min: cl.x, dev, s });
    } else setTip(null);
  };

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "8px 10px 6px", height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, paddingLeft: 4, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: unit.color, boxShadow: `0 0 5px ${unit.color}60` }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: C.text, fontFamily: FONT }}>Gen {unitId} </span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {[{ c: unit.color, l: "MW", d: false }, { c: C.text, l: `Redespacho`, d: true }, { c: C.red, l: "±5%", d: true }].map((x, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 12, height: 2, background: x.d ? "transparent" : x.c, borderTop: x.d ? `1.5px dashed ${x.c}` : "none" }} />
              <span style={{ fontSize: 12, color: C.textMuted, fontFamily: FONT }}>{x.l}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block", cursor: "crosshair" }} onMouseMove={handleMove} onMouseLeave={() => setTip(null)}>
          <defs>
            <filter id="cgl"><feGaussianBlur stdDeviation="2.5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            <linearGradient id="dzT" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.red} stopOpacity="0.05" /><stop offset="100%" stopColor={C.red} stopOpacity="0.01" /></linearGradient>
            <linearGradient id="dzB" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.cyan} stopOpacity="0.01" /><stop offset="100%" stopColor={C.cyan} stopOpacity="0.05" /></linearGradient>
          </defs>
          
          <rect x={pad.l} y={pad.t} width={pW} height={Math.max(0, tY(ucl) - pad.t)} fill="url(#dzT)" rx={2} />
          <rect x={pad.l} y={tY(lcl)} width={pW} height={Math.max(0, (pad.t + pH) - tY(lcl))} fill="url(#dzB)" rx={2} />

          {yTicks.map(v => <line key={v} x1={pad.l} x2={W - pad.r} y1={tY(v)} y2={tY(v)} stroke="rgba(255,255,255,0.03)" vectorEffect="non-scaling-stroke" />)}
          {xTicks.map(m => <line key={"v" + m} x1={tX(m)} x2={tX(m)} y1={pad.t} y2={H - pad.b} stroke="rgba(255,255,255,0.03)" vectorEffect="non-scaling-stroke" />)}
          
          {/* Líneas Críticas (±5%) */}
          <line x1={pad.l} x2={W - pad.r} y1={tY(ucl)} y2={tY(ucl)} stroke={C.red} strokeWidth={1.2} strokeDasharray="6 4" opacity={0.9} vectorEffect="non-scaling-stroke" />
          <line x1={pad.l} x2={W - pad.r} y1={tY(lcl)} y2={tY(lcl)} stroke={C.red} strokeWidth={1.2} strokeDasharray="6 4" opacity={0.9} vectorEffect="non-scaling-stroke" />
          
          {/* Líneas de Advertencia (±2.5%) - USO DE VARIABLES PARA QUITAR ERROR */}
          <line x1={pad.l} x2={W - pad.r} y1={tY(uwl)} y2={tY(uwl)} stroke={C.amber} strokeWidth={0.8} strokeDasharray="2 4" opacity={0.3} vectorEffect="non-scaling-stroke" />
          <line x1={pad.l} x2={W - pad.r} y1={tY(lwl)} y2={tY(lwl)} stroke={C.amber} strokeWidth={0.8} strokeDasharray="2 4" opacity={0.3} vectorEffect="non-scaling-stroke" />

          <line x1={pad.l} x2={W - pad.r} y1={tY(redespacho)} y2={tY(redespacho)} stroke={C.text} strokeWidth={1} strokeDasharray="4 3" opacity={0.6} vectorEffect="non-scaling-stroke" />

          <text x={W - pad.r + 3} y={tY(ucl) + 3} fill={C.red} fontSize={14} fontFamily={MONO} opacity={0.9}>+5%</text>
          <text x={W - pad.r + 3} y={tY(lcl) + 3} fill={C.red} fontSize={14} fontFamily={MONO} opacity={0.9}>-5%</text>

          {chartData.length > 1 && <path d={lp} fill="none" stroke={unit.color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
          
          {chartData.map((d, i) => {
            const out = d.y > ucl || d.y < lcl; const col = out ? C.red : unit.color;
            return <g key={i}>{out && <circle cx={tX(d.x)} cy={tY(d.y)} r={6} fill={C.red} opacity={0.08} vectorEffect="non-scaling-stroke"><animate attributeName="r" values="4;9;4" dur="2s" repeatCount="indefinite" /></circle>}<circle cx={tX(d.x)} cy={tY(d.y)} r={out ? 3 : 2.2} fill={C.card} stroke={col} strokeWidth={1.5} vectorEffect="non-scaling-stroke" /></g>;
          })}

          {yTicks.map(v => <text key={"yl" + v} x={pad.l - 5} y={tY(v) + 3} fill={C.textMuted} fontSize={14} fontFamily={MONO} textAnchor="end">{v.toFixed(1)}</text>)}
          {xTicks.map(m => <text key={"xl" + m} x={tX(m)} y={H - pad.b + 12} fill={C.textMuted} fontSize={14} fontFamily={MONO} textAnchor="middle">{m}</text>)}

          {chartData.length === 0 && <text x={pad.l + pW / 2} y={pad.t + pH / 2} fill={C.textMuted} fontSize={12} fontFamily={FONT} textAnchor="middle">Esperando datos PME...</text>}

          {tip && <g>
            <line x1={tip.x} x2={tip.x} y1={pad.t} y2={H - pad.b} stroke={C.textMuted} strokeWidth={0.8} strokeDasharray="2 2" opacity={0.3} vectorEffect="non-scaling-stroke" />
            <circle cx={tip.x} cy={tip.y} r={4} fill={C.card} stroke={tip.s !== "ok" ? C.red : unit.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
            <g transform={`translate(${tip.x < W / 2 ? tip.x + 8 : tip.x - 100},${Math.max(pad.t, tip.y - 34)})`}>
              <rect width={92} height={30} rx={5} fill={C.cardAlt} stroke={C.border} strokeWidth={1} />
              <text x={6} y={11} fill={C.textMuted} fontSize={20} fontFamily={MONO}>Min {tip.min}</text>
              <text x={6} y={24} fill={tip.s !== "ok" ? C.red : unit.color} fontSize={18} fontWeight={700} fontFamily={MONO}>{tip.mw.toFixed(1)} MW ({tip.dev >= 0 ? "+" : ""}{tip.dev.toFixed(2)}%)</text>
            </g>
          </g>}
        </svg>
      </div>
    </div>
  );
}