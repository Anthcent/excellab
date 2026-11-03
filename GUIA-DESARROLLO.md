# GridLab: guía de desarrollo

Esta guía explica cómo está construido el simulador y cómo convertir un botón "simulado" de la cinta de opciones en una función real. El ejemplo completo es el **Filtro** (Datos > Filtro), que ya funciona y sirve de modelo para los demás botones.

---

## 1. Archivos del proyecto

| Archivo | Para qué sirve |
| --- | --- |
| `src/style.css` | Todo el CSS. |
| `src/body.html` | El HTML de la aplicación (cinta, barra de fórmulas, cuadrícula, diálogos). |
| `src/engine.js` | Motor de fórmulas, **sin DOM**: direcciones, valores, parser, evaluación y biblioteca de funciones. Lo usa el navegador (`window.GridEngine`) y el servidor (para calificar). |
| `src/app.js` | La interfaz: cuadrícula, edición, cinta, teclado, modo teléfono. Usa el motor. |
| `src/lab-core.js` | Lógica **pura** del laboratorio (rutas hash, enlaces `?exam=`, reloj del servidor, autoguardado con debounce, verificaciones ⇄ API, validación de formularios, Markdown-lite, bloques del examen ⇄ API, lista de requisitos, contraseñas, geometría de gráficos). Sin DOM; tiene pruebas en `server/test/labcore.test.ts`. |
| `src/lab.js` | Interfaz del laboratorio: barra superior, enrutador, ingreso/registro, cambio de contraseña obligatorio y perfil, exámenes, instrucciones, examen en curso (con la pestaña de instrucciones) y revisión. Solo arranca si responde `GET /api/auth/me`. Expone `window.LabApp`. |
| `src/lab-staff.js` | Consola del personal: barra lateral, panel, usuarios, banco de ejercicios, lista de exámenes, analíticas y resultados. Publica helpers compartidos en `LabApp.ui`. |
| `src/lab-admin.js` | Editor de ejercicios (con dificultad, etiquetas, minutos y categoría), hoja inicial y detalle de intento. |
| `src/lab-exam.js` | Constructor de exámenes (pestañas, secciones, banco, sorteo simulado, acceso e intentos extra, lista de requisitos). |
| `src/lab.css` | Estilos del laboratorio (usa las variables de color del simulador). |
| `src/template.html` | Plantilla del documento (`doctype`, `<head>`, favicon, metadatos). |
| `scripts/build.mjs` | Une todo en un solo HTML (ver la sección 10). |
| `index.html` | **Generado.** Documento completo que se abre con doble clic o se sube a cualquier hosting. |
| `gridlab.html` | **Generado.** Fragmento sin `<!doctype>`, `<html>` ni `<body>` para publicar como artifact (el publicador los agrega). |
| `public/index.html` | **Generado** (no se sube a Git). Lo sirve el servidor. |
| `server/` | API (Fastify + TypeScript): login, ejercicios, exámenes y calificación. Ver `README.md`. |
| `GUIA-DESARROLLO.md` | Esta guía. |

**No edites `index.html` ni `gridlab.html` a mano**: se sobrescriben con `npm run build:site`. El sitio no usa frameworks. Solo carga desde Google Fonts la fuente de íconos Material Symbols, que usa el tema Blanco; si no se puede cargar (sin conexión), la página sigue funcionando y los íconos se muestran como texto pequeño.

## 2. Mapa del código

El código está dividido en secciones con comentarios de este tipo: `/* ================= Nombre ================= */`. Puedes buscar cada nombre con Ctrl+F.

**`src/engine.js`** (sin DOM; se usa igual en el navegador y en Node):

| Sección | Qué contiene |
| --- | --- |
| Addressing | Conversión entre `A1` y fila/columna: `A(r,c)`, `parseA('B4')`. |
| Values | Tipos de valor, errores (`E.div()`, `E.val()`…), conversión de texto a número, `cmp`. |
| Formula parser | Convierte el texto de una fórmula en un árbol (`parseFormula`). |
| Evaluation | Calcula las celdas (`cellValue`) con caché y detección de referencias circulares. Una referencia fuera de la hoja (más allá de `COLS`/`ROWS`) da `#¡REF!`. |
| Function library | Todas las funciones de fórmula, definidas con `def(...)`. |
| Display formatting | Cómo se ve un valor según su formato (moneda, %, fecha…). |
| Engine helpers | `recalc`, `setWorkbook`, `evalFormulaText`; `sanitizeWorkbook` (validador de libros, también lo usa el servidor). |

El motor **no tiene variables globales**: cada instancia guarda su estado en `S` (`S.wb` libro, `S.cur` hoja activa, `S.DEC` separador decimal):

```js
const eng = GridEngine.createEngine({ workbook, decimal: ',' });
eng.cellValue(0, 1, 2);                 // hoja 0, fila 1, columna C (índices desde 0)
eng.evalFormulaText('=SUMA(A1:A3)', 0);
```

En `app.js` ese objeto es `ST` (`ST.wb`, `ST.cur`, `ST.DEC`); el resto de nombres del motor se traen con una desestructuración al inicio del archivo. **Si usas en `app.js` una función nueva del motor, agrégala a esa lista** (y expórtala al final de `engine.js`).

**`src/app.js`** (interfaz):

| Sección | Qué contiene |
| --- | --- |
| Preferences | Tema (`prefs.skin`), separador decimal, modo teléfono. |
| Workbook state | Libro de ejemplo, guardado en `localStorage` (con versión `SCHEMA` y validación al cargar), deshacer/rehacer. |
| Grid / Overlay | Dibujo de la cuadrícula, la selección y las referencias de color. |
| Editing | Edición de celdas, autocompletado, modo Señalar, F4. |
| Clipboard, fill, sort | Copiar, pegar, rellenar, ordenar. |
| Formatting | Negrita, bordes, estilos de celda, autoajuste. |
| Actions | **El mapa `ACTIONS`: aquí se conecta cada botón con su función.** |
| Excel-style colored icons | Íconos SVG a color del tema Excel (mapa `XI`). |
| Ribbon | **La definición de la cinta (`RIBBON`) y de los menús (`MENUS`).** |
| Popups / Insert Function dialog / Backstage | Menús, paleta de colores, cuadro Insertar función, menú Archivo. |
| Phone mode | Modo teléfono: cinta flotante, barra de acciones y teclado GridLab. |
| Keyboard | Atajos de teclado de Excel en español. |
| Boot | Arranque. |

### Integración del simulador con el laboratorio (`window.Lab`)

Al final de `app.js` se expone una API pequeña que usa `lab.js`; el simulador sigue funcionando igual sin ella:

| Función | Qué hace |
| --- | --- |
| `Lab.loadWorkbook(wb, {readOnly, title})` | Carga un libro en la cuadrícula sin tocar el libro de práctica ni su `localStorage` (el de práctica queda guardado en memoria). |
| `Lab.getWorkbook()` | Libro actual como JSON (confirma antes la celda que se esté editando). |
| `Lab.setReadOnly(bool)` | Modo solo lectura: bloquea editor, teclado, pegar, cinta, menús, relleno, ancho de columnas y hojas. |
| `Lab.onChange(cb)` | Avisa de cada cambio del libro; devuelve la función para cancelar. No se dispara con `loadWorkbook`. |
| `Lab.resetToPractice()` | Vuelve al libro de práctica libre. |
| `Lab.refresh()`, `Lab.setSaveLabel(t)`, `Lab.toast(t)` | Reajustar el dibujo al volver a mostrar el simulador, texto del estado de guardado y aviso breve. |

Reglas para quien modifique `app.js`: toda función que cambie datos debe llamar primero a `pushUndo()` (en solo lectura lanza `RO_BLOCK` y nada se modifica); lo que no cambie datos, pero se ejecute desde la cinta, debe agregarse a `RO_SAFE` para seguir disponible en solo lectura. `save()` no escribe en `localStorage` mientras haya un libro de examen cargado (`persist=false`).

## 3. Modelo de datos

```js
ST.wb = {
  name: 'Libro1',
  sheets: [
    {
      name: 'Ventas',
      cells: {
        A1: { v: 'Producto', s: { b: true, fill: '#196B24', color: '#FFFFFF' } },
        E2: { v: '=C2*D2',   s: { fmt: 'currency' } },
      },
      colW: { 0: 92 },          // ancho de columna en px (0 = columna A)
      sel: { ar, ac, fr, fc },  // selección guardada de la hoja
      hiddenRows: [3, 5],       // filas ocultas (las usa el filtro)
    },
  ],
};
```

- **`v`** es el contenido crudo de la celda. Se guarda en formato **canónico**: punto decimal y coma entre argumentos (`=SI(A1>1.5,"Sí","No")`). La barra de fórmulas lo muestra en el formato regional que elija el usuario, con `toLocalFormula()` y `toCanonFormula()`.
- **`s`** es el estilo. Claves: `b`, `i`, `u`, `st` (tachado), `font`, `size`, `color`, `fill`, `ha` (left/center/right), `va` (top/middle/bottom), `wrap`, `ind` (sangría), `fmt`, `dec` (decimales), `bt`/`bb`/`bl`/`br` (bordes).
- **`str: 1`** marca un texto que, de otro modo, se leería como número.
- **`ST.cur`** es el índice de la hoja activa y **`sheet()`** devuelve esa hoja (el libro es `ST.wb`).
- **`sel`** es la selección: `sel.ar`/`sel.ac` son la celda activa y `rng()` devuelve el rango `{r1,c1,r2,c2}`.

Filas y columnas empiezan en **0**: la fila 0 es la fila 1 de la hoja y la columna 0 es la columna A.

## 4. Cómo funciona un botón de la cinta

Cada botón se declara dentro de `const RIBBON` con una de estas tres ayudas:

```js
B(icono, 'Texto', 'accion', opciones)  // botón grande (ícono arriba, texto abajo)
S(icono, 'Texto', 'accion', opciones)  // botón chico con texto
I(icono, 'Texto', 'accion', opciones)  // solo ícono (el texto se usa como descripción)
```

- **icono**: nombre de un ícono de Material Symbols (tema Blanco). Si existe un dibujo con ese nombre en `XI`, el tema Excel muestra el dibujo a color.
- **accion**: nombre de la función en `ACTIONS`. Si vale `null`, el botón muestra el aviso "todavía no está disponible".
- **opciones** (todas opcionales):
  - `menu: 'id'`: abre el menú `MENUS.id`. Con `split: true`, el botón ejecuta la acción y la flechita abre el menú.
  - `tog: 'b'`: el botón se ve "presionado" cuando se cumple esa condición (se resuelve en `updateRibbonState()`).
  - `chk: 'gridlines'`: casilla de verificación conectada a `view`.
  - `x: 'clave'`: usa el dibujo `XI.clave` del tema Excel en lugar del que corresponde al nombre del ícono.
  - `txt: 'N'`: muestra un texto en lugar de un ícono.
  - `arg: valor`: valor que se pasa a la acción.
  - `tip: 'Texto'`: descripción emergente distinta del texto del botón.

Los grupos se arman con `G('Nombre', ...)`. Si usas `GL('Nombre', ...)`, el grupo lleva además el botón ↘ de configuración en la esquina.

Al pulsar un botón se ejecuta `run(accion, texto, arg)`, que busca `ACTIONS[accion]` y la llama.

## 5. Pasos para habilitar un botón

1. **Ubica el botón.** Busca su texto en `const RIBBON`, por ejemplo `'Quitar duplicados'`.
2. **Ponle una acción.** Cambia `null` por un nombre: `S('layers_clear','Quitar duplicados','removeDups')`.
3. **Escribe la función.** Ponla cerca de las demás, por ejemplo antes de `const EDIT_SAFE`. Respeta este orden:
   1. Valida y avisa con `toast('...')` si falta algo.
   2. Llama a `pushUndo()` **antes** de modificar cualquier dato, para que funcione Ctrl+Z.
   3. Modifica `sheet().cells` o lo que corresponda.
   4. Llama a `changed()` al final: recalcula, redibuja, actualiza la cinta y guarda.
4. **Regístrala** en `const ACTIONS`: `removeDups,` o `removeDups: () => removeDups(),`.
5. **Si es un estado activado/desactivado**, agrega `{tog:'clave'}` al botón y resuelve la clave en `updateRibbonState()`, como ya se hace con `'filter'` y `'showFormulas'`.
6. **Si está en un menú**, agrega `a:'removeDups'` a la opción correspondiente en `MENUS`.
7. **Prueba**: en PC (clic, Ctrl+Z, recargar la página) y en un teléfono horizontal (la cinta se abre desde una pestaña y se cierra sola después de la acción).
8. **Compila de nuevo** con `npm run build:site` (sección 10).

En la aplicación, **Archivo > Desarrollo** muestra cuántos botones tienen función real. El botón *Resaltar los botones sin función* les pone un borde rojo punteado para encontrarlos rápido.

## 6. Ejemplo completo: el Filtro

**Objetivo**: en una tabla, mostrar solo las filas que tienen en una columna el mismo valor que la celda seleccionada.

**Paso 1, soporte para ocultar filas** (ya incluido). Cada hoja puede tener `hiddenRows`. Esta función oculta esas filas y se llama dentro de `changed()`:

```js
const hiddenSet = () => new Set(sheet().hiddenRows || []);
function applyRowVisibility(){
  const h = hiddenSet();
  rowEls.forEach((tr, r) => { const v = h.has(r) ? 'none' : ''; if (tr.style.display !== v) tr.style.display = v; });
}
```

Además, `move()` salta las filas ocultas al moverse con las flechas.

**Paso 2, la lógica** (`filterToggle` y `filterClear`):

```js
function filterToggle(){
  const sh = sheet();
  if ((sh.hiddenRows || []).length) return filterClear();   // si ya hay filtro, lo quita
  const R = region(sel.ar, sel.ac);                          // tabla alrededor de la celda activa
  if (R.r1 === R.r2) return toast('Selecciona una celda dentro de una tabla con datos.');
  if (sel.ar === R.r1) return toast('Selecciona una celda con datos (no el encabezado) para filtrar por ese valor.');
  const target = cellValue(ST.cur, sel.ar, sel.ac);
  pushUndo();
  sh.hiddenRows = [];
  for (let r = R.r1 + 1; r <= R.r2; r++)                     // R.r1 es el encabezado
    if (cmp(cellValue(ST.cur, r, sel.ac), target) !== 0) sh.hiddenRows.push(r);
  changed();
  toast(`Filtro aplicado: se ocultaron ${sh.hiddenRows.length} filas.`);
}

function filterClear(){
  const sh = sheet();
  if (!(sh.hiddenRows || []).length) return toast('No hay ningún filtro aplicado.');
  pushUndo(); sh.hiddenRows = []; changed(); toast('Se quitó el filtro.');
}
```

**Paso 3, conectarlo a la cinta y al menú:**

```js
// En RIBBON, pestaña Datos:
B('filter_alt','Filtro','filterToggle',{tog:'filter'}),
S('filter_alt_off','Borrar','filterClear'),

// En MENUS.sort (Inicio > Ordenar y filtrar):
{ic:'filter_alt', l:'Filtro', a:'filterToggle'},
{ic:'filter_alt_off', l:'Borrar', a:'filterClear'},

// En ACTIONS:
filterToggle, filterClear,

// En updateRibbonState(), para que el botón se vea presionado:
else if (t === 'filter') on = !!(sheet().hiddenRows || []).length;
```

**Cómo llevarlo al estilo de Excel** (flechitas ▾ en el encabezado con casillas por valor):

1. Guarda el filtro como objeto en la hoja: `sh.filter = { r1, c1, r2, c2, ocultos: { 2: ['Audio'] } }` (columna → valores ocultos).
2. Escribe `recalcFilter()`, que recorra las filas `r1+1..r2` y llene `sh.hiddenRows` cuando el valor de una columna esté en `ocultos`.
3. Dibuja un botón ▾ por cada celda del encabezado dentro de `#overlay` (como `#handle`), con `pointer-events:auto`. Posiciónalo con `rectOf(r1, c, r1, c)` dentro de `drawSel()`.
4. Al tocarlo, arma con `showMenu()` (o con HTML propio en `#popup`) la lista de valores únicos de la columna con casillas, más "Ordenar de A a Z", "Ordenar de Z a A", "Aceptar" y "Cancelar".
5. Al aceptar: `pushUndo()`, actualiza `ocultos`, `recalcFilter()`, `changed()`.

## 7. Agregar una función de fórmula

Todas las funciones viven en `src/engine.js` (sección *Function library*) y se declaran con `def`:

```js
def(nombreIngles, nombreEspanol, categoria, 'argumentos, separados, por coma', 'Descripción.', implementacion);

// Ejemplo: SIGNO
def('SIGN','SIGNO',MATH,'número','Devuelve el signo de un número: 1 si es positivo, 0 si es cero y -1 si es negativo.',
    a => Math.sign(N(a[0])));
```

- **Categorías**: `MATH`, `STAT`, `LOGIC`, `LOOK`, `TEXT`, `DATE`, `INFO`, `FIN`.
- **`a`** es la lista de argumentos ya calculados. Para leerlos:
  - `N(a[i], valorPorDefecto)` → número.
  - `Str(a[i])` → texto.
  - `Bool(a[i])` → verdadero/falso.
  - `Arr2(a[i])` → rango como matriz 2D.
  - `nums(a)` → todos los números de los argumentos.
  - `makeCrit(a[i])` → criterio tipo `">5"` (como en CONTAR.SI).
- **Errores**: lanza `throw E.div()`, `E.val()`, `E.ref()`, `E.na()` o `E.num()`. Se muestran como `#¡DIV/0!`, `#¡VALOR!`, etc.
- Como el motor es el mismo en el navegador y en el servidor, una función nueva también queda disponible para calificar ejercicios. Agrega una prueba en `server/test/engine.test.ts`.
- Con solo declararla, la función aparece en el autocompletado, en Insertar función y en el menú de su categoría.

## 8. Íconos

- **Tema Blanco**: usa el nombre del ícono de Material Symbols (<https://fonts.google.com/icons>).
- **Tema Excel**: agrega un dibujo al mapa `XI` con ese mismo nombre, o uno con otro nombre que asignas con `{x:'nombre'}`. Se dibuja en una cuadrícula de 32×32. Clases disponibles:
  - `class="k"`: línea en el color de tinta del tema.
  - `class="p"`: relleno de "papel" con borde de tinta.
  - `class="kf"`: relleno de tinta.
  - `class="t"`: texto.
  - Colores fijos: `BL` azul, `LB` azul claro, `GR` verde, `RD` rojo, `YL` amarillo, `OR` naranja.

```js
XI.mi_icono = `<rect x="3" y="3" width="26" height="26" class="p"/><path d="M8 16h16" stroke="${BL}" stroke-width="3"/>`;
```

## 9. Teléfono y teclado GridLab

- El **modo teléfono** se activa con pantalla táctil de menos de 540 px de alto o menos de 760 px de ancho. Está pensado sobre todo para el teléfono en horizontal. Para cambiar esos límites, edita `phoneMQ`.
- Las teclas del teclado propio están en `KB_NUM` (panel 123), `abcKeys()` (panel ABC), `KB_FNS` (panel fx) y `KB_SIDE` (columna derecha). Cada tecla es `[valor, etiqueta, clases]`.
- El comportamiento de cada tecla está en `kbPress()`. Valores especiales: `SEP` (separador de argumentos), `DEC` (separador decimal), `F4`, `SUM`, `BS`, `OK`, `TAB`, `ESC`.
- El alto de las teclas se controla con la variable CSS `--kh`: 33 px en horizontal y 42 px en vertical.
- La barra de acciones rápidas (`#pbar`) es HTML. Para agregar un botón, pon un `data-pa="accion"`: si coincide con una clave de `ACTIONS`, se ejecuta sola.

## 10. Compilar y publicar

Edita solo los archivos de `src/` (`style.css`, `lab.css`, `body.html`, `engine.js`, `app.js`, `lab-core.js`, `lab.js`, `lab-staff.js`, `lab-admin.js`, `lab-exam.js`, `template.html`). El orden de los scripts del laboratorio está en `scripts/build.mjs` (`lab-core` → `lab` → `lab-staff` → `lab-admin` → `lab-exam`); si agregas un archivo nuevo, inclúyelo ahí. Después, dentro de la carpeta `excellab`, ejecuta:

```bash
npm run build:site     # solo la página (no necesita nada más que Node)
npm run build          # la página + el servidor (TypeScript)
```

`scripts/build.mjs` une todo en un solo HTML y escribe tres archivos:

| Salida | Uso |
| --- | --- |
| `index.html` | Documento completo (con `<!doctype>`, `lang="es"`, favicon y metadatos). Se abre con doble clic, sin servidor, y funciona igual que antes (práctica libre sin login). Se sube a Git. |
| `public/index.html` | La misma página, servida por el servidor Fastify. No se sube a Git. |
| `gridlab.html` | Fragmento sin `<!doctype>`, `<html>`, `<head>` ni `<body>` para publicar como artifact. Se sube a Git. |

Como el navegador abre `index.html` con `file://`, el motor y la interfaz van en `<script>` normales (nada de `type="module"`). Si trabajas con Claude Code, pídele que vuelva a publicar `gridlab.html` en el mismo artifact para conservar el link.

**Antes de subir cambios**: `npm run build:site` (para que `index.html` y `gridlab.html` reflejen `src/`) y `npm test` (pruebas del motor y del servidor).

## 11. Qué funciona hoy y qué es simulado

**Funciona**:
- Edición y fórmulas (más de 90 funciones), referencias relativas y absolutas (F4) y modo Señalar.
- Copiar, cortar, pegar (también solo valores o solo formato), copiar formato, rellenar (controlador, Ctrl+J, Ctrl+D) y series.
- Fuente, tamaño, N/K/S, tachado, colores, bordes, alineación, sangría, ajustar texto.
- Formatos de número, decimales, estilos de celda, dar formato como tabla.
- Autosuma, Insertar función, menús de funciones por categoría.
- Ordenar de A a Z / Z a A, **Filtro**, Mostrar fórmulas, Rastrear precedentes.
- Zoom, líneas de cuadrícula, encabezados, barra de fórmulas.
- Hojas: agregar, cambiar nombre, duplicar, eliminar.
- Temas Excel y Blanco, separador decimal, deshacer/rehacer y guardado automático.

**Simulado** (muestra el aviso "todavía no está disponible"):
- Formato condicional, combinar celdas, insertar/eliminar filas y columnas.
- Gráficos, tablas dinámicas, imágenes y formas, comentarios.
- Validación de datos, quitar duplicados, texto en columnas.
- Proteger, inmovilizar paneles, impresión, abrir y exportar archivos.

Buenos candidatos para empezar, de menor a mayor dificultad:
1. **Quitar duplicados**: recorre las filas del rango, compara con `cmp` y borra las repetidas.
2. **Inmovilizar fila superior**: con `position: sticky` en la primera fila de datos.
3. **Insertar fila**: desplaza las celdas hacia abajo y ajusta las referencias de las fórmulas con `shiftFormula` (solo las que apuntan debajo de la fila insertada).
4. **Formato condicional básico**: una regla por rango, evaluada en `paintCell()`.

## 12. Servidor: roles, bloques y migraciones

El contrato completo de la API (matriz de roles, ajustes del examen y semántica de `resultMode`) está en `README.md`. Lo que conviene saber al tocar el servidor:

- **Roles y propiedad.** `student`, `teacher`, `admin`. Las guardas están en `server/src/http/guards.ts` (`requireUser`, `requireStaff`, `requireAdmin`). El contenido de un profesor se filtra con `ownerScope(user)`: devuelve `undefined` para el admin (sin filtro) y el id del profesor en otro caso; todas las consultas del personal lo aplican y lo ajeno responde 404, nunca 403.
- **Bloques y sorteo.** La estructura vive en `exam_blocks` y `exam_block_exercises` (`exams/service.ts`: `loadStructure`, `replaceBlocks`, `prepareDraw`). El sorteo puro y determinista por semilla está en `attempts/random.ts` (`drawBlocks`), así que se prueba sin base de datos. Al iniciar un intento se guarda una instantánea (`attempts.exercise_meta`) con el título del bloque y el `points_override` de cada ejercicio; la calificación lee esa instantánea, no la definición actual del examen.
- **Visibilidad de notas.** Toda respuesta al estudiante que contiene notas pasa por `resultsVisible` y por las banderas de `feedbackMode`/`allowReview` en `attempts/service.ts`. Si agregas un campo con la nota, respeta esas reglas o filtrará información en exámenes `hidden`/`after_close`.
- **Migraciones.** Aditivas y numeradas: no edites una publicada, agrega `003_…sql`. Cada archivo corre en una transacción y debe funcionar tanto en PGlite como en Postgres (SQL plano, sin extensiones). La prueba «migration 002» de `server/test/exam-builder.test.ts` parte del esquema de la `001` con datos y aplica el resto; haz lo mismo para cada migración que transforme datos.
- **Pruebas.** `staff.test.ts` (roles, usuarios, aislamiento entre profesores, banco de ejercicios), `exam-builder.test.ts` (bloques, ajustes, migración), `analytics.test.ts` (estadísticas, análisis y CSV), `random.test.ts` (sorteo puro).

## 13. Interfaz del laboratorio: convenciones

- **Sin HTML de usuario.** Todo se construye con `h(tag, props, ...hijos)`: los textos son nodos de texto, nunca `innerHTML`. Las instrucciones de exámenes pasan por `LabCore.parseMarkdownLite` (devuelve *tokens* de solo texto) y `LabApp.renderMd` (los convierte en elementos). No agregues soporte para enlaces o HTML sin revisar esa garantía; hay pruebas de XSS en `labcore.test.ts` y `lab-flow.test.ts`.
- **Nombres de clases.** `style.css` define clases del simulador con nombres cortos (`.tile`, `.ov`, `.lead`, `.mh`…). Las pantallas del laboratorio usan prefijos propios (`kpi`, `pts-in`, `xlead`, `pm-head`, `st-*`, `xb-*`, `blk-*`); antes de crear una clase genérica, búscala en `style.css`.
- **Consola del personal.** Cada pantalla llama a `LabApp.ui.staffMain(ctx, clave)`, que dibuja la barra lateral y devuelve la columna principal. Las pantallas que usan el simulador (hoja inicial, detalle de intento, revisión) no llevan barra lateral.
- **Acceso por ruta.** `access` en `ROUTES` (`lab-core.js`): `public`, `user`, `admin` (= personal: profesor o administrador) y `sysadmin` (solo administrador). El servidor es quien decide; el cliente solo oculta lo que no corresponde.
- **Pestaña de instrucciones.** `createInstructionsDock(attemptId)` en `lab.js`: elementos `#instrTab` y `#instrCard` en `document.body` mientras dura el intento; clase `is-open` en la pestaña, `aria-expanded`/`aria-controls`, `role="dialog"` con `aria-modal="false"` y preferencia en `sessionStorage` (`gridlab.instr.<intento>`).
- **Cómo revisar lo visual.** jsdom no calcula diseño: revisa a mano con un navegador a 1280×800 y 390×844 las pantallas que cambies.
