# Foliux PDF

Lector y editor de PDF de escritorio (Electron + React + TypeScript). **Estado: Fases 1 a 8 implementadas** (lector, anotaciones, edición, seguridad, formularios y firmas, OCR y conversión, asistente de IA y espacios de trabajo).

## Requisitos

- Node.js 20 o superior (probado con 24) y npm
- Git

## Comandos

| Comando             | Qué hace                                                        |
| ------------------- | --------------------------------------------------------------- |
| `npm install`       | Instala dependencias de todos los workspaces                    |
| `npm run dev`       | Abre la aplicación con recarga en caliente                      |
| `npm run build`     | Compila main, preload y renderer en `apps/desktop/out`          |
| `npm test`          | Pruebas unitarias (Vitest)                                      |
| `npm run test:e2e`  | Compila y ejecuta las pruebas de extremo a extremo (Playwright) |
| `npm run typecheck` | Comprueba tipos en todos los workspaces                         |
| `npm run lint`      | ESLint                                                          |
| `npm run format`    | Prettier                                                        |
| `npm run dist`      | Genera el instalador NSIS en `apps/desktop/dist`                |

La prueba de humo de la app empaquetada (`FOLIUX_PACKAGED=1 npx playwright test tests/e2e/packaged.spec.ts`) se ejecuta
tras `npm run dist`.

> Si lanzas la aplicación desde un programa basado en Electron (por ejemplo, algunos terminales integrados),
> la variable `ELECTRON_RUN_AS_NODE` puede impedir que se abra la ventana: elimínala (`unset ELECTRON_RUN_AS_NODE`).

## Estructura

```
apps/desktop/main        Proceso principal: ventana, IPC validado con Zod, protocolo foliux://, registro
apps/desktop/preload     Puente seguro (contextBridge) con la API mínima que usa la interfaz
apps/desktop/renderer    React: componentes, stores (Zustand), comandos, i18n
packages/core            Tipos, errores, interfaces de los servicios y contrato IPC
packages/services        Motor PDF (PDF.js), edición (pdf-lib: anotaciones y páginas), búsqueda, recientes, ajustes
tests                    Vitest (unit) y Playwright (e2e)
```

## Atajos principales

`Ctrl+O` abrir · `Ctrl+W` cerrar pestaña · `Ctrl+K` paleta de comandos · `Ctrl+F` buscar · `F3`/`Mayús+F3` siguiente/anterior ·
`Ctrl++`/`Ctrl+-`/`Ctrl+0` zoom · `Ctrl+1`/`Ctrl+2` ajustar al ancho/página · `Alt+1/2/3` modo de lectura ·
`F11` pantalla completa · `Ctrl+B` barra lateral · `Ctrl+G` ir a página · `Ctrl+Mayús+L` cambiar tema

### Crear un PDF desde cero

`Ctrl+N` (o el botón **Nuevo PDF** de la bienvenida): eliges papel (A3, A4, A5, Carta, Legal o medidas propias), orientación y número de páginas. Se abre como «Documento sin título» y se rellena con **Añadir texto** (`X`), **Añadir imagen** (`I`), formas, anotaciones, campos de formulario, etc.; al guardar eliges dónde. Cerrarlo sin guardar pregunta. Para crear un PDF a partir de imágenes o de Word/Excel/PowerPoint se usa Herramientas › Conversión.

Limitación: no hay un editor de texto con párrafos que fluyan entre páginas; el texto se coloca en cuadros, y solo admite caracteres latinos (WinAnsi).

### Fase 2: anotaciones y páginas

`V` seleccionar · `H` resaltar · `U` subrayar · `S` tachar · `D` dibujo libre · `R` rectángulo · `O` elipse · `L` línea ·
`A` flecha · `N` nota · `T` cuadro de texto · `Esc` volver a seleccionar · `Supr` borrar la anotación seleccionada ·
`Ctrl+Z` / `Ctrl+Mayús+Z` deshacer / rehacer · `Ctrl+S` guardar · `Ctrl+Mayús+S` guardar como ·
`Ctrl+[` / `Ctrl+]` girar páginas. El resto (eliminar, duplicar, insertar, extraer, combinar PDFs) está en la barra de
miniaturas y en la paleta `Ctrl+K`.

**Cómo se guardan las anotaciones.** Son anotaciones PDF estándar (con su apariencia, para que las vean Acrobat, el
navegador, etc.) y llevan además una copia de sus datos en la clave `/FoliuxData`, que permite volver a editarlas al
reabrir el archivo en Foliux, incluso tras girar, mover o borrar páginas. Las anotaciones creadas por otros programas se
muestran pero no se pueden editar.

**Limitaciones conocidas de esta fase**

- Las operaciones de páginas y el guardado se ejecutan en el proceso principal sin hilo aparte: en PDFs muy grandes la
  ventana puede quedarse unos segundos sin responder y la operación no se puede cancelar.
- Guardar reescribe el archivo con pdf-lib (sin flujos de objetos, por lo que puede ocupar más). Invalidaría firmas
  digitales existentes (la Fase 5 las tratará) y no admite PDFs cifrados (Fase 4).
- Los cuadros de texto solo admiten caracteres de WinAnsi (español, francés, alemán...; no CJK ni cirílico): el resto
  se sustituye por «?». Las anotaciones se pueden mover, pero aún no redimensionar.
- El historial de deshacer se recorta por antigüedad (50 pasos o 300 MB de versiones distintas del documento).

### Fase 3: edición de contenido

`X` añadir texto · `E` editar texto existente · `I` añadir o reemplazar imagen. El panel **Herramientas** de la barra lateral
reúne: aplicar cambios pendientes, marca de agua (texto o imagen), encabezado/pie/numeración, dividir, combinar y optimizar.

**Cómo funciona.** El texto y las imágenes que añades (y los reemplazos) son _contenido pendiente_: puedes moverlos, editarlos y
deshacerlos. Pasan a formar parte de la página (dejan de ser objetos) al pulsar «Aplicar cambios», al guardar o al hacer
cualquier operación de páginas. Las marcas de agua y los encabezados se escriben directamente en las páginas.

**Limitaciones técnicas de esta fase**

- **Editar texto existente no borra el original.** Un PDF no guarda «párrafos» sino letras colocadas una a una, con fuentes
  que a menudo solo contienen los caracteres usados. Por eso Foliux **tapa** el texto original con un rectángulo del color del
  fondo y escribe el nuevo encima. El texto original sigue dentro del archivo y cualquier lector puede seleccionarlo y copiarlo.
  Para eliminar contenido de verdad hará falta la redacción permanente (Fase 4). La fuente del texto nuevo es una de las 14
  estándar de PDF (Helvetica, Times o Courier), no la original.
- **Reemplazar una imagen** coloca la nueva encima y tapa la original con blanco; la original sigue en el archivo. Solo se
  detectan imágenes dibujadas directamente en la página.
- **Solo caracteres latinos** (WinAnsi) en el texto nuevo: sin chino, cirílico, árabe, etc. (se sustituyen por «?»).
- **Optimizar** es una compactación sin pérdida (agrupa objetos en flujos comprimidos). **No reduce ni recomprime imágenes**,
  así que un PDF lleno de fotos apenas bajará de tamaño. La compresión real de imágenes queda pendiente (ver notas del proyecto).
  La copia optimizada incorpora las anotaciones y ya no se podrán editar al reabrirla.
- Una marca de agua de texto se reduce sola si no cabe en la página; las de imagen no se giran.
- El texto de un cuadro no se puede girar desde la interfaz (solo las marcas de agua usan ángulo).

### Fase 4: seguridad

Panel **Herramientas › Seguridad**: contraseña y permisos (cifrado AES-256 con **qpdf**, incluido en el instalador), redacción
permanente, limpieza de metadatos y comparación de versiones (panel **Comparar versiones**).

- **Redacción permanente.** Marca zonas (herramienta de redactar o «Marcar todos los resultados» de una búsqueda) y aplícalas: las
  páginas con marcas se convierten en imagen con las zonas en negro, de modo que el contenido tapado **desaparece del archivo**
  (no queda texto, imagen ni forma debajo). Las palabras no redactadas siguen siendo buscables. Hasta guardar se puede deshacer.
- **Permisos (imprimir, copiar, editar) son orientativos**: los respetan Acrobat y la mayoría de lectores, pero no son una
  barrera de seguridad; la contraseña de apertura sí cifra el contenido.
- Las contraseñas que empiezan por «-» no se admiten (limitación de la forma de invocar qpdf sin exponerlas en la línea de comandos).
- **Comparar** usa un diff de palabras (Myers) y señala añadidos, eliminados y cambios; si las dos versiones difieren en más de
  ~3000 palabras se rechaza con un aviso (no es una comparación de documentos totalmente distintos). No compara imágenes ni maquetación.

### Fase 5: formularios y firmas

Paneles **Formularios** y **Firmas**. Rellenar campos AcroForm (texto, casillas, opciones, desplegables, listas), crear y
borrar campos, aplanar el formulario, firma visual (dibujada, escrita o imagen) y **firma digital** PKCS#7 (@signpdf +
node-forge) con certificado .p12/.pfx o uno autofirmado que genera la propia aplicación. Cada firma queda anotada en un
**registro de auditoría** encadenado por hashes que se puede exportar a CSV.

- Las firmas no llevan **sello de tiempo (TSA)** y la verificación comprueba integridad y certificado, no la **cadena de confianza**.
  Un certificado autofirmado es válido técnicamente pero ningún lector lo reconocerá como de confianza.
- Modificar un PDF firmado invalida sus firmas (se avisa antes de guardar).
- No se pueden crear campos en páginas **giradas**. Los formularios **XFA** no se admiten.
- El registro de auditoría detecta modificaciones en medio de la cadena, pero no el borrado de la última entrada.

### Fase 6: OCR y conversión

**Herramientas › Conversión**: OCR (Tesseract.js en un worker; los datos de idioma van dentro de la app, funciona sin conexión),
PDF → Word / Excel / PowerPoint / imágenes, imágenes y Office → PDF, PDF/A y procesamiento por lotes.

- La conversión a **Word y Excel es heurística**: reconstruye párrafos, títulos y columnas a partir de la posición del texto.
  Los documentos con maquetación compleja pueden salir desordenados. PowerPoint genera una diapositiva-imagen por página.
- **Office → PDF** necesita **LibreOffice** instalado (no se incluye por tamaño); si no está, se avisa.
- **PDF/A es de mejor esfuerzo y no está validado** con veraPDF: no se puede garantizar el cumplimiento si el PDF usa fuentes no incrustadas.
- La calidad del OCR depende de la resolución del escaneo; el texto reconocido queda invisible bajo la imagen.

### Fase 7: asistente de IA

Pestaña **Asistente de IA** (icono ✨): chat con el documento (con citas «[p. 3]» que llevan a la página), resumen, explicar o traducir
la selección y, en «Acciones con IA»: **extraer tablas a Excel**, **detectar campos de formulario** (los crea junto a su etiqueta tras
revisarlos), **buscar datos sensibles** (los marca para redactar tras revisarlos), **generar una presentación** (.pptx con notas)
y **resumen en audio** (voz del sistema, con pausa y parada).

- Usa **tu propia clave** de la API de Anthropic (`console.anthropic.com`). La clave se cifra con `safeStorage` (DPAPI en Windows),
  se guarda en `ai-key.bin` y **solo la lee el proceso principal**: nunca llega a la interfaz ni está en el código. Si el sistema
  no ofrece cifrado, no se guarda. Todo el tráfico con la API sale del proceso principal.
- **Privacidad:** antes de enviar un documento por primera vez se muestra un aviso con el tamaño aproximado (tokens) y el modelo.
  El texto se envía a Anthropic; el coste se factura a tu cuenta. Los documentos escaneados necesitan OCR antes.
- Modelo por defecto `claude-opus-5-5`; se puede cambiar a Sonnet o Haiku (más baratos) en «Clave y modelo».
- Documentos muy largos se **recortan por páginas completas** (tope ~1,5 M de caracteres) y se avisa de cuántas páginas se enviaron.
- **La IA puede equivocarse u omitir datos.** La detección de datos sensibles y de campos es una ayuda, no una garantía: revisa
  siempre el resultado antes de redactar. Las citas de página pueden ser inexactas.
- Se envía solo el texto, no las imágenes: gráficos, fotos y tablas escaneadas no se interpretan. Las cancelaciones detienen la petición.
- La posición de los campos detectados es aproximada (a la derecha de la etiqueta o debajo); ajústalos después a mano.
- El resumen en audio depende de las voces instaladas en Windows; si no hay una en español usa la predeterminada.

### Fase 8: espacios de trabajo

Pestaña **Espacios de trabajo**: agrupa los PDF de un proyecto (por archivo o los que tengas abiertos), ábrelos juntos y
**pregunta a la IA por todos a la vez**. Las respuestas citan documento y página (`[informe.pdf, p. 3]`) y al pulsar la cita se
abre el documento en esa página. Un espacio guarda solo las rutas (`workspaces.json` en los datos de usuario); no copia ni modifica los PDF.

- Se usa la **versión guardada en disco** de cada documento (no los cambios sin guardar). Los PDF con contraseña se saltan con aviso.
- Si el conjunto no cabe en el límite, el presupuesto se reparte: los documentos cortos entran enteros y los largos se recortan
  por páginas; se indica cuáles. El aviso de envío se vuelve a pedir si cambian los documentos del espacio.
- Si un archivo se mueve o borra, aparece como «(no encontrado)»; no se actualiza la ruta solo.
- Hace falta tener un documento abierto para ver la barra lateral (desde la pantalla de bienvenida aún no hay acceso).

### Limitaciones generales

- Las operaciones sobre el PDF (pdf-lib) se ejecutan en el proceso principal sin hilo aparte ni cancelación: en archivos muy
  grandes la ventana puede quedarse unos segundos sin responder.
- La interfaz solo está en español. El instalador **no está firmado** (Windows SmartScreen avisará) y usa el icono por defecto de Electron.

### Actualizaciones de la aplicación

**Ctrl+K › Buscar actualizaciones…** (también en Herramientas › Aplicación y en la pantalla de bienvenida). Con la opción
«Buscar al iniciar» (activada por defecto) la app consulta, unos segundos después de arrancar, si hay una versión nueva y **solo avisa**:
descargar e instalar siempre los decide el usuario, y con cambios sin guardar no deja instalar. Usa `electron-updater` con
**Releases de GitHub** (`WilliamsAlexis/Foliux-PDF`).

**Cómo publicar una versión nueva**

1. Sube la versión en `apps/desktop/package.json` (p. ej. 0.3.0) y ejecuta `npm run dist`.
2. Crea en GitHub un Release con la etiqueta `v0.3.0` (**no** borrador ni «pre-release») y adjunta los **tres** archivos de
   `apps/desktop/dist`: `Foliux-PDF-Setup-0.3.0.exe`, `Foliux-PDF-Setup-0.3.0.exe.blockmap` y `latest.yml`. Sin `latest.yml`
   las apps instaladas no ven la versión.
3. Las apps instaladas con una versión anterior mostrarán el aviso.

**Limitaciones:** el instalador no está firmado, así que la integridad se comprueba solo con el hash SHA-512 de `latest.yml`
(descargado por HTTPS desde GitHub) y Windows SmartScreen puede avisar al instalar. La 0.1.0 ya instalada no incluye el
actualizador: debe actualizarse a mano una vez a la 0.2.0 o posterior. Solo se probó el flujo hasta la búsqueda; la descarga e
instalación reales requieren un Release publicado.
