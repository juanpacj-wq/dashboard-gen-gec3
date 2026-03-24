import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import plantNamesRaw from "../Nombre unidades y su código.json";

const FONT = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, 'Cascadia Code', 'Courier New', monospace";

const C = {
  bg: "#060b14", bg2: "#0a0f1a", card: "#0d1320", cardAlt: "#101827",
  border: "#162038", text: "#e4eaf4", textSec: "#8899b8", textMuted: "#4a5d80", textDark: "#2d3f5e",
  green: "#00d4aa", greenBright: "#00f5c8", greenDim: "rgba(0,212,170,0.12)", greenBorder: "rgba(0,212,170,0.25)",
  cyan: "#06b6d4", cyanBright: "#22d3ee", blue: "#3b82f6", blueBright: "#60a5fa",
  amber: "#f59e0b", red: "#ef4444",
  darkGreen: "#2d8a4e", darkGreenBright: "#38a85c", darkGreenDim: "rgba(45,138,78,0.12)", darkGreenBorder: "rgba(45,138,78,0.25)",
};

const UNITS = [
  { id: "GEC3", name: "Gen ", capacity: 95, color: C.blue },
  { id: "GEC32", name: "Gen ", capacity: 88, color: C.darkGreen },
  { id: "TGJ1", name: "Gen ", capacity: 150, color: C.green },
  { id: "TGJ2", name: "Gen ", capacity: 148, color: C.cyan },
];

function seedRng(s) { return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

function genUnitData(unit, seed) {
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

const ALL_DATA = {}; UNITS.forEach((u, i) => { ALL_DATA[u.id] = genUnitData(u, 1000 + i * 777); });

function calcStats(vals) {
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const s = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
  return { mean: +(m.toFixed(2)), ucl: 5, lcl: -5, uwl: +((m + 2 * s).toFixed(2)), lwl: +((m - 2 * s).toFixed(2)), std: +(s.toFixed(2)) };
}

/* ═══ Plant name lookup from DB export ═══ */
const _plantNamesArr = plantNamesRaw[Object.keys(plantNamesRaw)[0]] || [];
const PLANT_NAME_MAP = Object.fromEntries(
  _plantNamesArr
    .filter(e => e.codsic_planta != null && e.recurso_ofei != null)
    .map(e => [e.codsic_planta.trim(), e.recurso_ofei.trim()])
);

function useXmGeneration(intervalMs = 300000) {
  const [plants, setPlants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [isSimulated, setIsSimulated] = useState(false);

  const fetchData = useCallback(async () => {
    const today = new Date();
    const dateStr = today.toISOString().split("T")[0];
    // XM usa Hour01–Hour24; getHours() es 0-23, Hour01 = periodo 1 (00:00-01:00)
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
          Filter: [], // Sin filtro: traer todas las centrales
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      const records = json?.Items || [];
      if (records.length === 0) throw new Error("Sin datos para hoy");

      // Mapear cada registro a { code, name, gen } y ordenar por despacho descendente
      const all = records.map(item => {
        const vals = item.HourlyEntities[0].Values;
        const code = vals.code?.trim() || "";
        const name = PLANT_NAME_MAP[code] || code;
        const raw = vals[hourKey] ?? "";
        // kWh → MW
        const gen = raw !== "" ? Math.round(parseFloat(raw) / 1000 * 10) / 10 : 0;
        return { code, name, gen };
      });

      // Top 10 por mayor despacho en la hora actual
      const top10 = all
        .sort((a, b) => b.gen - a.gen)
        .slice(0, 10);

      // pct relativo al mayor del top 10
      const maxGen = top10[0]?.gen || 1;
      const mapped = top10.map(p => ({ ...p, pct: Math.round((p.gen / maxGen) * 100) }));

      setPlants(mapped);
      setLastUpdate(new Date());
      setIsSimulated(false);
      setLoading(false);
    } catch {
      // Fallback simulado usando los primeros nombres del mapa
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

/* ═══ Generation Ticker ═══ */
function GenerationTicker({ height }) {
  const { plants, loading, lastUpdate, isSimulated } = useXmGeneration();
  const scrollRef = useRef(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!scrollRef.current || paused) return;
    let animId;
    let pos = 0;
    const speed = 0.5; // px per frame
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
        <span style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO }}>Cargando generacion nacional...</span>
      </div>
    );
  }

  const totalGen = plants.reduce((s, p) => s + p.gen, 0);
  const items = [...plants, ...plants]; // duplicate for seamless loop

  return (
    <div style={{ height, display: "flex", alignItems: "center", gap: 8, background: C.bg2, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden", position: "relative" }}>
      {/* Left label */}
      <div style={{ flexShrink: 0, padding: "0 12px", borderRight: `1px solid ${C.border}`, height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", background: `linear-gradient(135deg, ${C.bg2}, ${C.card})`, zIndex: 2, minWidth: 110 }}>
        <div style={{ fontSize: 8, color: C.textMuted, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase" }}>Top 10 Despacho</div>
        <div style={{ fontSize: 15, fontWeight: 900, color: C.green, fontFamily: MONO }}>{totalGen.toFixed(0)} MW</div>
        <div style={{ fontSize: 7, color: C.textDark, fontFamily: MONO }}>{lastUpdate ? lastUpdate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""}</div>
        {isSimulated && (
          <div style={{ fontSize: 7, color: C.amber, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 4, padding: "1px 5px", marginTop: 2, fontFamily: MONO, letterSpacing: 0.5, whiteSpace: "nowrap" }}>
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
              <span style={{ fontSize: 13 }}>⚡</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: col, fontFamily: MONO, letterSpacing: 0.5 }}>{p.code}</span>
                  <span style={{ fontSize: 9, color: C.textMuted, fontFamily: FONT }}>{p.name}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 900, color: C.text, fontFamily: MONO }}>{p.gen.toFixed(0)}</span>
                  <span style={{ fontSize: 8, color: C.textMuted, fontFamily: MONO }}>MW</span>
                  <div style={{ width: 40, height: 4, background: "rgba(255,255,255,0.05)", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ width: pctBar + "%", height: "100%", background: `linear-gradient(90deg, ${col}, ${col}aa)`, borderRadius: 2, transition: "width 1s ease" }} />
                  </div>
                  <span style={{ fontSize: 9, fontWeight: 700, color: pctBar > 80 ? C.green : pctBar > 40 ? col : C.textMuted, fontFamily: MONO }}>{p.pct}%</span>
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

/* ═══ Mini Gauge ═══ */
function MiniGauge({ value, max, color, size }) {
  const [anim, setAnim] = useState(0);
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  useEffect(() => {
    let s = null; const dur = 1200;
    const t = ts => { if (!s) s = ts; const p = Math.min(1, (ts - s) / dur); const e = p < 0.5 ? 4*p*p*p : 1-Math.pow(-2*p+2,3)/2; setAnim(e * pct); if (p < 1) requestAnimationFrame(t); };
    requestAnimationFrame(t);
  }, [pct]);

  const cx = size/2, cy = size/2, sa = 135, sw = 270, rO = size*0.46, rM = size*0.38;
  const segs = 32, gap = 2.5, segSw = (sw - segs*gap)/segs, filled = Math.round((anim/100)*segs), fDeg = (anim/100)*sw;
  const c2 = color === C.green ? C.greenBright : color === C.cyan ? C.cyanBright : color === C.blue ? C.blueBright : "#fbbf24";
  const pol = (r, d) => { const rd = d*Math.PI/180; return [cx+r*Math.cos(rd), cy+r*Math.sin(rd)]; };
  const arc = (r, s, w) => { const [sx,sy]=pol(r,s),[ex,ey]=pol(r,s+w); return `M${sx},${sy} A${r},${r} 0 ${w>180?1:0} 1 ${ex},${ey}`; };
  const endP = fDeg > 1 ? pol(rM, sa+fDeg) : null;
  const uid = "mg" + size + color.slice(1,4);

  return (
    <svg width={size} height={size*0.72} viewBox={`0 0 ${size} ${size*0.78}`} style={{overflow:"visible",flexShrink:0}}>
      <defs>
        <filter id={`${uid}g`}><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <linearGradient id={`${uid}l`} x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor={color}/><stop offset="100%" stopColor={c2}/></linearGradient>
        <radialGradient id={`${uid}r`} cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor={color} stopOpacity="0.2"/><stop offset="55%" stopColor={color} stopOpacity="0.03"/><stop offset="100%" stopColor="transparent"/></radialGradient>
        <radialGradient id={`${uid}b`} cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor={color} stopOpacity="0.07"/><stop offset="70%" stopColor={C.card} stopOpacity="0.95"/><stop offset="100%" stopColor={C.card}/></radialGradient>
      </defs>
      {Array.from({length:segs}).map((_,i)=>{
        const a=sa+i*(segSw+gap),iF=i<filled,th=size*0.05,iR=rO-th;
        const [a1,b1]=pol(rO,a),[a2,b2]=pol(rO,a+segSw),[a3,b3]=pol(iR,a+segSw),[a4,b4]=pol(iR,a);
        return <path key={i} d={`M${a1},${b1} A${rO},${rO} 0 0 1 ${a2},${b2} L${a3},${b3} A${iR},${iR} 0 0 0 ${a4},${b4} Z`} fill={iF?`url(#${uid}l)`:"rgba(255,255,255,0.03)"} opacity={iF?0.45+0.55*(i/Math.max(1,filled)):0.25}/>;
      })}
      <path d={arc(rM,sa,sw)} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={size*0.02} strokeLinecap="round"/>
      {fDeg>0.5&&<path d={arc(rM,sa,fDeg)} fill="none" stroke={`url(#${uid}l)`} strokeWidth={size*0.022} strokeLinecap="round" filter={`url(#${uid}g)`}/>}
      {endP&&<><circle cx={endP[0]} cy={endP[1]} r={size*0.03} fill={color} opacity={0.3} filter={`url(#${uid}g)`}/><circle cx={endP[0]} cy={endP[1]} r={size*0.01} fill="#fff"/></>}
      <circle cx={cx} cy={cy} r={size*0.2} fill={`url(#${uid}r)`}/><circle cx={cx} cy={cy} r={size*0.16} fill={`url(#${uid}b)`}/><circle cx={cx} cy={cy} r={size*0.16} fill="none" stroke={`${color}15`} strokeWidth={1}/>
      <text x={cx} y={cy-1} textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize={size*0.19} fontWeight="800" fontFamily={FONT}>{Math.round(anim)}</text>
      <text x={cx} y={cy+size*0.09} textAnchor="middle" dominantBaseline="central" fill={C.textMuted} fontSize={size*0.06} fontFamily={MONO}>%CAP</text>
    </svg>
  );
}

/* ═══ Unit Cards ═══ */
function UnitCards({ selected, onSelect, height }) {
  return (
    <div style={{display:"flex",gap:8,height}}>
      {UNITS.map(u => {
        const isSel = selected === u.id;
        const data = ALL_DATA[u.id];
        const avgF = data.reduce((a,r)=>a+r.final,0)/24;
        const avgD = data.reduce((a,r)=>a+r.despacho,0)/24;
        const dev = ((avgF-avgD)/avgD)*100;
        const pctCap = Math.round((avgF/u.capacity)*100);
        const devs = data.map(r=>((r.final-r.despacho)/r.despacho)*100);
        const unitSt = isSel ? calcStats(devs) : null;

        return (
          <div key={u.id} onClick={()=>onSelect(isSel?null:u.id)} style={{
            flex: isSel ? "2.2 1 0" : "1 1 0",
            background: isSel ? `radial-gradient(ellipse at 50% 30%, ${u.color}0c 0%, ${C.card} 65%)` : C.card,
            border: `1px solid ${isSel ? u.color+"40" : C.border}`,
            borderRadius: 12, padding: isSel ? "10px 14px" : "10px 14px",
            cursor: "pointer", transition: "all 0.3s ease",
            display: "flex", alignItems: isSel ? "center" : "flex-start",
            gap: isSel ? 10 : 0, flexDirection: isSel ? "row" : "column",
            overflow: "hidden", minWidth: 0,
          }}>
            {isSel && <MiniGauge value={pctCap} max={100} color={u.color} size={Math.min(100, height * 0.95)}/>}
            <div style={{flex:1,minWidth:0,overflow:"hidden"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:isSel?4:3}}>
                <div style={{width:isSel?9:7,height:isSel?9:7,borderRadius:"50%",background:u.color,boxShadow:`0 0 ${isSel?7:3}px ${u.color}60`,flexShrink:0}}/>
                <span style={{fontSize:isSel?14:12,fontWeight:800,color:isSel?u.color:C.text,fontFamily:MONO,letterSpacing:1}}>{u.id}</span>
                {isSel&&<span style={{marginLeft:"auto",fontSize:9,color:C.green,background:C.greenDim,border:`1px solid ${C.greenBorder}`,borderRadius:5,padding:"1px 6px",fontFamily:MONO,fontWeight:700,whiteSpace:"nowrap"}}>SELECCIONADA</span>}
              </div>
              <div style={{fontSize:10,color:C.textMuted,fontFamily:FONT,marginBottom:isSel?6:3,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{u.name} - {u.capacity} MW</div>
              {isSel ? (
                <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                  {[{l:"Gen. Prom",v:avgF.toFixed(1)+" MW",c:u.color},{l:"Capacidad",v:pctCap+"%",c:C.text},{l:"Desv.",v:(dev>=0?"+":"")+dev.toFixed(2)+"%",c:Math.abs(dev)>2?C.red:C.green},{l:"Media",v:unitSt.mean.toFixed(2)+"%",c:C.text},{l:"Std Dev",v:unitSt.std.toFixed(2)+"%",c:u.color}].map((x,i)=>(
                    <div key={i}><div style={{fontSize:9,color:C.textMuted,fontFamily:MONO,letterSpacing:0.5}}>{x.l}</div><div style={{fontSize:14,fontWeight:800,color:x.c,fontFamily:MONO}}>{x.v}</div></div>
                  ))}
                </div>
              ) : (
                <div style={{display:"flex",alignItems:"baseline",gap:6}}>
                  <span style={{fontSize:16,fontWeight:800,color:u.color,fontFamily:MONO}}>{avgF.toFixed(0)}</span>
                  <span style={{fontSize:10,color:C.textMuted,fontFamily:MONO}}>MW</span>
                  <span style={{fontSize:10,fontWeight:700,color:Math.abs(dev)>2?C.red:C.green,fontFamily:MONO,marginLeft:"auto"}}>{dev>=0?"+":""}{dev.toFixed(1)}%</span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ═══ Control Chart ═══ */
function Chart({ unitId, width, height }) {
  const [tip, setTip] = useState(null);
  const [prog, setProg] = useState(0);

  const chartData = useMemo(() => {
    return ALL_DATA[unitId].map(r => ({ x: r.periodo-1, y: Math.round(((r.final-r.despacho)/r.despacho)*10000)/100 }));
  }, [unitId]);

  const st = useMemo(() => calcStats(chartData.map(d=>d.y)), [chartData]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setProg(0); setTip(null); let s=null; const dur=800;
    const t=ts=>{if(!s)s=ts;const p=Math.min(1,(ts-s)/dur);setProg(p<1?p*p*(3-2*p):1);if(p<1)requestAnimationFrame(t);};
    requestAnimationFrame(t);
  }, [unitId]);

  const unit = UNITS.find(u=>u.id===unitId);
  const pad = {t:22,r:30,b:28,l:44};
  const W = width, H = height;
  const pW = W-pad.l-pad.r, pH = H-pad.t-pad.b;
  const yMin = Math.min(st.lcl-0.5,...chartData.map(d=>d.y));
  const yMax = Math.max(st.ucl+0.5,...chartData.map(d=>d.y));
  const tX = i => pad.l+(i/(chartData.length-1))*pW;
  const tY = v => pad.t+((yMax-v)/(yMax-yMin))*pH;
  const vc = Math.floor(prog*chartData.length);
  const lp = chartData.slice(0,vc+1).map((d,i)=>`${i===0?"M":"L"}${tX(d.x).toFixed(1)},${tY(d.y).toFixed(1)}`).join(" ");

  const yTicks = [];
  const yStep = Math.max(0.5, Math.ceil(((yMax-yMin)/4)*10)/10);
  for (let v=Math.floor(yMin*2)/2; v<=Math.ceil(yMax*2)/2; v+=yStep) yTicks.push(Math.round(v*10)/10);

  const handleMove = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX-rect.left, my = e.clientY-rect.top;
    let cl=null, md=22;
    chartData.forEach(d=>{const dist=Math.hypot(tX(d.x)-mx,tY(d.y)-my);if(dist<md){md=dist;cl=d;}});
    if(cl) setTip({x:tX(cl.x),y:tY(cl.y),v:cl.y,i:cl.x,s:cl.y>st.ucl?"hi":cl.y<st.lcl?"lo":"ok"});
    else setTip(null);
  };

  return (
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"8px 10px 6px",height:"100%",display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4,paddingLeft:4,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <div style={{width:7,height:7,borderRadius:"50%",background:unit.color,boxShadow:`0 0 5px ${unit.color}60`}}/>
          <span style={{fontSize:12,fontWeight:700,color:C.text,fontFamily:FONT}}>Desviacion % — {unitId}</span>
        </div>
        <div style={{display:"flex",gap:12}}>
          {[{c:unit.color,l:"Desviacion",d:false},{c:C.text,l:"Media",d:true},{c:C.red,l:"UCL/LCL",d:true}].map((x,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:4}}>
              <div style={{width:12,height:2,background:x.d?"transparent":x.c,borderTop:x.d?`1.5px dashed ${x.c}`:"none"}}/>
              <span style={{fontSize:9,color:C.textMuted,fontFamily:FONT}}>{x.l}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{flex:1,minHeight:0}}>
        <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{display:"block",cursor:"crosshair"}} onMouseMove={handleMove} onMouseLeave={()=>setTip(null)}>
          <defs>
            <filter id="cgl"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            <linearGradient id="dzT" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.red} stopOpacity="0.05"/><stop offset="100%" stopColor={C.red} stopOpacity="0.01"/></linearGradient>
            <linearGradient id="dzB" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.cyan} stopOpacity="0.01"/><stop offset="100%" stopColor={C.cyan} stopOpacity="0.05"/></linearGradient>
          </defs>
          <rect x={pad.l} y={pad.t} width={pW} height={tY(st.ucl)-pad.t} fill="url(#dzT)" rx={2}/>
          <rect x={pad.l} y={tY(st.lcl)} width={pW} height={pad.t+pH-tY(st.lcl)} fill="url(#dzB)" rx={2}/>
          {yTicks.map(v=><line key={v} x1={pad.l} x2={W-pad.r} y1={tY(v)} y2={tY(v)} stroke="rgba(255,255,255,0.03)"/>)}
          {chartData.map((d,i)=>i%4===0?<line key={"v"+i} x1={tX(i)} x2={tX(i)} y1={pad.t} y2={H-pad.b} stroke="rgba(255,255,255,0.03)"/>:null)}
          <line x1={pad.l} x2={W-pad.r} y1={tY(st.ucl)} y2={tY(st.ucl)} stroke={C.red} strokeWidth={1.2} strokeDasharray="6 4" opacity={0.55}/>
          <line x1={pad.l} x2={W-pad.r} y1={tY(st.lcl)} y2={tY(st.lcl)} stroke={C.red} strokeWidth={1.2} strokeDasharray="6 4" opacity={0.55}/>
          <line x1={pad.l} x2={W-pad.r} y1={tY(st.uwl)} y2={tY(st.uwl)} stroke={C.amber} strokeWidth={0.7} strokeDasharray="3 5" opacity={0.2}/>
          <line x1={pad.l} x2={W-pad.r} y1={tY(st.lwl)} y2={tY(st.lwl)} stroke={C.amber} strokeWidth={0.7} strokeDasharray="3 5" opacity={0.2}/>
          <line x1={pad.l} x2={W-pad.r} y1={tY(st.mean)} y2={tY(st.mean)} stroke={C.text} strokeWidth={1} strokeDasharray="4 3" opacity={0.3}/>
          <text x={W-pad.r+3} y={tY(st.ucl)+3} fill={C.red} fontSize={12} fontFamily={MONO} opacity={0.6}>UCL</text>
          <text x={W-pad.r+3} y={tY(st.lcl)+3} fill={C.red} fontSize={12} fontFamily={MONO} opacity={0.6}>LCL</text>
          {vc>0&&<path d={lp} fill="none" stroke={unit.color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" filter="url(#cgl)"/>}
          {chartData.slice(0,vc+1).map((d,i)=>{
            const out=d.y>st.ucl||d.y<st.lcl; const col=out?C.red:unit.color;
            return <g key={i}>{out&&<circle cx={tX(d.x)} cy={tY(d.y)} r={6} fill={C.red} opacity={0.08}><animate attributeName="r" values="4;9;4" dur="2s" repeatCount="indefinite"/></circle>}<circle cx={tX(d.x)} cy={tY(d.y)} r={out?3:2.2} fill={C.card} stroke={col} strokeWidth={1.5}/></g>;
          })}
          {yTicks.map(v=><text key={"yl"+v} x={pad.l-5} y={tY(v)+3} fill={C.textMuted} fontSize={8} fontFamily={MONO} textAnchor="end">{v.toFixed(1)}</text>)}
          {chartData.map((d,i)=><text key={"xl"+i} x={tX(i)} y={H-pad.b+12} fill={C.textMuted} fontSize={8} fontFamily={MONO} textAnchor="middle">{i+1}</text>)}
          {tip&&<g>
            <line x1={tip.x} x2={tip.x} y1={pad.t} y2={H-pad.b} stroke={C.textMuted} strokeWidth={0.8} strokeDasharray="2 2" opacity={0.3}/>
            <circle cx={tip.x} cy={tip.y} r={4} fill={C.card} stroke={tip.s!=="ok"?C.red:unit.color} strokeWidth={2}/>
            <g transform={`translate(${tip.x<W/2?tip.x+8:tip.x-88},${Math.max(pad.t,tip.y-28)})`}>
              <rect width={80} height={24} rx={5} fill={C.cardAlt} stroke={C.border} strokeWidth={1}/>
              <text x={6} y={10} fill={C.textMuted} fontSize={7} fontFamily={MONO}>P{tip.i+1}</text>
              <text x={6} y={20} fill={tip.s!=="ok"?C.red:unit.color} fontSize={10} fontWeight={700} fontFamily={MONO}>{tip.v>=0?"+":""}{tip.v.toFixed(2)}%</text>
            </g>
          </g>}
        </svg>
      </div>
    </div>
  );
}

/* ═══ Dispatch Table ═══ */
function Table({ unitId }) {
  const [hov, setHov] = useState(-1);
  const data = ALL_DATA[unitId];
  const unit = UNITS.find(u=>u.id===unitId);
  const headers = ["Periodo","Despacho (MW)","Redespacho (MW)","Despacho Final (MW)","Desviacion %"];
  const scrollRef = useRef(null);
  const currentHour = new Date().getHours() || 24; // periodo 1-24, hour 0 maps to 24
  const currentIdx = currentHour - 1;

  useEffect(()=>{
    const container = scrollRef.current;
    if(!container) return;
    const rows = container.querySelectorAll("tbody tr");
    if(rows[currentIdx]){
      const row = rows[currentIdx];
      const containerH = container.clientHeight;
      const rowTop = row.offsetTop - container.querySelector("thead").offsetHeight;
      container.scrollTop = rowTop - containerH/2 + row.offsetHeight/2;
    }
  },[unitId, currentIdx]);

  return (
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden",height:"100%",display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",alignItems:"center",borderBottom:`1px solid ${C.border}`,padding:"0 14px",flexShrink:0}}>
        <div style={{padding:"8px 12px",fontSize:12,fontWeight:700,color:unit.color,fontFamily:FONT,borderBottom:`2px solid ${unit.color}`}}>{unitId} — Despacho 24h</div>
        <div style={{padding:"8px 12px",fontSize:12,fontWeight:500,color:C.textMuted,fontFamily:FONT,borderBottom:"2px solid transparent",cursor:"pointer"}}>Historico</div>
      </div>
      <div ref={scrollRef} style={{flex:1,overflowY:"auto",overflowX:"hidden",minHeight:0}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontFamily:FONT}}>
          <thead>
            <tr>{headers.map((h,i)=>(
              <th key={i} style={{padding:"7px 10px",textAlign:i===0?"center":"right",fontSize:9,fontWeight:600,color:C.textMuted,textTransform:"uppercase",letterSpacing:0.7,borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap",fontFamily:MONO,position:"sticky",top:0,background:C.card,zIndex:1}}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {data.map((row,i)=>{
              const dev=((row.final-row.despacho)/row.despacho)*100;
              const dA=Math.abs(dev); const dC=dA>3?C.red:dA>1.5?C.amber:C.green;
              const isCurrent = i===currentIdx;
              return (
                <tr key={i} onMouseEnter={()=>setHov(i)} onMouseLeave={()=>setHov(-1)} style={{background:isCurrent?"rgba(255,255,255,0.045)":hov===i?"rgba(255,255,255,0.015)":"transparent",transition:"background 0.1s"}}>
                  <td style={{padding:"7px 10px",textAlign:"center",fontFamily:MONO,fontSize:11,fontWeight:700,color:isCurrent?C.text:C.textSec,borderBottom:`1px solid ${C.border}`}}>{row.periodo}{isCurrent?" ◂":""}</td>
                  <td style={{padding:"7px 10px",textAlign:"right",fontFamily:MONO,fontSize:11,color:C.text,fontWeight:600,borderBottom:`1px solid ${C.border}`}}>{row.despacho.toFixed(1)}</td>
                  <td style={{padding:"7px 10px",textAlign:"right",fontFamily:MONO,fontSize:11,color:isCurrent?C.text:C.textSec,borderBottom:`1px solid ${C.border}`}}>{row.redespacho.toFixed(1)}</td>
                  <td style={{padding:"7px 10px",textAlign:"right",fontFamily:MONO,fontSize:11,fontWeight:700,color:unit.color,borderBottom:`1px solid ${C.border}`}}>{row.final.toFixed(1)}</td>
                  <td style={{padding:"7px 10px",textAlign:"right",borderBottom:`1px solid ${C.border}`}}>
                    <span style={{display:"inline-block",background:`${dC}12`,border:`1px solid ${dC}28`,borderRadius:5,padding:"2px 7px",fontFamily:MONO,fontSize:10,fontWeight:700,color:dC}}>{dev>=0?"+":""}{dev.toFixed(2)}%</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ═══ MAIN ═══ */
export default function Dashboard() {
  const [time, setTime] = useState(new Date());
  const [sel, setSel] = useState("GEC3");
  const [vh, setVh] = useState(window.innerHeight);
  const [vw, setVw] = useState(window.innerWidth);

  useEffect(()=>{const t=setInterval(()=>setTime(new Date()),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{const h=()=>{setVh(window.innerHeight);setVw(window.innerWidth);};window.addEventListener("resize",h);return()=>window.removeEventListener("resize",h);},[]);

  const totalGen = UNITS.reduce((s,u)=>s+ALL_DATA[u.id].reduce((a,r)=>a+r.final,0)/24,0);
  const totalDesp = UNITS.reduce((s,u)=>s+ALL_DATA[u.id].reduce((a,r)=>a+r.despacho,0)/24,0);
  const gDev = ((totalGen-totalDesp)/totalDesp)*100;

  // Layout math - fill viewport exactly
  const navH = 55;
  const tickerH = 52;
  const gap = 8;
  const px = 16;
  const contentH = vh - navH;
  const unitRowH = Math.max(80, contentH * 0.14);
  const footerH = 24;
  const mainH = contentH - tickerH - unitRowH - footerH - gap * 5 - px * 2;
  const chartW = Math.max(300, (vw - px * 2 - gap) * 0.55);

  return (
    <div style={{background:C.bg,width:"100vw",height:"100vh",overflow:"hidden",fontFamily:FONT,color:C.text,display:"flex",flexDirection:"column"}}>
      {/* Nav */}
      <nav style={{height:navH,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10 "+px+"px",borderBottom:`1px solid ${C.border}`,background:C.bg2}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <img src="/G3 blanco.png" alt="Gecelca" style={{height:40,objectFit:"contain",marginLeft: px}}/>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          {[{l:"Gen Total",v:totalGen.toFixed(0)+" MW",c:C.green},{l:"Despacho",v:totalDesp.toFixed(0)+" MW",c:C.cyan},{l:"Desv Global",v:(gDev>=0?"+":"")+gDev.toFixed(2)+"%",c:Math.abs(gDev)>2?C.red:C.green}].map((s,i)=>(
            <div key={i} style={{textAlign:"right"}}>
              <div style={{fontSize:8,color:C.textMuted,fontFamily:MONO,letterSpacing:0.5}}>{s.l}</div>
              <div style={{fontSize:12,fontWeight:800,color:s.c,fontFamily:MONO}}>{s.v}</div>
            </div>
          ))}
          <div style={{width:1,height:20,background:C.border}}/>
          <span style={{fontSize:11,color:C.textMuted,fontFamily:MONO}}>{time.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span>
          <div style={{width:26,height:26,borderRadius:"50%",background:`linear-gradient(135deg,${C.cyan}40,${C.green}40)`,border:`2px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:C.green,fontFamily:MONO}}>OP</div>
        </div>
      </nav>

      {/* Content */}
      <div style={{flex:1,padding:px,display:"flex",flexDirection:"column",gap,overflow:"hidden",minHeight:0}}>
        <GenerationTicker height={tickerH}/>
        <UnitCards selected={sel} onSelect={id=>setSel(id||"GEC3")} height={unitRowH}/>
        <div style={{flex:1,display:"flex",gap,minHeight:0}}>
          <div style={{flex:"55 1 0",minWidth:0}}>
            <Chart unitId={sel} width={chartW} height={Math.max(150,mainH)}/>
          </div>
          <div style={{flex:"45 1 0",minWidth:0}}>
            <Table unitId={sel}/>
          </div>
        </div>
        <div style={{height:footerH,flexShrink:0,display:"flex",justifyContent:"space-between",alignItems:"center",borderTop:`1px solid ${C.border}`,paddingTop:4}}>
          <span style={{fontSize:9,color:C.textDark,fontFamily:MONO}}>PowerGridControl v2.4.1 — Actualizacion cada 2s</span>
          <span style={{fontSize:9,color:C.textDark,fontFamily:MONO}}>UCL = +5% | LCL = -5% | 24 periodos</span>
        </div>
      </div>
    </div>
  );
}
