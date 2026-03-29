import { useMemo } from "react";
import { C, MONO, FONT } from "../theme";
import { UNITS, ALL_DATA, calcStats } from "../data/units";
import { MiniGauge } from "./MiniGauge";

function UnitCard({ u, isSel, onSelect, height, realtimeUnit }) {
  const data = ALL_DATA[u.id];

  const avgD = useMemo(() => data.reduce((a, r) => a + r.redespacho, 0) / 24, [data]);
  const avgF = useMemo(() => data.reduce((a, r) => a + r.final, 0) / 24, [data]);

  const currentMW = realtimeUnit?.valueMW ?? avgF;
  const maxMW = realtimeUnit?.maxMW ?? u.capacity;

  const pctCap = useMemo(() => Math.min(100, Math.round((currentMW / maxMW) * 100)), [currentMW, maxMW]);
  const dev = useMemo(() => ((currentMW - avgD) / avgD) * 100, [currentMW, avgD]);

  const devs = useMemo(() => data.map(r => ((r.final - r.redespacho) / r.redespacho) * 100), [data]);
  const unitSt = useMemo(() => isSel ? calcStats(devs) : null, [isSel, devs]);

  return (
    <div onClick={() => onSelect(isSel ? null : u.id)} style={{
      flex: isSel ? "2.2 1 0" : "1 1 0",
      background: isSel ? `radial-gradient(ellipse at 50% 30%, ${u.color}0c 0%, ${C.card} 65%)` : C.card,
      border: `1px solid ${isSel ? u.color + "40" : C.border}`,
      borderRadius: 12, padding: isSel ? "10px 14px" : "10px 14px",
      cursor: "pointer", transition: "all 0.3s ease",
      display: "flex", alignItems: isSel ? "center" : "flex-start",
      gap: isSel ? 10 : 0, flexDirection: isSel ? "row" : "column",
      overflow: "hidden", minWidth: 0,
    }}>
      {isSel && <MiniGauge value={pctCap} max={100} color={u.color} size={Math.min(100, height * 0.95)} displayValue={currentMW} displayUnit="MW" />}
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: isSel ? 4 : 3 }}>
          <div style={{ width: isSel ? 9 : 7, height: isSel ? 9 : 7, borderRadius: "50%", background: u.color, boxShadow: `0 0 ${isSel ? 7 : 3}px ${u.color}60`, flexShrink: 0 }} />
          <span style={{ fontSize: isSel ? 14 : 12, fontWeight: 800, color: isSel ? u.color : C.text, fontFamily: MONO, letterSpacing: 1 }}>{u.id}</span>
          {isSel && <span style={{ marginLeft: "auto", fontSize: 11, color: C.green, background: C.greenDim, border: `1px solid ${C.greenBorder}`, borderRadius: 5, padding: "1px 6px", fontFamily: MONO, fontWeight: 700, whiteSpace: "nowrap" }}>SELECCIONADA</span>}
        </div>
        <div style={{ fontSize: 12, color: C.textMuted, fontFamily: FONT, marginBottom: isSel ? 6 : 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Capacidad Instalada - {u.capacity} MW</div>
        {isSel ? (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {[
              { l: "Capacidad", v: pctCap + "%", c: C.text },
              { l: "Desv.", v: (dev >= 0 ? "+" : "") + dev.toFixed(2) + "%", c: Math.abs(dev) > 2 ? C.red : C.green },
              { l: "Media", v: unitSt.mean.toFixed(2) + "%", c: C.text },
              { l: "Std Dev", v: unitSt.std.toFixed(2) + "%", c: u.color },
            ].map((x, i) => (
              <div key={i}>
                <div style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO, letterSpacing: 0.5 }}>{x.l}</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: x.c, fontFamily: MONO }}>{x.v}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: u.color, fontFamily: MONO }}>{currentMW.toFixed(0)}</span>
            <span style={{ fontSize: 12, color: C.textMuted, fontFamily: MONO }}>MW</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: Math.abs(dev) > 2 ? C.red : C.green, fontFamily: MONO, marginLeft: "auto" }}>{dev >= 0 ? "+" : ""}{dev.toFixed(1)}%</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function UnitCards({ selected, onSelect, height, realtimeUnits = [] }) {
  return (
    <div style={{ display: "flex", gap: 8, height }}>
      {UNITS.map(u => (
        <UnitCard
          key={u.id}
          u={u}
          isSel={selected === u.id}
          onSelect={onSelect}
          height={height}
          realtimeUnit={realtimeUnits.find(r => r.id === u.id) ?? null}
        />
      ))}
    </div>
  );
}
