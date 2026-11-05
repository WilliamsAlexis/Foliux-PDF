/// <reference types="vite/client" />
import type { FoliuxApi } from '@foliux-pdf/core';

declare global {
  interface Window {
    /** API segura expuesta por el preload. */
    foliux: FoliuxApi;
  }
}
