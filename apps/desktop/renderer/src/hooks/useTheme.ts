import { useEffect } from 'react';
import { useUi } from '@/store/ui';

/**
 * Aplica la clase "dark" al documento. El proceso principal fija nativeTheme.themeSource según la
 * preferencia (claro / oscuro / automático), así que `prefers-color-scheme` ya refleja la elección
 * y el modo automático sigue los cambios del sistema sin código adicional.
 */
export function useTheme(): void {
  const preference = useUi((s) => s.theme);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  // La preferencia explícita también se aplica de inmediato (antes de que el sistema avise del cambio).
  useEffect(() => {
    if (preference === 'dark') document.documentElement.classList.add('dark');
    else if (preference === 'light') document.documentElement.classList.remove('dark');
  }, [preference]);
}
