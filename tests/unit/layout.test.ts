import { describe, expect, it } from 'vitest';
import {
  CSS_UNITS,
  computePageTops,
  computeZoom,
  nextZoomStep,
  pageAtOffset,
  pagesInView,
  stepPage,
  type ZoomInput,
} from '../../apps/desktop/renderer/src/lib/layout';

const A4 = { width: 595, height: 842 };

const base: ZoomInput = {
  zoomMode: 'custom',
  customZoom: 1,
  sizes: [A4, A4, A4, A4],
  page: 1,
  viewMode: 'continuous',
  width: 1000,
  height: 800,
};

describe('pagesInView', () => {
  it('muestra una página en los modos simple y continuo', () => {
    expect(pagesInView(3, 10, 'single')).toEqual([3]);
    expect(pagesInView(3, 10, 'continuous')).toEqual([3]);
  });

  it('agrupa en parejas (1-2, 3-4…) en doble página', () => {
    expect(pagesInView(1, 10, 'double')).toEqual([1, 2]);
    expect(pagesInView(2, 10, 'double')).toEqual([1, 2]);
    expect(pagesInView(4, 10, 'double')).toEqual([3, 4]);
  });

  it('deja sola la última página si el total es impar', () => {
    expect(pagesInView(5, 5, 'double')).toEqual([5]);
  });
});

describe('stepPage', () => {
  it('avanza de uno en uno y de dos en dos en doble página', () => {
    expect(stepPage(2, 10, 'single', 1)).toBe(3);
    expect(stepPage(1, 10, 'double', 1)).toBe(3);
    expect(stepPage(4, 10, 'double', -1)).toBe(1);
  });

  it('no se sale del documento', () => {
    expect(stepPage(1, 10, 'single', -1)).toBe(1);
    expect(stepPage(10, 10, 'single', 1)).toBe(10);
  });
});

describe('computeZoom', () => {
  it('usa el zoom manual limitado entre el mínimo y el máximo', () => {
    expect(computeZoom({ ...base, customZoom: 2 })).toBe(2);
    expect(computeZoom({ ...base, customZoom: 99 })).toBe(5);
    expect(computeZoom({ ...base, customZoom: 0.001 })).toBe(0.1);
  });

  it('ajustar al ancho hace que la página llene el ancho disponible', () => {
    const zoom = computeZoom({ ...base, zoomMode: 'fit-width' });
    const pageWidth = A4.width * CSS_UNITS * zoom;
    expect(pageWidth).toBeLessThanOrEqual(1000 - 48);
    expect(pageWidth).toBeGreaterThan(1000 - 48 - 20 - 14);
  });

  it('ajustar a la página es siempre ≤ que ajustar al ancho', () => {
    const fitWidth = computeZoom({ ...base, zoomMode: 'fit-width' });
    const fitPage = computeZoom({ ...base, zoomMode: 'fit-page' });
    expect(fitPage).toBeLessThanOrEqual(fitWidth);
    expect(A4.height * CSS_UNITS * fitPage).toBeLessThanOrEqual(800);
  });

  it('en doble página el ancho necesario es el de las dos páginas', () => {
    const single = computeZoom({ ...base, zoomMode: 'fit-width', viewMode: 'single' });
    const double = computeZoom({ ...base, zoomMode: 'fit-width', viewMode: 'double' });
    expect(double).toBeLessThan(single * 0.6);
  });

  it('sin tamaño de ventana todavía, devuelve el zoom manual', () => {
    expect(computeZoom({ ...base, zoomMode: 'fit-width', width: 0, height: 0 })).toBe(1);
  });
});

describe('nextZoomStep', () => {
  it('sube y baja por los niveles predefinidos', () => {
    expect(nextZoomStep(1, 1)).toBe(1.25);
    expect(nextZoomStep(1, -1)).toBe(0.75);
    expect(nextZoomStep(1.1, 1)).toBe(1.25);
    expect(nextZoomStep(1.1, -1)).toBe(1);
  });

  it('respeta los extremos', () => {
    expect(nextZoomStep(5, 1)).toBe(5);
    expect(nextZoomStep(0.25, -1)).toBe(0.1);
  });
});

describe('computePageTops / pageAtOffset', () => {
  const sizes = [
    { width: 100, height: 100 },
    { width: 100, height: 200 },
    { width: 100, height: 100 },
  ];
  const tops = computePageTops(sizes, 1);

  it('calcula dónde empieza cada página sumando alturas y separaciones', () => {
    // margen 24 + (100 + 12) + (200 + 12)
    expect(tops).toEqual([24, 136, 348]);
  });

  it('encuentra la página que contiene una posición', () => {
    expect(pageAtOffset(tops, 0)).toBe(1);
    expect(pageAtOffset(tops, 135)).toBe(1);
    expect(pageAtOffset(tops, 136)).toBe(2);
    expect(pageAtOffset(tops, 347)).toBe(2);
    expect(pageAtOffset(tops, 5000)).toBe(3);
  });
});
