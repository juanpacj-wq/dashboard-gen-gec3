import { useMemo } from "react";
import { C, MONO, FONT } from "../theme";
import { UNITS, //ALL_DATA, calcStats

} from "../data/units";
import { MiniGauge } from "./MiniGauge";

function UnitCard({ u, isSel, onSelect, height, realtimeUnit, pmeAccumulated, projection, xmDispatch }) {
  // Generación actual (PME acumulado del periodo actual)
  const pmeGen = Math.max(0, pmeAccumulated?.[u.id] ?? 0);
  const currentMW = realtimeUnit?.valueMW != null ? Math.max(0, realtimeUnit.valueMW) : pmeGen;
  const maxMW = realtimeUnit?.maxMW ?? u.capacity;

  // capacidad %
  const pctCap = useMemo(
  () => Math.min(100, Math.max(0, Math.round((currentMW / maxMW) * 100))),
  [currentMW, maxMW]
  );

  // Desviación: lógica VB6 (proyección a fin de hora vs redespacho), calculada en el backend.
  // Recalculamos con la proyección clamped a >=0 para evitar desviaciones espurias por
  // picos negativos del PME (consistente con la generación que también se clampa a 0).
  const currentIdx = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" })).getHours();
  const redespacho = xmDispatch?.[u.id]?.redespacho?.[currentIdx];
  const rawProj = projection?.[u.id]?.projection;
  let dev = projection?.[u.id]?.deviation ?? 0;
  if (rawProj != null && redespacho != null && redespacho > 0) {
    const clampedProj = Math.max(0, rawProj);
    dev = ((clampedProj - redespacho) / redespacho) * 100;
  }

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
          <span style={{ fontSize: isSel ? 24 : 16, fontWeight: 800, color: isSel ? u.color : C.text, fontFamily: MONO, letterSpacing: 1 }}>{u.id}</span>
          {isSel && <span style={{ marginLeft: "auto", fontSize: 11, color: C.green, background: C.greenDim, border: `1px solid ${C.greenBorder}`, borderRadius: 5, padding: "1px 6px", fontFamily: MONO, fontWeight: 700, whiteSpace: "nowrap" }}>SELECCIONADA</span>}
        </div>
        <div style={{ fontSize: 12, color: C.textMuted, fontFamily: FONT, marginBottom: isSel ? 6 : 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{isSel ? "Capacidad Instalada" : "CAPAIns"} - {u.capacity} MW</div>
        {isSel ? (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {[
              { l: "Capacidad", v: pctCap + "%", c: C.text },
              { l: "Desviación", v: (dev >= 0 ? "+" : "") + dev.toFixed(2) + "%", c: Math.abs(dev) > 2 ? C.red : C.green },
              //{ l: "Media", v: unitSt.mean.toFixed(2) + "%", c: C.text },
              //{ l: "Std Dev", v: unitSt.std.toFixed(2) + "%", c: u.color },
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

export function UnitCards({ selected, onSelect, height, realtimeUnits = [], pmeAccumulated, projection, xmDispatch }) {
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
          pmeAccumulated={pmeAccumulated}
          projection={projection}
          xmDispatch={xmDispatch}
        />
      ))}
    </div>
  );
}
