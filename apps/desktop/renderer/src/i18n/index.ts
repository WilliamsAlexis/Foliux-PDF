import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import es from './locales/es.json';

/**
 * Internacionalización. Hoy solo está el español; para añadir otro idioma basta con crear
 * `locales/<código>.json` con las mismas claves y registrarlo en `resources`.
 */
void i18n.use(initReactI18next).init({
  lng: 'es',
  fallbackLng: 'es',
  resources: { es: { translation: es } },
  interpolation: { escapeValue: false }, // React ya escapa el contenido
});

export default i18n;
