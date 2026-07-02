// Prefijo de despliegue. Vite llena `import.meta.env.BASE_URL` con el valor de `base`
// (p. ej. '/dashboard/'). Centralizar el sub-path acá hace que el MISMO build sirva bajo
// cualquier ruta: si algún día `base='/'`, todo vuelve a la raíz sin tocar cada URL.
//
// Regla del reverse proxy: nginx quita el prefijo (barra final en proxy_pass) antes de
// llegar al backend, que compara rutas por string exacto (`/api/...`, `/ws`). Por eso acá
// solo anteponemos el prefijo; el backend nunca ve `/dashboard`.
const BASE = import.meta.env.BASE_URL;

// URL de un endpoint REST bajo el sub-path. `p` empieza con '/', ej. apiUrl('/periods/today').
export const apiUrl = (p) => `${BASE}api${p}`;

// URL del WebSocket del backend (mismo host, esquema auto ws/wss).
export const wsUrl = () =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}ws`;

// Resuelve un asset servido desde public/ bajo el sub-path. Deja intactas las URLs externas
// (http/https) por si una instancia define un logo alojado en otro origen.
export const assetUrl = (p) => {
  if (!p) return p;
  if (/^https?:\/\//.test(p)) return p;
  return `${BASE}${String(p).replace(/^\//, '')}`;
};
