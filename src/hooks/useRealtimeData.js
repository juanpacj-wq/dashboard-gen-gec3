import { useState, useRef, useEffect, useCallback } from "react";

const WS_URL = typeof location !== 'undefined'
  ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  : 'ws://localhost:3001';
const RECONNECT_MS = 4000;

export function useRealtimeData() {
  const [units, setUnits] = useState([]);
  const [status, setStatus] = useState('connecting');
  const [lastUpdate, setLastUpdate] = useState(null);
  const [accumulated, setAccumulated] = useState({});
  const [minuteAvgs, setMinuteAvgs] = useState({});
  const [completedPeriods, setCompletedPeriods] = useState({});
  const [despachoFinal, setDespachoFinal] = useState({});

  const ws = useRef(null);
  const timer = useRef(null);
  const stopped = useRef(false);

  // Load completed periods and despacho final from REST API on mount
  useEffect(() => {
    fetch('/api/periods/today')
      .then(r => r.ok ? r.json() : [])
      .then(rows => {
        const periods = {};
        for (const row of rows) {
          if (!periods[row.unit_id]) periods[row.unit_id] = {};
          periods[row.unit_id][row.hora] = row.energia_mwh;
        }
        setCompletedPeriods(prev => ({ ...periods, ...prev }));
      })
      .catch(() => {});

    fetch('/api/despacho-final/today')
      .then(r => r.ok ? r.json() : {})
      .then(data => setDespachoFinal(data))
      .catch(() => {});
  }, []);

  const handleMessage = useCallback((msg) => {
    if (msg.type !== 'update') return;

    setUnits(msg.units);
    setLastUpdate(new Date());

    // Server sends accumulated, minuteAvgs, completedPeriods
    if (msg.accumulated) setAccumulated(msg.accumulated);
    if (msg.minuteAvgs) setMinuteAvgs(msg.minuteAvgs);
    if (msg.completedPeriods) {
      setCompletedPeriods(prev => {
        const merged = { ...prev };
        for (const [unitId, hours] of Object.entries(msg.completedPeriods)) {
          merged[unitId] = { ...merged[unitId], ...hours };
        }
        return merged;
      });
    }
    if (msg.despachoFinal) setDespachoFinal(msg.despachoFinal);
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

      socket.onopen = () => setStatus('live');

      socket.onmessage = (e) => {
        try {
          handleMessage(JSON.parse(e.data));
        } catch { /* ignore malformed messages */ }
      };

      socket.onclose = () => {
        if (stopped.current) return;
        setStatus('reconnecting');
        timer.current = setTimeout(connect, RECONNECT_MS);
      };

      socket.onerror = () => socket.close();
    }

    connect();

    return () => {
      stopped.current = true;
      clearTimeout(timer.current);
      ws.current?.close();
    };
  }, [handleMessage]);

  return { units, status, lastUpdate, accumulated, minuteAvgs, completedPeriods, despachoFinal };
}
