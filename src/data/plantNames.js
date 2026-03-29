import plantNamesRaw from "../../Nombre_unidades_y_su_código.json";

const _plantNamesArr = plantNamesRaw[Object.keys(plantNamesRaw)[0]] || [];
export const PLANT_NAME_MAP = Object.fromEntries(
  _plantNamesArr
    .filter(e => e.codsic_planta != null && e.recurso_ofei != null)
    .map(e => [e.codsic_planta.trim(), e.recurso_ofei.trim()])
);
