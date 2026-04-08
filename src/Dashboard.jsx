import { useState, useEffect } from "react";
import { C, FONT, MONO } from "./theme";
import { UNITS, ALL_DATA } from "./data/units";
import { UnitCards } from "./components/UnitCards";
import { GenerationTicker } from "./components/GenerationTicker";
import { Chart } from "./components/Chart";
import { Table } from "./components/Table";
import { useRealtimeData } from "./hooks/useRealtimeData";
import { useXmDispatch } from "./hooks/useXmDispatch";


const STATUS_CFG = {
  live:         { color: C.green,   label: "En vivo" },
  reconnecting: { color: "#f59e0b", label: "Reconectando..." },
  connecting:   { color: C.textMuted, label: "Conectando..." },
};

export default function Dashboard() {
  const [time, setTime] = useState(new Date());
  const [sel, setSel] = useState("GEC3");
  const [showChart, setShowChart] = useState(false);
  const [vh, setVh] = useState(window.innerHeight);
  const [vw, setVw] = useState(window.innerWidth);
  const { units: rtUnits, status: wsStatus, lastUpdate, accumulated, minuteAvgs, completedPeriods, despachoFinal, projection, desviacionPeriodos, proyeccionPeriodos } = useRealtimeData();
  const { dispatchData: xmDispatch } = useXmDispatch();

  useEffect(()=>{const t=setInterval(()=>setTime(new Date()),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{const h=()=>{setVh(window.innerHeight);setVw(window.innerWidth);};window.addEventListener("resize",h);return()=>window.removeEventListener("resize",h);},[]);

  // Periodo actual Colombia (UTC-5)
  const currentIdx = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" })).getHours();

  // Totales globales reales del periodo actual
  // Gen Total = suma de los valores instantáneos PME (valueMW), negativos cuentan como 0
  const totalGen = UNITS.reduce((s, u) => {
    const rt = rtUnits.find(r => r.id === u.id);
    return s + Math.max(0, rt?.valueMW ?? 0);
  }, 0);
  const totalRedesp = UNITS.reduce((s, u) => {
    const xmRedesp = xmDispatch?.[u.id]?.redespacho?.[currentIdx];
    return s + (xmRedesp ?? ALL_DATA[u.id][currentIdx].redespacho);
  }, 0);
  // Desviación global = comparación directa MW generados vs MW redespachados
  const gDev = totalRedesp !== 0 ? ((totalGen - totalRedesp) / totalRedesp) * 100 : 0;

  const navH = 55;
  const tickerH = 52;
  const gap = 5;
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
          {[{l:"Gen Total",v:totalGen.toFixed(0)+" MW",c:C.green},{l:"Redespacho",v:totalRedesp.toFixed(0)+" MW",c:C.cyan},{l:"Desv Global",v:(gDev>=0?"+":"")+gDev.toFixed(2)+"%",c:Math.abs(gDev)>2?C.red:C.green}].map((s,i)=>(
            <div key={i} style={{textAlign:"right"}}>
              <div style={{fontSize: 10,color:C.textMuted,fontFamily:MONO,letterSpacing:0.5}}>{s.l}</div>
              <div style={{fontSize: 14,fontWeight:800,color:s.c,fontFamily:MONO}}>{s.v}</div>
            </div>
          ))}
          <div style={{width:1,height:20,background:C.border}}/>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:1}}>
            <div style={{display:"flex",alignItems:"center",gap:5}}>
              <div style={{width:7,height:7,borderRadius:"50%",background:STATUS_CFG[wsStatus].color,boxShadow:`0 0 6px ${STATUS_CFG[wsStatus].color}`}}/>
              <span style={{fontSize:11,color:STATUS_CFG[wsStatus].color,fontFamily:MONO,fontWeight:700}}>{STATUS_CFG[wsStatus].label}</span>
            </div>
            {lastUpdate && <span style={{fontSize:10,color:C.textDark,fontFamily:MONO}}>{lastUpdate.toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>}
          </div>
          <div style={{width:1,height:20,background:C.border}}/>
          <span style={{fontSize: 13,color:C.textMuted,fontFamily:MONO}}>{time.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span>
          <div style={{width:26,height:26,borderRadius:"50%",background:`linear-gradient(135deg,${C.cyan}40,${C.green}40)`,border:`2px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize: 12,fontWeight:700,color:C.green,fontFamily:MONO}}>OP</div>
        </div>
      </nav>

      {/* Content */}
      <div style={{flex:1,padding:px,display:"flex",flexDirection:"column",gap,overflow:"hidden",minHeight:0}}>
        <UnitCards selected={sel} onSelect={id=>setSel(id||"GEC3")} height={unitRowH} realtimeUnits={rtUnits} pmeAccumulated={accumulated} projection={projection}/>

        <div style={{flex:1,display:"flex",gap,minHeight:0}}>
          <div style={{flex:showChart?"60 1 0":"80 1 0",minWidth:0,transition:"flex 0.3s ease"}}>
            <Table unitId={sel} xmDispatch={xmDispatch} pmeAccumulated={accumulated} completedPeriods={completedPeriods} despachoFinal={despachoFinal} projection={projection} desviacionPeriodos={desviacionPeriodos} proyeccionPeriodos={proyeccionPeriodos} horizontal={!showChart} showChart={showChart} onToggleChart={()=>setShowChart(v=>!v)}/>
          </div>
          <div style={{flex:showChart?"40 1 0":"20 1 0",minWidth:0,transition:"flex 0.3s ease"}}>
            <Chart unitId={sel} width={chartW} height={Math.max(150,mainH)} minuteAvgs={minuteAvgs} xmDispatch={xmDispatch}/>
          </div>
        </div>
        <GenerationTicker height={tickerH}/>
        <div style={{height:footerH,flexShrink:0,display:"flex",justifyContent:"space-between",alignItems:"center",borderTop:`1px solid ${C.border}`,paddingTop:4}}>
          <span style={{fontSize: 11,color:C.textDark,fontFamily:MONO}}>Dashboard generación v2.4.1 — Actualizacion cada 2s</span>
          <span style={{fontSize: 11,color:C.textDark,fontFamily:MONO}}>UCL = +5% | LCL = -5% | 24 periodos</span>
        </div>
      </div>
    </div>
  );
}
