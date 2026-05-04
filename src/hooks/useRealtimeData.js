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
  const [minuteDeviations, setMinuteDeviations] = useState({});
  const [completedPeriods, setCompletedPeriods] = useState({});
  const [despachoFinal, setDespachoFinal] = useState({});
  const [projection, setProjection] = useState({});
  const [desviacionPeriodos, setDesviacionPeriodos] = useState({});
  const [proyeccionPeriodos, setProyeccionPeriodos] = useState({});

  const ws = useRef(null);
  const timer = useRef(null);
  const stopped = useRef(false);

  // Snapshots REST: fetched al mount, refresh cada 5min y al reconectar el WS.
  // One-shot on mount no era suficiente — si el backend respondía vacío al cargar
  // (restart, transient), el state quedaba stranded hasta que el usuario hiciera
  // Ctrl+Shift+R manualmente. desviacionPeriodos era el más afectado porque no
  // llega por WS, solo por este path REST.
  const loadSnapshots = useCallback(() => {
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

    fetch('/api/proyeccion/today')
      .then(r => r.ok ? r.json() : {})
      .then(data => {
        // Map snake_case → camelCase fields used by components
        const mapped = {};
        for (const [unitId, snap] of Object.entries(data || {})) {
          mapped[unitId] = {
            fecha: snap.fecha,
            periodo: snap.periodo,
            acumulado: snap.acumulado_mwh,
            currentMw: snap.current_mw,
            redespacho: snap.redespacho_mw,
            projection: snap.proyeccion_mwh,
            deviation: snap.desviacion_pct,
            fraction: snap.fraction,
          };
        }
        setProjection(prev => ({ ...mapped, ...prev }));
      })
      .catch(() => {});

    fetch('/api/proyeccion-periodos/today')
      .then(r => r.ok ? r.json() : {})
      .then(data => setProyeccionPeriodos(data || {}))
      .catch(() => {});

    fetch('/api/desviacion-periodos/today')
      .then(r => r.ok ? r.json() : [])
      .then(rows => {
        const map = {};
        for (const row of rows || []) {
          if (!map[row.unit_id]) map[row.unit_id] = {};
          map[row.unit_id][row.periodo] = {
            generacion_mwh: row.generacion_mwh,
            desp_final_mw: row.desp_final_mw,
            desp_final_source: row.desp_final_source,
            desviacion_pct: row.desviacion_pct,
          };
        }
        setDesviacionPeriodos(map);
      })
      .catch(() => {});
  }, []);

  // Mount + cada 5min (mismo cadence que useXmDispatch / useXmGeneration).
  useEffect(() => {
    loadSnapshots();
    const id = setInterval(loadSnapshots, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [loadSnapshots]);

  // Refresh inmediato al transicionar WS de !live → live (post-restart del backend).
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current !== 'live' && status === 'live') {
      loadSnapshots();
    }
    prevStatusRef.current = status;
  }, [status, loadSnapshots]);

  const handleMessage = useCallback((msg) => {
    if (msg.type !== 'update') return;

    // El backend (ExtractorOrchestrator) envía cada unit con shape:
    // { id, label, valueMW, maxMW, source: 'meter' | 'pme' | null }. Lo propagamos tal cual.
    setUnits(msg.units);
    setLastUpdate(new Date());

    // Server sends accumulated, minuteAvgs, completedPeriods
    if (msg.accumulated) setAccumulated(msg.accumulated);
    if (msg.minuteAvgs) setMinuteAvgs(msg.minuteAvgs);
    if (msg.minuteDeviations) setMinuteDeviations(msg.minuteDeviations);
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
    if (msg.proyeccionPeriodos) {
      setProyeccionPeriodos(prev => {
        const merged = { ...prev };
        for (const [unitId, periods] of Object.entries(msg.proyeccionPeriodos)) {
          merged[unitId] = { ...merged[unitId], ...periods };
        }
        return merged;
      });
    }
    if (msg.projection) {
      // Server sends snake_case; normalize to camelCase
      const mapped = {};
      for (const [unitId, snap] of Object.entries(msg.projection)) {
        mapped[unitId] = {
          fecha: snap.fecha,
          periodo: snap.periodo,
          acumulado: snap.acumulado_mwh,
          currentMw: snap.current_mw,
          redespacho: snap.redespacho_mw,
          projection: snap.proyeccion_mwh,
          deviation: snap.desviacion_pct,
          fraction: snap.fraction,
        };
      }
      setProjection(mapped);
    }
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

  return { units, status, lastUpdate, accumulated, minuteAvgs, minuteDeviations, completedPeriods, despachoFinal, projection, desviacionPeriodos, proyeccionPeriodos };
}
