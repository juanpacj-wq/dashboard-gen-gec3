import { useState, useEffect, useRef } from "react";
import { C, FONT, MONO } from "../theme";
import { useXmGeneration } from "../hooks/useXmGeneration";

export function GenerationTicker({ height }) {
  const { plants, loading, lastUpdate, isSimulated } = useXmGeneration();
  const scrollRef = useRef(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!scrollRef.current || paused) return;
    let animId;
    let pos = 0;
    const speed = 0.5;
    const el = scrollRef.current;
    const tick = () => {
      pos += speed;
      if (pos >= el.scrollWidth / 2) pos = 0;
      el.scrollLeft = pos;
      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [plants, paused]);

  if (loading) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", background: C.bg2, borderRadius: 10, border: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 13, color: C.textMuted, fontFamily: MONO }}>Cargando generacion nacional...</span>
      </div>
    );
  }

  const totalGen = plants.reduce((s, p) => s + p.gen, 0);
  const items = [...plants, ...plants];

  return (
    <div style={{ height, display: "flex", alignItems: "center", gap: 8, background: C.bg2, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden", position: "relative" }}>
      {/* Left label */}
      <div style={{ flexShrink: 0, padding: "0 12px", borderRight: `1px solid ${C.border}`, height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", background: `linear-gradient(135deg, ${C.bg2}, ${C.card})`, zIndex: 2, minWidth: 110 }}>
        <div style={{ fontSize: 10, color: C.textMuted, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase" }}>Top 10 Despacho</div>
        <div style={{ fontSize: 17, fontWeight: 900, color: C.green, fontFamily: MONO }}>{totalGen.toFixed(0)} MW</div>
        <div style={{ fontSize: 9, color: C.textDark, fontFamily: MONO }}>{lastUpdate ? lastUpdate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""}</div>
        {isSimulated && (
          <div style={{ fontSize: 9, color: C.amber, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 4, padding: "1px 5px", marginTop: 2, fontFamily: MONO, letterSpacing: 0.5, whiteSpace: "nowrap" }}>
            SIMULADO
          </div>
        )}
      </div>

      {/* Scrolling area */}
      <div
        ref={scrollRef}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        style={{ flex: 1, overflow: "hidden", display: "flex", alignItems: "center", whiteSpace: "nowrap", gap: 0 }}
      >
        {items.map((p, i) => {
          const col = C.cyan;
          const pctBar = Math.min(100, Math.max(0, p.pct));
          return (
            <div key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "4px 16px 4px 12px", borderRight: `1px solid ${C.border}22`, flexShrink: 0, cursor: "default" }}>
              <span style={{ fontSize: 15 }}>⚡</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: col, fontFamily: MONO, letterSpacing: 0.5 }}>{p.code}</span>
                  <span style={{ fontSize: 11, color: C.textMuted, fontFamily: FONT }}>{p.name}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 14, fontWeight: 900, color: C.text, fontFamily: MONO }}>{p.gen.toFixed(0)}</span>
                  <span style={{ fontSize: 10, color: C.textMuted, fontFamily: MONO }}>MW</span>
                  <div style={{ width: 40, height: 4, background: "rgba(255,255,255,0.05)", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ width: pctBar + "%", height: "100%", background: `linear-gradient(90deg, ${col}, ${col}aa)`, borderRadius: 2, transition: "width 1s ease" }} />
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: pctBar > 80 ? C.green : pctBar > 40 ? col : C.textMuted, fontFamily: MONO }}>{p.pct}%</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Right fade */}
      <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 40, background: `linear-gradient(90deg, transparent, ${C.bg2})`, pointerEvents: "none", zIndex: 1 }} />
    </div>
  );
}
