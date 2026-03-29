import { useState, useEffect, useRef } from "react";
import { C, FONT, MONO } from "../theme";
import { UNITS, ALL_DATA } from "../data/units";

export function Table({ unitId, xmDispatch, pmeAccumulated, completedPeriods }) {
  const [hov, setHov] = useState(-1);
  const baseData = ALL_DATA[unitId];
  const unit = UNITS.find(u=>u.id===unitId);
  const currentHour = new Date().getHours() || 24;
  const currentIdx = currentHour - 1;

  // Overlay XM API data for despacho/redespacho/generacion when available
  // XM values are number | null. null = API didn't return data for that period
  const xmUnit = xmDispatch?.[unitId];
  const hasXmDesp = !!xmUnit?.despacho;
  const hasXmRedesp = !!xmUnit?.redespacho;
  const pmeGenMWh = pmeAccumulated?.[unitId] ?? 0;
  const unitCompleted = completedPeriods?.[unitId] || {};
  const data = baseData.map((row, i) => {
    const xmDesp = hasXmDesp ? xmUnit.despacho[i] : undefined;
    const xmRedesp = hasXmRedesp ? xmUnit.redespacho[i] : undefined;
    // Use API value if present (including 0), fall back to simulated if null/undefined
    const despacho = xmDesp != null ? xmDesp : row.despacho;
    const redespacho = xmRedesp != null ? xmRedesp : row.redespacho;
    // Generation: current period = PME live, past completed = stored, rest = 0
    const periodHour = i; // periodIdx 0 = hour 0, etc.
    let final_;
    if (i === currentIdx) {
      final_ = pmeGenMWh;
    } else if (unitCompleted[periodHour] != null) {
      final_ = unitCompleted[periodHour];
    } else {
      final_ = 0;
    }
    // Flag as simulated fallback only when API was fetched but returned null for this period
    const despSimulated = hasXmDesp && xmDesp == null;
    const redespSimulated = hasXmRedesp && xmRedesp == null;
    const hasRedespacho = Math.abs(despacho - redespacho) > 0.05;
    return { ...row, despacho, redespacho, final: final_, despSimulated, redespSimulated, hasRedespacho };
  });
  const isXmLive = hasXmDesp || hasXmRedesp;
  const headers = ["Periodo","Despacho (MW)","Redespacho (MW)","GENERACIÓN (MW)","Desviación %"];
  const scrollRef = useRef(null);

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
  },[unitId, currentIdx]);

  return (
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden",height:"100%",display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",alignItems:"center",borderBottom:`1px solid ${C.border}`,padding:"0 14px",flexShrink:0}}>
        <div style={{padding:"8px 12px",fontSize: 14,fontWeight:700,color:unit.color,fontFamily:FONT,borderBottom:`2px solid ${unit.color}`,display:"flex",alignItems:"center",gap:8}}>
          {unitId} — Despacho 24h
          {isXmLive
            ? <span style={{fontSize:9,background:`${C.green}25`,color:C.green,padding:"2px 6px",borderRadius:10,fontWeight:700,letterSpacing:0.5}}>XM LIVE</span>
            : <span style={{fontSize:9,background:`${C.amber}20`,color:C.amber,padding:"2px 6px",borderRadius:10,fontWeight:700,letterSpacing:0.5}}>SIMULADO</span>
          }
        </div>
        <div style={{padding:"8px 12px",fontSize: 14,fontWeight:500,color:C.textMuted,fontFamily:FONT,borderBottom:"2px solid transparent",cursor:"pointer"}}>Histórico</div>
      </div>
      <div ref={scrollRef} style={{flex:1,overflowY:"auto",overflowX:"hidden",minHeight:0}}>
        <table style={{width:"100%",borderCollapse:"separate",borderSpacing:0,fontFamily:FONT}}>
          <thead>
            <tr>{headers.map((h,i)=>(
              <th key={i} style={{padding:"7px 10px",textAlign:i===0?"center":"right",fontSize: 11,fontWeight:600,color:C.textMuted,textTransform:"uppercase",letterSpacing:0.7,borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap",fontFamily:MONO,position:"sticky",top:0,background:C.card,zIndex:1}}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {data.map((row,i)=>{
              const dev=row.redespacho!==0?((row.final-row.redespacho)/row.redespacho)*100:0;
              const dA=Math.abs(dev); const dC=dA>3?C.red:dA>1.5?C.amber:C.green;
              const isCurrent = i===currentIdx;
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
                    padding:isCurrent?"16px 14px":"7px 10px",
                    textAlign:"center", fontFamily:MONO,
                    borderTop:cBt, borderBottom:cBb,
                    borderLeft:isCurrent?`3px solid ${unit.color}`:"none",
                    verticalAlign:"middle",
                  }}>
                    {isCurrent ? (
                      <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
                        <span style={{fontSize:9,background:`${unit.color}30`,color:unit.color,padding:"2px 7px",borderRadius:20,letterSpacing:1.5,textTransform:"uppercase",fontWeight:800,lineHeight:1.5}}>AHORA</span>
                        <span style={{fontSize:22,fontWeight:900,color:unit.color,lineHeight:1}}>{row.periodo}</span>
                      </div>
                    ) : (
                      <span style={{fontSize:13,fontWeight:700,color:C.textSec}}>{row.periodo}</span>
                    )}
                  </td>
                  {/* Despacho */}
                  <td style={{padding:isCurrent?"16px 14px":"7px 10px",textAlign:"right",fontFamily:MONO,fontSize:isCurrent?16:13,color:row.hasRedespacho?(isCurrent?`${C.textMuted}aa`:C.textDark):row.despSimulated?(isCurrent?`${C.amber}cc`:C.amber):(isCurrent?C.text:C.textSec),fontWeight:isCurrent?700:600,borderTop:cBt,borderBottom:cBb,verticalAlign:"middle",textDecoration:row.hasRedespacho?"line-through":"none",opacity:row.hasRedespacho?0.5:1}}>
                    <span title={row.hasRedespacho?"Valor reemplazado por redespacho":row.despSimulated?"Valor aleatorio, no extraído correctamente de XM":undefined} style={{cursor:(row.hasRedespacho||row.despSimulated)?"help":undefined,borderBottom:row.despSimulated&&!row.hasRedespacho?`1px dashed ${C.amber}60`:undefined}}>
                      {row.despacho.toFixed(1)}
                      {row.despSimulated && !row.hasRedespacho && <span style={{fontSize:9,marginLeft:3,color:C.amber}}>⚠</span>}
                    </span>
                  </td>
                  {/* Redespacho */}
                  <td style={{padding:isCurrent?"16px 14px":"7px 10px",textAlign:"right",fontFamily:MONO,fontSize:isCurrent?16:13,color:row.hasRedespacho?(isCurrent?C.cyan:C.cyan):row.redespSimulated?(isCurrent?`${C.amber}cc`:C.amber):(isCurrent?C.text:C.textSec),fontWeight:row.hasRedespacho?(isCurrent?800:700):(isCurrent?700:600),borderTop:cBt,borderBottom:cBb,verticalAlign:"middle",background:row.hasRedespacho?`${C.cyan}08`:"transparent"}}>
                    <span title={row.hasRedespacho?"Redespacho activo":row.redespSimulated?"Valor aleatorio, no extraído correctamente de XM":undefined} style={{cursor:(row.hasRedespacho||row.redespSimulated)?"help":undefined,borderBottom:row.redespSimulated&&!row.hasRedespacho?`1px dashed ${C.amber}60`:undefined}}>
                      {row.redespacho.toFixed(1)}
                      {row.hasRedespacho && <span style={{fontSize:9,marginLeft:3,color:C.cyan}}>▸</span>}
                      {row.redespSimulated && !row.hasRedespacho && <span style={{fontSize:9,marginLeft:3,color:C.amber}}>⚠</span>}
                    </span>
                  </td>
                  {/* Generación */}
                  <td style={{padding:isCurrent?"16px 14px":"7px 10px",textAlign:"right",fontFamily:MONO,fontSize:isCurrent?24:13,fontWeight:900,color:unit.color,letterSpacing:isCurrent?-0.5:0,borderTop:cBt,borderBottom:cBb,verticalAlign:"middle",lineHeight:1}}>
                    {row.final.toFixed(1)}
                    {isCurrent && <span style={{fontSize:11,fontWeight:500,color:`${unit.color}90`,marginLeft:3}}>MW</span>}
                  </td>
                  {/* Desviación */}
                  <td style={{padding:isCurrent?"16px 14px":"7px 10px",textAlign:"right",borderTop:cBt,borderBottom:cBb,borderRight:isCurrent?`2px solid ${unit.color}70`:"none",verticalAlign:"middle"}}>
                    <span style={{display:"inline-block",background:`${dC}${isCurrent?"22":"12"}`,border:`1px solid ${dC}${isCurrent?"55":"28"}`,borderRadius:6,padding:isCurrent?"5px 12px":"2px 7px",fontFamily:MONO,fontSize:isCurrent?14:12,fontWeight:700,color:dC}}>{dev>=0?"+":""}{dev.toFixed(2)}%</span>
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
