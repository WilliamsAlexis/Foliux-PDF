import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { commands } from '@/commands/registry';
import { useUi } from '@/store/ui';
import { openPdfPath } from '@/lib/actions';
import { formatShortcut } from '@/lib/shortcuts';

const ITEM_CLASS =
  'flex cursor-default items-center justify-between gap-3 rounded-md px-3 py-2 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground';

/** Paleta de comandos (Ctrl+K): busca y ejecuta cualquier acción, o abre un archivo reciente. */
export function CommandPalette() {
  const { t } = useTranslation();
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const recent = useUi((s) => s.recent);

  const run = (action: () => void | Promise<void>) => {
    setOpen(false);
    // Se espera a que el diálogo se cierre para que el foco vuelva antes de ejecutar la acción.
    window.setTimeout(() => void action(), 0);
  };

  // Los comandos se evalúan al abrir la paleta (así `enabled` refleja el estado actual).
  const available = open ? commands.filter((c) => !c.enabled || c.enabled()) : [];

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[14%] left-1/2 z-50 w-[560px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
        >
          <Dialog.Title className="sr-only">{t('palette.label')}</Dialog.Title>
          <Command label={t('palette.label')} loop>
            <Command.Input
              placeholder={t('palette.placeholder')}
              className="h-12 w-full border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
            />
            <Command.List className="max-h-[360px] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('palette.empty')}
              </Command.Empty>

              <Command.Group
                heading={t('palette.commands')}
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {available.map((command) => {
                  const label = t(command.label);
                  const shortcut = command.shortcuts?.[0];
                  return (
                    <Command.Item
                      key={command.id}
                      value={`${label} ${command.id}`}
                      onSelect={() => run(command.run)}
                      className={ITEM_CLASS}
                    >
                      <span>{label}</span>
                      {shortcut && (
                        <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-xs text-muted-foreground">
                          {formatShortcut(shortcut)}
                        </kbd>
                      )}
                    </Command.Item>
                  );
                })}
              </Command.Group>

              {recent.length > 0 && (
                <Command.Group
                  heading={t('palette.recent')}
                  className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {recent.map((file) => (
                    <Command.Item
                      key={file.path}
                      value={`${file.name} ${file.path}`}
                      onSelect={() => run(() => openPdfPath(file.path))}
                      className={ITEM_CLASS}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="truncate">{file.name}</span>
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
