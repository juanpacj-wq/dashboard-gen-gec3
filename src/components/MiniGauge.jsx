import { useState, useEffect } from "react";
import { C, FONT, MONO } from "../theme";

export function MiniGauge({ value, max, color, size, displayValue, displayUnit }) {
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
      <text x={cx} y={cy-1} textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize={size*(displayValue!=null?0.16:0.19)} fontWeight="800" fontFamily={FONT}>{displayValue!=null?(pct>0?(anim/pct*displayValue).toFixed(1):"0.0"):Math.round(anim)}</text>
      <text x={cx} y={cy+size*0.09} textAnchor="middle" dominantBaseline="central" fill={C.textMuted} fontSize={size*0.06} fontFamily={MONO}>{displayUnit||"%CAP"}</text>
    </svg>
  );
}
