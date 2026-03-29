import { useState, useRef, useEffect, useCallback } from "react";

const WS_URL = typeof location !== 'undefined'
  ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  : 'ws://localhost:3001';
const RECONNECT_MS = 4000;

export function useRealtimeData() {
  const [units, setUnits] = useState([]);
  const [status, setStatus] = useState('connecting');
  const [lastUpdate, setLastUpdate] = useState(null);
  // Accumulated MWh per unit for the current hour period
  const [accumulated, setAccumulated] = useState({});
  // Per-minute average MW for the current hour: { unitId: [{ avg, count }, ...×60] }
  const [minuteAvgs, setMinuteAvgs] = useState({});
  // Completed periods: { unitId: { [periodIdx]: mwh } }
  const [completedPeriods, setCompletedPeriods] = useState({});

  const ws = useRef(null);
  const timer = useRef(null);
  const stopped = useRef(false);
  // Per-unit integration state: { lastMW, lastTime, mwh, hour }
  const integrators = useRef({});
  // Per-unit per-minute buckets: { unitId: { hour, buckets: [{ sum, count }, ...×60] } }
  const minuteBuckets = useRef({});
  // Snapshot of completed periods in ref (to build state updates)
  const completedRef = useRef({});

  const handleUpdate = useCallback((msgUnits) => {
    const now = Date.now();
    const d = new Date();
    const currentHour = d.getHours();
    const currentMinute = d.getMinutes();
    const acc = {};
    const mins = {};

    for (const u of msgUnits) {
      const prev = integrators.current[u.id];
      const mw = u.valueMW ?? 0;

      // --- Energy accumulator (trapezoidal) ---
      if (!prev || prev.hour !== currentHour) {
        // Hour changed: save previous period's accumulated MWh
        if (prev && prev.hour !== currentHour && prev.mwh > 0) {
          const prevIdx = prev.hour; // hour 0-23 maps to periodIdx 0-23
          if (!completedRef.current[u.id]) completedRef.current[u.id] = {};
          completedRef.current[u.id][prevIdx] = Math.round(prev.mwh * 10) / 10;
        }
        integrators.current[u.id] = { lastMW: mw, lastTime: now, mwh: 0, hour: currentHour };
        acc[u.id] = 0;
      } else {
        const dtHours = (now - prev.lastTime) / 3_600_000;
        const areaMWh = ((prev.lastMW + mw) / 2) * dtHours;
        const newMWh = prev.mwh + areaMWh;
        integrators.current[u.id] = { lastMW: mw, lastTime: now, mwh: newMWh, hour: currentHour };
        acc[u.id] = Math.round(newMWh * 10) / 10;
      }

      // --- Per-minute average buckets ---
      let mb = minuteBuckets.current[u.id];
      if (!mb || mb.hour !== currentHour) {
        mb = { hour: currentHour, buckets: Array.from({ length: 60 }, () => ({ sum: 0, count: 0 })) };
        minuteBuckets.current[u.id] = mb;
      }
      mb.buckets[currentMinute].sum += mw;
      mb.buckets[currentMinute].count += 1;

      // Build minute averages array (null for minutes with no data)
      mins[u.id] = mb.buckets.map(b => b.count > 0 ? Math.round((b.sum / b.count) * 10) / 10 : null);
    }

    setAccumulated(acc);
    setMinuteAvgs(mins);
    setCompletedPeriods({ ...completedRef.current });
    setUnits(msgUnits);
    setLastUpdate(new Date());
  }, []);

  useEffect(() => {
    stopped.current = false;

    function connect() {
      if (stopped.current) return;

      let socket;
      try {
        socket = new WebSocket(WS_URL);
      } catch {
        setStatus('reconnecting');
        timer.current = setTimeout(connect, RECONNECT_MS);
        return;
      }
      ws.current = socket;

      socket.onopen = () => {
        setStatus('live');
      };

      socket.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'update') {
            handleUpdate(msg.units);
          }
        } catch { /* ignore malformed messages */ }
      };

      socket.onclose = () => {
        if (stopped.current) return;
        setStatus('reconnecting');
        timer.current = setTimeout(connect, RECONNECT_MS);
      };

      socket.onerror = () => {
        socket.close();
      };
    }

    connect();

    return () => {
      stopped.current = true;
      clearTimeout(timer.current);
      ws.current?.close();
    };
  }, [handleUpdate]);

  return { units, status, lastUpdate, accumulated, minuteAvgs, completedPeriods };
}
