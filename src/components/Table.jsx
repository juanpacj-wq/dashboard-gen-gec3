import { useState, useEffect, useRef } from "react";
import { C, FONT, MONO } from "../theme";
import { UNITS, ALL_DATA } from "../data/units";

// F8: emojis para los efectos de bitácora. Sujetos a refinamiento con el usuario; si cambia
// el set, modificar acá y propaga a todos los renders.
const EMOJI_AUTH = "⚑";
const EMOJI_REDESP = "💾";
const EMOJI_PRUEBA = "🔬";
const EMOJI_EMAIL = "✉"; // ✉

function useTableData(unitId, xmDispatch, pmeAccumulated, completedPeriods, despachoFinal, projection, desviacionPeriodos, proyeccionPeriodos, autorizaciones, eventosBitacora) {
  const baseData = ALL_DATA[unitId];
  const unit = UNITS.find(u=>u.id===unitId);
  const currentIdx = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" })).getHours();

  const xmUnit = xmDispatch?.[unitId];
  const hasXmDesp = !!xmUnit?.despacho;
  const hasXmRedesp = !!xmUnit?.redespacho;
  const pmeGenMWh = pmeAccumulated?.[unitId] ?? 0;
  const unitCompleted = completedPeriods?.[unitId] || {};
  const liveProjection = projection?.[unitId] ?? null;
  const unitDesvHist = desviacionPeriodos?.[unitId] || {};
  const unitProyHist = proyeccionPeriodos?.[unitId] || {};

  const data = baseData.map((row, i) => {
    const xmDesp = hasXmDesp ? xmUnit.despacho[i] : undefined;
    const xmRedesp = hasXmRedesp ? xmUnit.redespacho[i] : undefined;
    const despacho = xmDesp != null ? xmDesp : row.despacho;
    // P. Despacho: XM API only, emails never modify this
    const redespacho = xmRedesp != null ? xmRedesp : row.redespacho;
    const periodHour = i;
    let final_;
    if (i > currentIdx) {
      final_ = 0;
    } else if (i === currentIdx) {
      final_ = pmeGenMWh;
    } else if (unitCompleted[periodHour] != null) {
      final_ = unitCompleted[periodHour];
    } else {
      final_ = 0;
    }
    final_ = Math.max(0, final_);
    const despSimulated = hasXmDesp && xmDesp == null;
    const redespSimulated = hasXmRedesp && xmRedesp == null;
    const hasRedespacho = Math.abs(despacho - redespacho) > 0.05;

    // D. Final: email first, fallback to P. Despacho (redespacho) if no email
    const periodo = i + 1;
    const dfEntry = despachoFinal?.[unitId]?.[periodo];
    let despFinal = null;
    let despFinalSource = null;
    if (dfEntry?.valor_mw != null) {
      despFinal = dfEntry.valor_mw;
      despFinalSource = dfEntry.source;
    } else if (i <= currentIdx) {
      despFinal = redespacho;
      despFinalSource = 'redespacho';
    }

    // F8: REDESP de bitácora pisa al email. Si ambos coexisten (email + bitácora), el valor
    // que se muestra es el de bitácora pero ambos emojis se superponen para no perder la
    // señal del correo (preguntas2.md respuesta C).
    const evCell = eventosBitacora?.[unitId]?.[periodo] || {};
    const redespBitacora = evCell.REDESP;
    const hasEmailDespFinal = dfEntry?.source === 'email' && dfEntry?.valor_mw != null;
    if (redespBitacora?.valor_mw != null) {
      despFinal = redespBitacora.valor_mw;
      despFinalSource = hasEmailDespFinal ? 'bitacora+email' : 'bitacora';
    }

    // Deviation:
    //  - future:  null
    //  - current: live projection from backend (VB6 logic: tProyeccion vs redespacho)
    //  - past:    historical row from desviacion_periodos (denominator = D. Final)
    //             fallback: local compute against despFinal
    const isCurrent = i === currentIdx;
    const isFuture = i > currentIdx;
    let dev = null;
    if (isFuture) {
      dev = null;
    } else if (isCurrent) {
      // Recompute deviation using projection clamped to >=0 (PME negative spikes
      // would otherwise yield bogus deviations even when generation is 0).
      const rawProj = liveProjection?.projection;
      if (rawProj != null && redespacho > 0) {
        const clampedProj = Math.max(0, rawProj);
        dev = ((clampedProj - redespacho) / redespacho) * 100;
      } else {
        dev = liveProjection?.deviation ?? null;
      }
    } else {
      const histEntry = unitDesvHist[periodo];
      if (histEntry?.desviacion_pct != null) {
        dev = histEntry.desviacion_pct;
      } else if (despFinal != null && despFinal > 0) {
        dev = ((final_ - despFinal) / despFinal) * 100;
      }
    }

    // P. Generacion:
    //  - future:  null
    //  - current: live projection (VB6 formula)
    //  - past:    closing projection snapshot from proyeccion_periodos
    let proyGeneracion = null;
    if (isFuture) {
      proyGeneracion = null;
    } else if (isCurrent) {
      proyGeneracion = liveProjection?.projection ?? null;
    } else {
      proyGeneracion = unitProyHist[periodo]?.proyeccion_cierre_mwh ?? null;
    }
    if (proyGeneracion != null) proyGeneracion = Math.max(0, proyGeneracion);

    // F8: AUTH/PRUEBA/REDESP de bitácora.
    //  - AUTH: suprime desviación (0% + emoji autorización), incluso en futuros.
    //  - PRUEBA: NO suprime; muestra emoji de pruebas.
    //  - Coexistencia AUTH+PRUEBA: PRUEBA prevalece visualmente (preguntas2.md respuesta B);
    //    desviación queda real (no se suprime) porque PRUEBA no enmascara la realidad.
    const isAutorizado = !!evCell.AUTH || !!autorizaciones?.[`${unitId}_${periodo}`];
    const isPrueba = !!evCell.PRUEBA;
    if (isAutorizado && !isPrueba) dev = 0;
    const isRedespBitacora = !!redespBitacora;

    return { ...row, despacho, redespacho, final: final_, despFinal, despFinalSource, despSimulated, redespSimulated, hasRedespacho, dev, proyGeneracion, isAutorizado, isPrueba, isRedespBitacora };
  });

  const hasEmailRedesp = despachoFinal?.[unitId] && Object.keys(despachoFinal[unitId]).length > 0;
  const isXmLive = hasXmDesp || hasXmRedesp || hasEmailRedesp;
  return { data, unit, currentIdx, isXmLive };
}

/* ─── Header compartido ─── */
function TableHeader({ unit, isXmLive, showChart, onToggleChart }) {
  return (
    <div style={{display:"flex",alignItems:"center",borderBottom:`1px solid ${C.border}`,padding:"0 14px",flexShrink:0}}>
      <div style={{padding:"8px 12px",fontSize:18,fontWeight:700,color:unit.color,fontFamily:FONT,borderBottom:`2px solid ${unit.color}`,display:"flex",alignItems:"center",gap:8}}>
        Despacho 24h
        {isXmLive
          ? <span style={{fontSize:9,background:`${C.green}25`,color:C.green,padding:"2px 6px",borderRadius:10,fontWeight:700,letterSpacing:0.5}}>XM LIVE</span>
          : <span style={{fontSize:9,background:`${C.amber}20`,color:C.amber,padding:"2px 6px",borderRadius:10,fontWeight:700,letterSpacing:0.5}}>SIMULADO</span>
        }
      </div>
      <div style={{marginLeft:"auto"}}>
        <button onClick={onToggleChart} style={{
          background: showChart ? `${unit.color}18` : `${C.textMuted}12`,
          border: `1px solid ${showChart ? unit.color+"50" : C.border}`,
          color: showChart ? unit.color : C.textMuted,
          padding:"4px 10px",borderRadius:6,cursor:"pointer",
          fontFamily:MONO,fontSize:11,fontWeight:700,letterSpacing:0.5,
          display:"flex",alignItems:"center",gap:5,
          transition:"all 0.2s",
        }}>
           {showChart ? "▸Pivotar" : "Despivotar◂"}
        </button>
      </div>
    </div>
  );
}

/* ─── Modo HORIZONTAL (periodos como columnas) ─── */
function HorizontalTable({ data, unit, currentIdx, despachoManana }) {
  const scrollRef = useRef(null);
  const [hov, setHov] = useState(-1);

  useEffect(()=>{
    requestAnimationFrame(()=>{
      const container = scrollRef.current;
      if(!container) return;
      const cols = container.querySelectorAll("thead th");
      const colEl = cols[currentIdx + 1];
      if(colEl){
        const containerRect = container.getBoundingClientRect();
        const colRect = colEl.getBoundingClientRect();
        const scrollOffset = colRect.left - containerRect.left + container.scrollLeft;
        container.scrollLeft = scrollOffset - container.clientWidth/2 + colRect.width/2;
      }
    });
  },[currentIdx, unit.id]);

  const rowDefs = [
    { key:"periodo", label:"Periodo" },
    { key:"despacho", label:"Despacho" },
    { key:"redespacho", label:<>Proyeccion<br/>Despacho</> },
    { key:"despFinal", label:<>Despacho<br/>Final</> },
    { key:"final", label:"Generacion" },
    { key:"proyGeneracion", label:<>Proyeccion<br/>Generacion</> },
    { key:"dev", label:"Desviacion" },
    { key:"despachoManana", label:<>Despacho<br/>Mañana</> },
  ];
  const numRows = rowDefs.length;

  const zebraA = "rgba(255,255,255,0.02)";
  const zebraB = "transparent";

  return (
    <div ref={scrollRef} style={{flex:1,overflowX:"auto",overflowY:"hidden",minHeight:0,display:"flex"}}>
      <table style={{borderCollapse:"separate",borderSpacing:0,fontFamily:FONT,minWidth:"100%",height:"100%"}}>
        <thead>
          <tr style={{height:`${100/numRows}%`}}>
            <th style={{padding:"2px 4px",textAlign:"left",fontSize:14,fontWeight:600,color:C.textMuted,textTransform:"uppercase",letterSpacing:0.3,borderBottom:`1px solid ${C.border}`,fontFamily:MONO,position:"sticky",left:0,background:C.card,zIndex:3}}>Periodo</th>
            {data.map((row,i)=>{
              const isCurrent = i===currentIdx;
              const isFuture = i > currentIdx;
              const zebra = i%2===0?zebraA:zebraB;
              return (
                <th key={i}
                  onMouseEnter={()=>setHov(i)} onMouseLeave={()=>setHov(-1)}
                  style={{
                    padding: isCurrent ? "6px 4px" : "4px 2px",
                    textAlign:"center",
                    fontSize: isCurrent ? 24 : 18,
                    fontWeight: isCurrent ? 900 : 700,
                    color:isCurrent?unit.color:isFuture?C.textDark:C.textSec,
                    fontFamily:MONO,borderBottom:`1px solid ${C.border}`,
                    background:isCurrent?`${unit.color}15`:hov===i?"rgba(255,255,255,0.03)":zebra,
                    borderTop:isCurrent?`3px solid ${unit.color}`:"none",
                    borderLeft:isCurrent?`2px solid ${unit.color}70`:"none",
                    borderRight:isCurrent?`2px solid ${unit.color}70`:"none",
                    minWidth:36,whiteSpace:"nowrap",
                    transition:"background 0.15s",
                    verticalAlign:"middle"
                  }}>
                  {isCurrent && <div style={{fontSize:8,background:`${unit.color}30`,color:unit.color,padding:"1px 4px",borderRadius:20,letterSpacing:1,textTransform:"uppercase",fontWeight:800,lineHeight:1.4,marginBottom:1}}>AHORA</div>}
                  {row.periodo}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rowDefs.slice(1).map((rd)=>(
            <tr key={rd.key} style={{height:`${100/numRows}%`}}>
              <td style={{padding:"2px 4px",fontSize:14,fontWeight:600,color:C.textMuted,textTransform:"uppercase",letterSpacing:0.2,fontFamily:MONO,borderBottom:`1px solid ${C.border}`,position:"sticky",left:0,background:C.card,zIndex:2,lineHeight:1.15}}>{rd.label}</td>
              {data.map((row,i)=>{
                const isCurrent = i===currentIdx;
                const isFuture = i > currentIdx;
                const val = row[rd.key];
                const isLastRow = rd.key === "dev";
                const zebra = i%2===0?zebraA:zebraB;

                let content, color = C.textSec;
                if(rd.key==="despacho"){
                  color = row.hasRedespacho?C.textDark:isCurrent?C.text:C.textSec;
                  content = <span style={{textDecoration:row.hasRedespacho?"line-through":"none",opacity:row.hasRedespacho?0.5:1}}>{Math.round(val)}</span>;
                } else if(rd.key==="redespacho"){
                  color = row.hasRedespacho?C.cyan:isCurrent?C.text:C.textSec;
                  content = Math.round(val);
                } else if(rd.key==="despFinal"){
                  if(row.despFinal != null){
                    const isFromEmail = row.despFinalSource === 'email' || row.despFinalSource === 'bitacora+email';
                    const isFromBitacora = row.isRedespBitacora;
                    color = isFromBitacora ? C.amber : isFromEmail ? C.cyan : isCurrent ? C.text : C.textSec;
                    content = <>
                      {Math.round(row.despFinal)}
                      {isFromBitacora && <span title="Redespacho desde bitácora" style={{fontSize:8,marginLeft:1}}>{EMOJI_REDESP}</span>}
                      {isFromEmail && <span title="Despacho final del correo" style={{fontSize:8,color:C.cyan,marginLeft:1}}>{EMOJI_EMAIL}</span>}
                    </>;
                  } else {
                    color = C.textMuted;
                    content = "—";
                  }
                } else if(rd.key==="proyDespacho"){
                  color = C.textMuted;
                  content = "—";
                } else if(rd.key==="proyGeneracion"){
                  if(val != null){
                    color = isCurrent ? C.cyan : isFuture ? C.textDark : `${C.cyan}aa`;
                    content = <>{val.toFixed(1)}{isCurrent && <span style={{fontSize:9,fontWeight:500,color:`${C.cyan}90`,marginLeft:2}}></span>}</>;
                  } else {
                    color = C.textMuted;
                    content = "—";
                  }
                } else if(rd.key==="final"){
                  color = isFuture?C.textDark:unit.color;
                  content = <>{val.toFixed(1)}{isCurrent && <span style={{fontSize:9,fontWeight:500,color:`${unit.color}90`,marginLeft:2}}></span>}</>;
                } else if(rd.key==="dev"){
                  if(val !== null){
                    const dA = Math.abs(val);
                    // F8: PRUEBA prevalece visualmente si coexiste con AUTH (preguntas2.md B);
                    // su semántica es no-suprimir, así que el color sigue la realidad de la
                    // desviación (rojo si > 5%).
                    const dC = (row.isAutorizado && !row.isPrueba) ? C.green : (dA > 5 ? C.red : C.green);
                    const devText = isCurrent ? val.toFixed(1) : (dA >= 100 ? Math.round(val).toString() : val.toFixed(0));
                    const tipoLabel = row.isPrueba ? "Prueba" : (row.isAutorizado ? "Autorizado por JdT" : undefined);
                    content = <span title={tipoLabel} style={{
                      background:`${dC}${isCurrent?"22":"12"}`,
                      border:`1px solid ${dC}${isCurrent?"55":"28"}`,
                      borderRadius:isCurrent?5:2,
                      padding:isCurrent?"2px 6px":"0px 2px",
                      fontSize:isCurrent?20:16,
                      fontWeight:700,
                      color:dC,
                      whiteSpace:"nowrap",
                    }}>
                      {devText}%
                      {row.isPrueba && <span style={{marginLeft:3}}>{EMOJI_PRUEBA}</span>}
                      {row.isAutorizado && !row.isPrueba && <span style={{marginLeft:3}}>{EMOJI_AUTH}</span>}
                    </span>;
                  } else {
                    content = <span style={{color:C.textMuted}}>—</span>;
                  }
                  color = undefined;
                } else if(rd.key==="despachoManana"){
                  const mVal = despachoManana?.[i];
                  if(mVal != null){
                    color = C.textSec;
                    content = Math.round(mVal);
                  } else {
                    color = C.textMuted;
                    content = "-";
                  }
                }

                return (
                  <td key={i}
                    onMouseEnter={()=>setHov(i)} onMouseLeave={()=>setHov(-1)}
                    style={{
                      padding: isCurrent ? "4px 4px" : "1px 2px",
                      textAlign:"center",fontFamily:MONO,
                      fontSize: isCurrent ? 24 : 14,
                      fontWeight: rd.key==="final" ? (isCurrent ? 900 : 800) : (isCurrent ? 700 : 600),
                      color,
                      borderBottom: isCurrent && isLastRow ? `3px solid ${unit.color}` : `1px solid ${C.border}`,
                      borderLeft: isCurrent ? `2px solid ${unit.color}70` : "none",
                      borderRight: isCurrent ? `2px solid ${unit.color}70` : "none",
                      background:isCurrent?`${unit.color}15`:hov===i?"rgba(255,255,255,0.03)":zebra,
                      transition:"background 0.15s",
                      verticalAlign:"middle",
                    }}>
                    {content}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Modo VERTICAL (periodos como filas — actual) ─── */
function VerticalTable({ data, unit, currentIdx, despachoManana }) {
  const [hov, setHov] = useState(-1);
  const scrollRef = useRef(null);
  const headers = [
    "Periodo",
    "Despacho (MW)",
    <><span>Proyeccion</span><br/><span>Despacho (MW)</span></>,
    <><span>Despacho</span><br/><span>Final (MW)</span></>,
    "Generacion (MWH)",
    <><span>Proyeccion</span><br/><span>Generacion (MWh)</span></>,
    "Desviacion %",
    <><span>Despacho</span><br/><span>Mañana (MW)</span></>,
  ];

  useEffect(()=>{
    const container = scrollRef.current;
    if(!container) return;
    const rows = container.querySelectorAll("tbody tr");
    if(rows[currentIdx]){
      const row = rows[currentIdx];
      const containerRect = container.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const scrollOffset = rowRect.top - containerRect.top + container.scrollTop;
      container.scrollTop = scrollOffset - container.clientHeight/2 + row.getBoundingClientRect().height/2;
    }
  },[currentIdx]);

  return (
    <div ref={scrollRef} style={{flex:1,overflowY:"auto",overflowX:"hidden",minHeight:0}}>
      <table style={{width:"100%",borderCollapse:"separate",borderSpacing:0,fontFamily:FONT}}>
        <thead>
          <tr>{headers.map((h,i)=>(
            <th key={i} style={{padding:"5px 6px",textAlign:i===0?"center":"right",fontSize:11,fontWeight:600,color:C.textMuted,textTransform:"uppercase",letterSpacing:0.5,borderBottom:`1px solid ${C.border}`,fontFamily:MONO,position:"sticky",top:0,background:C.card,zIndex:1,lineHeight:1.3}}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {data.map((row,i)=>{
            const isCurrent = i===currentIdx;
            const dev = row.dev;
            const dA = dev !== null ? Math.abs(dev) : 0;
            // F8: PRUEBA no suprime — su color sigue la desviación real. AUTH suprime sólo si
            // no coexiste con PRUEBA (preguntas2.md B).
            const dC = dev === null
              ? C.textMuted
              : (row.isAutorizado && !row.isPrueba) ? C.green : dA > 5 ? C.red : C.green;
            const cBt = isCurrent?`2px solid ${unit.color}70`:`1px solid ${C.border}`;
            const cBb = isCurrent?`2px solid ${unit.color}70`:`1px solid ${C.border}`;
            return (
              <tr key={i} onMouseEnter={()=>setHov(i)} onMouseLeave={()=>setHov(-1)}
                style={{
                  background: isCurrent
                    ? `linear-gradient(90deg,${unit.color}20 0%,${unit.color}08 60%,transparent 100%)`
                    : hov===i?"rgba(255,255,255,0.015)":"transparent",
                  transition:"background 0.15s",
                  position: isCurrent?"relative":undefined,
                  zIndex: isCurrent?2:undefined,
                }}>
                {/* Periodo */}
                <td style={{
                  padding:isCurrent?"10px 8px":"3px 6px",
                  textAlign:"center", fontFamily:MONO,
                  borderTop:cBt, borderBottom:cBb,
                  borderLeft:isCurrent?`3px solid ${unit.color}`:"none",
                  verticalAlign:"middle",
                }}>
                  {isCurrent ? (
                    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                      <span style={{fontSize:9,background:`${unit.color}30`,color:unit.color,padding:"1px 6px",borderRadius:20,letterSpacing:1.5,textTransform:"uppercase",fontWeight:800,lineHeight:1.4}}>AHORA</span>
                      <span style={{fontSize:28,fontWeight:900,color:unit.color,lineHeight:1}}>{row.periodo}</span>
                    </div>
                  ) : (
                    <span style={{fontSize:20,fontWeight:700,color:C.textSec}}>{row.periodo}</span>
                  )}
                </td>
                {/* Despacho */}
                <td style={{padding:isCurrent?"10px 8px":"3px 6px",textAlign:"right",fontFamily:MONO,fontSize:isCurrent?34:26,color:row.hasRedespacho?(isCurrent?`${C.textMuted}aa`:C.textDark):row.despSimulated?(isCurrent?`${C.amber}cc`:C.amber):(isCurrent?C.text:C.textSec),fontWeight:isCurrent?700:600,borderTop:cBt,borderBottom:cBb,verticalAlign:"middle",textDecoration:row.hasRedespacho?"line-through":"none",opacity:row.hasRedespacho?0.5:1,lineHeight:1}}>
                  <span title={row.hasRedespacho?"Valor reemplazado por redespacho":row.despSimulated?"Valor aleatorio, no extraido correctamente de XM":undefined} style={{cursor:(row.hasRedespacho||row.despSimulated)?"help":undefined,borderBottom:row.despSimulated&&!row.hasRedespacho?`1px dashed ${C.amber}60`:undefined}}>
                    {Math.round(row.despacho)}
                    {row.despSimulated && !row.hasRedespacho && <span style={{fontSize:12,marginLeft:3,color:C.amber}}>⚠</span>}
                  </span>
                </td>
                {/* Redespacho */}
                <td style={{padding:isCurrent?"10px 8px":"3px 6px",textAlign:"right",fontFamily:MONO,fontSize:isCurrent?34:26,color:row.hasRedespacho?(isCurrent?C.cyan:C.cyan):row.redespSimulated?(isCurrent?`${C.amber}cc`:C.amber):(isCurrent?C.text:C.textSec),fontWeight:row.hasRedespacho?(isCurrent?800:700):(isCurrent?700:600),borderTop:cBt,borderBottom:cBb,verticalAlign:"middle",background:row.hasRedespacho?`${C.cyan}08`:"transparent",lineHeight:1}}>
                  <span title={row.hasRedespacho?"Redespacho activo":row.redespSimulated?"Valor aleatorio, no extraido correctamente de XM":undefined} style={{cursor:(row.hasRedespacho||row.redespSimulated)?"help":undefined,borderBottom:row.redespSimulated&&!row.hasRedespacho?`1px dashed ${C.amber}60`:undefined}}>
                    {Math.round(row.redespacho)}
                    {row.hasRedespacho && <span style={{fontSize:9,marginLeft:3,color:C.cyan}}>▸</span>}
                    {row.redespSimulated && !row.hasRedespacho && <span style={{fontSize:9,marginLeft:3,color:C.amber}}>⚠</span>}
                  </span>
                </td>
                {/* D. Final */}
                {(() => {
                  const isFromEmail = row.despFinalSource === 'email' || row.despFinalSource === 'bitacora+email';
                  const isFromBitacora = row.isRedespBitacora;
                  const cellColor = row.despFinal == null
                    ? C.textMuted
                    : isFromBitacora ? C.amber : isFromEmail ? C.cyan : isCurrent ? C.text : C.textSec;
                  const cellBg = isFromBitacora ? `${C.amber}10` : (isFromEmail ? `${C.cyan}08` : "transparent");
                  return (
                    <td style={{padding:isCurrent?"10px 8px":"3px 6px",textAlign:"right",fontFamily:MONO,fontSize:isCurrent?34:26,fontWeight:isCurrent?700:600,color:cellColor,borderTop:cBt,borderBottom:cBb,verticalAlign:"middle",background:cellBg,lineHeight:1}}>
                      {row.despFinal != null ? (
                        <span>
                          {Math.round(row.despFinal)}
                          {isFromBitacora && <span title="Redespacho desde bitácora" style={{fontSize:11,marginLeft:3}}>{EMOJI_REDESP}</span>}
                          {isFromEmail && <span title="Despacho final del correo" style={{fontSize:11,marginLeft:3,color:C.cyan}}>{EMOJI_EMAIL}</span>}
                        </span>
                      ) : (
                        <span style={{color:C.textMuted}}>—</span>
                      )}
                    </td>
                  );
                })()}
                {/* Generacion */}
                <td style={{padding:isCurrent?"10px 8px":"3px 6px",textAlign:"right",fontFamily:MONO,fontSize:isCurrent?34:26,fontWeight:900,color:unit.color,letterSpacing:isCurrent?-0.5:0,borderTop:cBt,borderBottom:cBb,verticalAlign:"middle",lineHeight:1}}>
                  {row.final.toFixed(2)}
                  {isCurrent && <span style={{fontSize:11,fontWeight:500,color:`${unit.color}90`,marginLeft:3}}>MWH</span>}
                </td>
                {/* P. Generacion (proyección VB6) */}
                <td style={{padding:isCurrent?"16px 14px":"7px 10px",textAlign:"right",fontFamily:MONO,fontSize:isCurrent?26:18,fontWeight:isCurrent?800:600,color:row.proyGeneracion!=null?(isCurrent?C.cyan:`${C.cyan}aa`):C.textMuted,borderTop:cBt,borderBottom:cBb,verticalAlign:"middle",lineHeight:1}}>
                  {row.proyGeneracion != null ? (
                    <span title="Proyección VB6: acumulado + potencia * (tiempo restante / 3600)">
                      {row.proyGeneracion.toFixed(2)}
                      {isCurrent && <span style={{fontSize:11,fontWeight:500,color:`${C.cyan}90`,marginLeft:3}}>MWh</span>}
                    </span>
                  ) : (
                    <span style={{color:C.textMuted}}>—</span>
                  )}
                </td>
                {/* Desviacion */}
                <td style={{padding:isCurrent?"16px 14px":"7px 10px",textAlign:"right",borderTop:cBt,borderBottom:cBb,verticalAlign:"middle"}}>
                  {dev !== null ? (
                    <span title={row.isPrueba ? "Prueba" : (row.isAutorizado ? "Autorizado por JdT" : undefined)} style={{display:"inline-block",background:`${dC}${isCurrent?"22":"12"}`,border:`1px solid ${dC}${isCurrent?"55":"28"}`,borderRadius:6,padding:isCurrent?"5px 12px":"2px 7px",fontFamily:MONO,fontSize:isCurrent?22:16,fontWeight:700,color:dC}}>
                      {dev>=0?"+":""}{dev.toFixed(2)}%
                      {row.isPrueba && <span style={{marginLeft:4}}>{EMOJI_PRUEBA}</span>}
                      {row.isAutorizado && !row.isPrueba && <span style={{marginLeft:4}}>{EMOJI_AUTH}</span>}
                    </span>
                  ) : (
                    <span style={{fontFamily:MONO,fontSize:12,color:C.textMuted}}>—</span>
                  )}
                </td>
                {/* Despacho Mañana */}
                <td style={{padding:isCurrent?"10px 8px":"3px 6px",textAlign:"right",fontFamily:MONO,fontSize:isCurrent?34:26,fontWeight:isCurrent?700:600,color:despachoManana?.[i]!=null?C.textSec:C.textMuted,borderTop:cBt,borderBottom:cBb,borderRight:isCurrent?`2px solid ${unit.color}70`:"none",verticalAlign:"middle",lineHeight:1}}>
                  {despachoManana?.[i] != null ? Math.round(despachoManana[i]) : <span style={{color:C.textMuted}}>-</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Componente principal ─── */
export function Table({ unitId, xmDispatch, despachoManana, pmeAccumulated, completedPeriods, despachoFinal, projection, desviacionPeriodos, proyeccionPeriodos, autorizaciones, eventosBitacora, horizontal, showChart, onToggleChart }) {
  const { data, unit, currentIdx, isXmLive } = useTableData(unitId, xmDispatch, pmeAccumulated, completedPeriods, despachoFinal, projection, desviacionPeriodos, proyeccionPeriodos, autorizaciones, eventosBitacora);

  // despachoManana is { GEC3: [24], GEC32: [24], ... } or null
  const unitDespachoManana = despachoManana?.[unitId] || null;

  return (
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden",height:"100%",display:"flex",flexDirection:"column"}}>
      <TableHeader unit={unit} isXmLive={isXmLive} showChart={showChart} onToggleChart={onToggleChart} />
      {horizontal
        ? <HorizontalTable data={data} unit={unit} currentIdx={currentIdx} despachoManana={unitDespachoManana} />
        : <VerticalTable data={data} unit={unit} currentIdx={currentIdx} despachoManana={unitDespachoManana} />
      }
    </div>
  );
}