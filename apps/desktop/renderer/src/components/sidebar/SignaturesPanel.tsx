import { BadgeAlert, BadgeCheck, BadgeX, FileWarning, History, PenTool } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SignatureReport } from '@foliux-pdf/core';
import { Button } from '@/components/ui/button';
import type { DocTab } from '@/store/docs';
import { useUi } from '@/store/ui';
import { recheckSignatures } from '@/lib/signing';
import { cn } from '@/lib/utils';

const STATUS: Record<SignatureReport['integrity'], { icon: React.ReactNode; className: string }> = {
  valid: { icon: <BadgeCheck />, className: 'text-green-700 dark:text-green-400' },
  modified: { icon: <BadgeX />, className: 'text-red-700 dark:text-red-400' },
  invalid: { icon: <BadgeX />, className: 'text-red-700 dark:text-red-400' },
  unreadable: { icon: <BadgeAlert />, className: 'text-amber-700 dark:text-amber-400' },
};

/** Firmas digitales del documento y accesos para firmar y consultar el registro de auditoría. */
export function SignaturesPanel({ tab }: { tab: DocTab }) {
  const { t } = useTranslation();
  const setDialog = useUi((s) => s.setToolDialog);

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <Button size="sm" onClick={() => setDialog('signature')}>
          <PenTool /> {t('signing.visual')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDialog('sign')}>
          <BadgeCheck /> {t('signing.digital')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog('audit')}>
          <History /> {t('signing.audit')}
        </Button>
      </div>

      {tab.signatures.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{t('signatures.empty')}</p>
      ) : (
        <div className="flex flex-col gap-2 p-3">
          <p className="flex items-start gap-2 rounded-md bg-amber-100 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <FileWarning className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t('signatures.saveWarning')}
          </p>
          <ul className="flex flex-col gap-2">
            {tab.signatures.map((signature) => (
              <li key={signature.index} className="rounded-md border border-border p-2 text-sm">
                <p
                  className={cn(
                    'flex items-center gap-1.5 font-medium [&_svg]:size-4',
                    STATUS[signature.integrity].className,
                  )}
                >
                  {STATUS[signature.integrity].icon}
                  {t(`signatures.status.${signature.integrity}`)}
                </p>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
                  <dt className="text-muted-foreground">{t('signatures.signer')}</dt>
                  <dd className="break-words">{signature.signer || '—'}</dd>
                  <dt className="text-muted-foreground">{t('signatures.date')}</dt>
                  <dd>
                    {signature.signedAt ? new Date(signature.signedAt).toLocaleString() : '—'}
                  </dd>
                  {signature.reason ? (
                    <>
                      <dt className="text-muted-foreground">{t('signatures.reason')}</dt>
                      <dd className="break-words">{signature.reason}</dd>
                    </>
                  ) : null}
                  {signature.location ? (
                    <>
                      <dt className="text-muted-foreground">{t('signatures.location')}</dt>
                      <dd className="break-words">{signature.location}</dd>
                    </>
                  ) : null}
                </dl>
                <ul className="mt-1.5 list-disc pl-4 text-xs text-muted-foreground">
                  {signature.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="outline" onClick={() => void recheckSignatures(tab.id)}>
            {t('signatures.recheck')}
          </Button>
        </div>
      )}
    </div>
  );
}
