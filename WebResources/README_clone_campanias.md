# Clonación de Campañas Analíticas (Web Resource)

Este recurso web (`tema_litogl_ws_clone_campanias.js`) implementa la clonación de una campaña analítica y de sus registros relacionados (1:N) directamente desde la vista de listado.

## Cómo vincularlo al botón "Clonar"

1. Importe el archivo `tema_litogl_ws_clone_campanias.js` como Web Resource (tipo `Script`) en su entorno Dataverse.
2. Edite el comando del botón en el App Module `tema_LitoGlGestionLaboratorios` para la entidad `tema_litogl_tp_campaniasanalitica`:
   - Establezca `OnClick` a la función `EjecutarFlujoDesdeBoton`.
   - Seleccione el Web Resource recién importado como biblioteca de comandos.
   - Mantenga la visibilidad (Visible) como está o restrinja a "exactamente una fila seleccionada".
3. Publique las personalizaciones.

## Comportamiento

- Al pulsar el botón, si hay exactamente una campaña seleccionada, se crea un nuevo registro de `tema_litogl_tp_campaniasanalitica` copiando los campos aptos para creación/actualización.
- Posteriormente, el script identifica todas las relaciones 1:N donde la campaña es el padre y duplica los hijos, re-vinculándolos al nuevo registro de campaña.
- El proceso se realiza de forma genérica consultando los metadatos de Dataverse, evitando copiar campos de estado (`statecode`, `statuscode`) y valores de sólo lectura.

## Consideraciones

- Asociaciones N:N (p. ej., membresías de equipos) no se replican en esta primera versión. Si necesita duplicarlas, se puede extender con operaciones de `Associate` sobre las relaciones N:N relevantes.
- El propietario (`ownerid`) no se fuerza; el nuevo registro quedará asignado al usuario actual salvo que se configure lo contrario.
- Si existen Flujos que crean equipos/recursos al crear una campaña, se recomienda mantenerlos para que se ejecuten con la nueva campaña clonada.

## Requisitos de seguridad

El usuario debe tener permisos de lectura sobre la campaña original y de creación en las entidades involucradas (campaña y tablas hijas).

## Pruebas sugeridas

1. Seleccionar una campaña con registros en "Paquetes por Campaña" y verificar que se duplica todo y queda vinculado a la nueva campaña.
2. Revisar que los campos calculados o de estado no bloquean la creación.
3. Confirmar que el botón se habilita sólo con una selección y que muestra mensajes de error claros.