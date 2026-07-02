// Config de instancia en RUNTIME (no build-time).
//
// Por qué runtime y no `import.meta.env`/`vite --mode`: Vite hornea las env en build, lo que
// obligaría a un artefacto distinto por instancia. Sirviendo un `/config.json` aparte del
// bundle, el MISMO build (una sola imagen Docker a futuro) sirve cualquier instancia según el
// archivo que monte cada servidor. Ver docs/deployment-multi-instancia.md.
//
// Los DEFAULTS reproducen exactamente el comportamiento histórico de la instancia `gec3`, así
// que si `/config.json` falta o falla, el dashboard arranca idéntico a como lo hacía antes
// (preserva la propiedad "funciona aunque el backend esté caído").

const DEFAULTS = {
  instance: "gec3",
  unitOrder: ["GEC3", "GEC32", "TGJ1", "TGJ2"],
  defaultUnit: "GEC3",
  bitacoraPlantas: ["GEC3", "GEC32"],
  branding: { title: "Dashboard Generación", logo: "/G3 blanco.png", logoAlt: "Gecelca" },
};

let cfg = DEFAULTS;

// Cargar la config ANTES de montar el árbol React (ver main.jsx). Devuelve siempre una config
// válida; nunca lanza.
export async function loadInstanceConfig() {
  try {
    // Toggle de dev: ?instance=guajira cambia la instancia en vivo (lo resuelve el
    // middleware de vite.config.js). En prod nginx ignora el query string y sirve siempre
    // el instance/config.json del servidor, así que esto no puede forzar otra UI en prod.
    const inst = new URLSearchParams(window.location.search).get("instance");
    // Bajo el sub-path de despliegue, config.json se sirve prefijado (BASE_URL). En prod nginx
    // lo resuelve como alias; en dev lo intercepta el middleware de vite.config.js.
    const base = import.meta.env.BASE_URL;
    const url = inst ? `${base}config.json?instance=${encodeURIComponent(inst)}` : `${base}config.json`;
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) {
      const j = await res.json();
      cfg = {
        ...DEFAULTS,
        ...j,
        branding: { ...DEFAULTS.branding, ...(j.branding || {}) },
      };
    }
  } catch {
    // sin red / 404 / JSON inválido → defaults gec3
  }
  if (cfg.branding?.title) document.title = cfg.branding.title;
  return cfg;
}

// Lectura síncrona de la config ya cargada. Seguro de llamar en module-eval de cualquier
// módulo importado DESPUÉS de loadInstanceConfig() (main.jsx hace import dinámico de Dashboard
// recién tras resolver la carga).
export function getConfig() {
  return cfg;
}
