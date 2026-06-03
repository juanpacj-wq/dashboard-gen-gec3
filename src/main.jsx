import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { loadInstanceConfig } from './config/instance'

// Cargamos la config de instancia ANTES de importar Dashboard. El import dinámico garantiza
// que toda la cadena de módulos (units.js, hooks) evalúe con getConfig() ya poblado, porque
// units.js computa el orden de UNITS en module-eval. Ver src/config/instance.js.
loadInstanceConfig()
  .then(() => import('./Dashboard.jsx'))
  .then((mod) => {
    const Dashboard = mod.default
    createRoot(document.getElementById('root')).render(
      <StrictMode>
        <Dashboard />
      </StrictMode>,
    )
  })
