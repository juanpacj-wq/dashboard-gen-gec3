import { useState, useEffect } from "react";
import { C, FONT, MONO, tint } from "./theme";
import { UNITS, ALL_DATA } from "./data/units";
import { getConfig } from "./config/instance";
import { assetUrl } from "./config/paths";
import { UnitCards } from "./components/UnitCards";
import { GenerationTicker } from "./components/GenerationTicker";
import { Chart } from "./components/Chart";
import { Table } from "./components/Table";
import { useRealtimeData } from "./hooks/useRealtimeData";
import { useXmDispatch } from "./hooks/useXmDispatch";
import { useEventosBitacora } from "./hooks/useEventosBitacora";


const STATUS_CFG = {
  live:         { color: C.green,   label: "En vivo" },
  reconnecting: { color: "#f59e0b", label: "Reconectando..." },
  connecting:   { color: C.textMuted, label: "Conectando..." },
};


export default function Dashboard() {
  const [time, setTime] = useState(new Date());
  const [sel, setSel] = useState(getConfig().defaultUnit);
  const [showChart, setShowChart] = useState(false);
  const [vh, setVh] = useState(window.innerHeight);
  const [vw, setVw] = useState(window.innerWidth);
  const { units: rtUnits, status: wsStatus, lastUpdate, accumulated, minuteDeviations, completedPeriods, despachoFinal, projection, desviacionPeriodos, proyeccionPeriodos, eventosSignal } = useRealtimeData();
  const { dispatchData: xmDispatch, despachoManana } = useXmDispatch();
  // F8: el hook nuevo trae AUTH/REDESP/PRUEBA. Derivamos la shape antigua (`{uid_periodo}`)
  // sólo para AUTH para que UnitCards y los totales sigan funcionando sin cambios.
  // eventosSignal (del WS) dispara un refetch inmediato cuando Bitácora guarda — reflejo casi
  // instantáneo; el poll interno del hook queda como red de seguridad.
  const { eventos: eventosBitacora } = useEventosBitacora(undefined, eventosSignal);
  const autorizaciones = (() => {
    const out = {};
    for (const planta of Object.keys(eventosBitacora || {})) {
      for (const periodo of Object.keys(eventosBitacora[planta] || {})) {
        const auth = eventosBitacora[planta][periodo].AUTH;
        if (auth) out[`${planta}_${periodo}`] = auth;
      }
    }
    return out;
  })();

  useEffect(()=>{const t=setInterval(()=>setTime(new Date()),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{const h=()=>{setVh(window.innerHeight);setVw(window.innerWidth);};window.addEventListener("resize",h);return()=>window.removeEventListener("resize",h);},[]);

  // Periodo actual Colombia (UTC-5)
  const currentIdx = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" })).getHours();

  // Totales globales reales del periodo actual
  // Gen Total = suma de los valores instantáneos PME (valueMW), negativos cuentan como 0
  // Las unidades con autorización vigente en el periodo actual se excluyen del cálculo
  // (no contribuyen ni al numerador ni al denominador).
  const currentPeriodo = currentIdx + 1;
  const isUnitAuthorized = (uid) => !!autorizaciones?.[`${uid}_${currentPeriodo}`];
  const totalGen = UNITS.reduce((s, u) => {
    if (isUnitAuthorized(u.id)) return s;
    const rt = rtUnits.find(r => r.id === u.id);
    return s + Math.max(0, rt?.valueMW ?? 0);
  }, 0);
  const totalRedesp = UNITS.reduce((s, u) => {
    if (isUnitAuthorized(u.id)) return s;
    const xmRedesp = xmDispatch?.[u.id]?.redespacho?.[currentIdx];
    return s + (xmRedesp ?? ALL_DATA[u.id][currentIdx].redespacho);
  }, 0);
  const gDev = totalRedesp !== 0 ? ((totalGen - totalRedesp) / totalRedesp) * 100 : 0;
  const hasAnyAuthNow = UNITS.some(u => isUnitAuthorized(u.id));

  // Header oculto para dar TODO su espacio a las UnitCards. Para restaurarlo poné SHOW_NAV=true:
  // toda la lógica que lo alimenta (totales, reloj, estado WS) sigue intacta más abajo y el
  // <nav> sólo está envuelto en este flag, así que restaurarlo es un cambio de una línea.
  const SHOW_NAV = false;
  const navH = SHOW_NAV ? 55 : 0;
  const tickerH = 52;
  const gap = 5;
  const px = 16;
  const contentH = vh - navH;
  // Espacio reasignado ÍNTEGRO a las unit cards (NO repartido en la fila central Table/Chart,
  // que es flex:1), para agrandar los indicadores de unidad:
  //  - footer eliminado: su height (24) + su gap.
  //  - header oculto (SHOW_NAV=false): sus 55px.
  // La fracción base usa la altura "de diseño" (con nav) para que togglear SHOW_NAV no recalcule
  // la fracción y mantenga la fila central idéntica; sólo cambia el alto de las cards.
  const designContentH = vh - 55;
  const freedByFooter = 24 + gap;
  const freedByNav = SHOW_NAV ? 0 : 55;
  const unitRowH = Math.max(80, designContentH * 0.14) + freedByFooter + freedByNav;
  const mainH = contentH - tickerH - unitRowH - gap * 2 - px * 2;
  const chartW = Math.max(300, (vw - px * 2 - gap) * 0.55);

  // Tinte muy oscuro del color de la planta seleccionada para el fondo y las superficies.
  // El fondo (marco) recibe más matiz que la nav para conservar la jerarquía de capas.
  const selColor = (UNITS.find(u => u.id === sel)?.color) ?? C.blue;
  const bgTint = tint(C.bg, selColor, 0.12);
  const navTint = tint(C.bg2, selColor, 0.07);

  return (
    <div style={{background:bgTint,transition:"background 0.4s ease",width:"100vw",height:"100vh",overflow:"hidden",fontFamily:FONT,color:C.text,display:"flex",flexDirection:"column",position:"relative"}}>
      {/* Nav — oculta vía SHOW_NAV (ver arriba). Envuelta en el flag para revert de una línea. */}
      {SHOW_NAV && (
      <nav style={{height:navH,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10 "+px+"px",borderBottom:`1px solid ${C.border}`,background:navTint,transition:"background 0.4s ease"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <img src={assetUrl(getConfig().branding.logo)} alt={getConfig().branding.logoAlt} style={{height:40,objectFit:"contain",marginLeft: px}}/>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          {[
            {l:"Potencia Total",v:totalGen.toFixed(0)+" MWh",c:C.green},
            {l:"Redespacho",v:totalRedesp.toFixed(0)+" MW",c:C.cyan},
            {l:"Desv Global",v:(gDev>=0?"+":"")+gDev.toFixed(2)+"%",c:hasAnyAuthNow?C.green:(Math.abs(gDev)>2?C.red:C.green),flag:hasAnyAuthNow},
          ].map((s,i)=>(
            <div key={i} style={{textAlign:"right"}}>
              <div style={{fontSize: 10,color:C.textMuted,fontFamily:MONO,letterSpacing:0.5}}>{s.l}</div>
              <div style={{fontSize: 14,fontWeight:800,color:s.c,fontFamily:MONO}}>
                {s.v}
                {s.flag && <span title="Una o más unidades con autorización vigente — excluidas del cálculo" style={{marginLeft:4,color:C.green}}>⚑</span>}
              </div>
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
      )}

      {/* Content */}
      <div style={{flex:1,padding:px,display:"flex",flexDirection:"column",gap,overflow:"hidden",minHeight:0,position:"relative",zIndex:1}}>
        <UnitCards selected={sel} onSelect={id=>setSel(id||getConfig().defaultUnit)} height={unitRowH} realtimeUnits={rtUnits} pmeAccumulated={accumulated} projection={projection} xmDispatch={xmDispatch} autorizaciones={autorizaciones} eventosBitacora={eventosBitacora}/>

        <div style={{flex:1,display:"flex",gap,minHeight:0}}>
          <div style={{flex:showChart?"60 1 0":"80 1 0",minWidth:0,transition:"flex 0.3s ease"}}>
            <Table unitId={sel} xmDispatch={xmDispatch} despachoManana={despachoManana} pmeAccumulated={accumulated} completedPeriods={completedPeriods} despachoFinal={despachoFinal} projection={projection} desviacionPeriodos={desviacionPeriodos} proyeccionPeriodos={proyeccionPeriodos} autorizaciones={autorizaciones} eventosBitacora={eventosBitacora} horizontal={!showChart} showChart={showChart} onToggleChart={()=>setShowChart(v=>!v)}/>
          </div>
          <div style={{flex:showChart?"40 1 0":"20 1 0",minWidth:0,transition:"flex 0.3s ease"}}>
            <Chart unitId={sel} width={chartW} height={Math.max(150,mainH)} minuteDeviations={minuteDeviations} xmDispatch={xmDispatch} realtimeUnit={rtUnits.find(r => r.id === sel) ?? null}/>
          </div>
        </div>
        <GenerationTicker height={tickerH}/>

      </div>

      {/* Marca de agua: el logo (la nav que lo mostraba está oculta) flota como overlay sutil por
          encima del dashboard. Va arriba —no en el fondo— porque los paneles son opacos y llenan
          toda la pantalla; un logo detrás nunca asomaría. pointerEvents:none para no bloquear clics. */}
      <img src={assetUrl(getConfig().branding.logo)} alt={getConfig().branding.logoAlt} aria-hidden="true" style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:"34vw",maxWidth:460,opacity:0.07,objectFit:"contain",pointerEvents:"none",userSelect:"none",zIndex:50}}/>
    </div>
  );
}
