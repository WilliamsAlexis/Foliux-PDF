import { useEffect } from 'react';
import { commands } from '@/commands/registry';
import { isEditableTarget, matchesShortcut } from '@/lib/shortcuts';
import { useUi } from '@/store/ui';

/** Atajos de teclado globales: recorre el registro de comandos y ejecuta el primero que coincide. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;

      const paletteOpen = useUi.getState().paletteOpen;
      const editing = isEditableTarget(event.target);
      const hasModifier = event.ctrlKey || event.metaKey || event.altKey;

      for (const command of commands) {
        // Con la paleta abierta solo responde su propio atajo (para poder cerrarla).
        if (paletteOpen && command.id !== 'app.palette') continue;

        const shortcut = command.shortcuts?.find((s) => matchesShortcut(event, s));
        if (!shortcut) continue;
        // Escribiendo en un campo, las teclas sueltas (flechas, Inicio...) son del campo.
        if (editing && !hasModifier && !command.allowInInput && !/^f\d+$/i.test(event.key))
          continue;
        if (command.enabled && !command.enabled()) continue;

        event.preventDefault();
        void command.run();
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
