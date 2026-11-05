import { FileDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUi } from '@/store/ui';

/** Aviso a pantalla completa mientras se arrastra un archivo sobre la ventana. */
export function DropOverlay() {
  const { t } = useTranslation();
  const dragging = useUi((s) => s.dragging);
  if (!dragging) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
    >
      <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary px-16 py-12 text-primary">
        <FileDown className="size-10" />
        <p className="text-lg font-medium">{t('drop.title')}</p>
      </div>
    </div>
  );
}
