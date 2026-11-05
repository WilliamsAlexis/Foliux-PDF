# Foliux PDF

Lector y editor de PDF de escritorio (Electron + React + TypeScript). **Estado: Fase 1 – Base y visor.**

## Requisitos

- Node.js 20 o superior (probado con 24) y npm
- Git

## Comandos

| Comando                | Qué hace                                                          |
| ---------------------- | ----------------------------------------------------------------- |
| `npm install`          | Instala dependencias de todos los workspaces                      |
| `npm run dev`          | Abre la aplicación con recarga en caliente                        |
| `npm run build`        | Compila main, preload y renderer en `apps/desktop/out`            |
| `npm test`             | Pruebas unitarias (Vitest)                                        |
| `npm run test:e2e`     | Compila y ejecuta las pruebas de extremo a extremo (Playwright)   |
| `npm run typecheck`    | Comprueba tipos en todos los workspaces                           |
| `npm run lint`         | ESLint                                                            |
| `npm run format`       | Prettier                                                          |
| `npm run dist`         | Genera el instalador NSIS en `apps/desktop/dist`                  |

> Si lanzas la aplicación desde un programa basado en Electron (por ejemplo, algunos terminales integrados),
> la variable `ELECTRON_RUN_AS_NODE` puede impedir que se abra la ventana: elimínala (`unset ELECTRON_RUN_AS_NODE`).

## Estructura

```
apps/desktop/main        Proceso principal: ventana, IPC validado con Zod, protocolo foliux://, registro
apps/desktop/preload     Puente seguro (contextBridge) con la API mínima que usa la interfaz
apps/desktop/renderer    React: componentes, stores (Zustand), comandos, i18n
packages/core            Tipos, errores, interfaces de los servicios y contrato IPC
packages/services        Motor PDF (PDF.js), búsqueda, archivos recientes, ajustes
tests                    Vitest (unit) y Playwright (e2e)
```

## Atajos principales

`Ctrl+O` abrir · `Ctrl+W` cerrar pestaña · `Ctrl+K` paleta de comandos · `Ctrl+F` buscar · `F3`/`Mayús+F3` siguiente/anterior ·
`Ctrl++`/`Ctrl+-`/`Ctrl+0` zoom · `Ctrl+1`/`Ctrl+2` ajustar al ancho/página · `Alt+1/2/3` modo de lectura ·
`F11` pantalla completa · `Ctrl+B` barra lateral · `Ctrl+G` ir a página · `Ctrl+Mayús+L` cambiar tema
