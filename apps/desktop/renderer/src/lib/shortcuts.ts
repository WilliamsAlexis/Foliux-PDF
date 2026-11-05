/**
 * Atajos de teclado. Formato: 'mod+shift+k', donde "mod" es Ctrl (Windows/Linux) o ⌘ (macOS).
 * Teclas especiales: 'plus' (el signo +), 'escape', 'arrowleft', 'pagedown', 'f11'...
 */

const isMac = () => window.foliux?.platform === 'darwin';

interface ParsedShortcut {
  key: string;
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.toLowerCase().split('+');
  const key = parts.pop() ?? '';
  return {
    key,
    mod: parts.includes('mod'),
    ctrl: parts.includes('ctrl'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  };
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parsed = parseShortcut(shortcut);
  // 'mod' = Ctrl en Windows/Linux y ⌘ en macOS; 'ctrl' = siempre la tecla Ctrl.
  const ctrlExpected = parsed.ctrl || (parsed.mod && !isMac());
  const metaExpected = parsed.mod && isMac();
  if (event.ctrlKey !== ctrlExpected || event.metaKey !== metaExpected) return false;
  if (parsed.alt !== event.altKey) return false;
  // "plus" se escribe con Mayús en muchos teclados, así que ahí no se exige que Mayús coincida.
  if (parsed.key !== 'plus' && parsed.shift !== event.shiftKey) return false;

  const pressed = event.key.toLowerCase();
  if (parsed.key === 'plus') return pressed === '+' || pressed === 'add';
  return pressed === parsed.key;
}

const KEY_LABELS: Record<string, string> = {
  plus: '+',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  escape: 'Esc',
  pagedown: 'AvPág',
  pageup: 'RePág',
  home: 'Inicio',
  end: 'Fin',
  tab: 'Tab',
};

/** Texto legible del atajo para mostrar en la interfaz (Ctrl+Mayús+K o ⌘⇧K). */
export function formatShortcut(shortcut: string): string {
  const parsed = parseShortcut(shortcut);
  const key =
    KEY_LABELS[parsed.key] ??
    (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key.toUpperCase());
  if (isMac()) {
    return `${parsed.alt ? '⌥' : ''}${parsed.shift ? '⇧' : ''}${parsed.mod ? '⌘' : ''}${key}`;
  }
  return [(parsed.mod || parsed.ctrl) && 'Ctrl', parsed.alt && 'Alt', parsed.shift && 'Mayús', key]
    .filter(Boolean)
    .join('+');
}

/** ¿El foco está en un campo donde se escribe texto? */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}
