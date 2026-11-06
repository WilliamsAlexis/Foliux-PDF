import {
  CheckCheck,
  EyeOff,
  FileArchive,
  FileOutput,
  Layers,
  ScanText,
  Archive,
  FileStack,
  Hash,
  History,
  Lock,
  PenTool,
  Scissors,
  ShieldOff,
  Stamp,
  RefreshCw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { DocTab } from '@/store/docs';
import { useUi } from '@/store/ui';
import { useUpdate } from '@/store/update';
import { applyPendingContent, mergeFiles, optimizeDocument, pendingContentCount } from '@/lib/edit';
import { redactionMarkCount } from '@/lib/security';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 px-3 py-3">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Action({
  icon,
  label,
  description,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      className="h-auto w-full items-start justify-start gap-2.5 px-2 py-2 text-left whitespace-normal"
    >
      <span className="mt-0.5">{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="block text-xs font-normal text-muted-foreground">{description}</span>
      </span>
    </Button>
  );
}

/** Herramientas de edición del documento que no caben en la barra: marcas de agua, encabezados, dividir... */
export function ToolsPanel({ tab }: { tab: DocTab }) {
  const { t } = useTranslation();
  const setDialog = useUi((s) => s.setToolDialog);
  const openUpdates = useUpdate((s) => s.setDialogOpen);
  const pending = pendingContentCount(tab);
  const busy = tab.busy !== null;

  return (
    <div className="divide-y divide-border">
      <Section title={t('tools.content')}>
        <Action
          icon={<CheckCheck />}
          label={t('tools.apply')}
          description={
            pending > 0 ? t('tools.applyPending', { count: pending }) : t('tools.applyNone')
          }
          disabled={busy || pending === 0}
          onClick={() => void applyPendingContent()}
        />
        <Action
          icon={<Stamp />}
          label={t('tools.watermark')}
          description={t('tools.watermarkHint')}
          disabled={busy}
          onClick={() => setDialog('watermark')}
        />
        <Action
          icon={<Hash />}
          label={t('tools.headerFooter')}
          description={t('tools.headerFooterHint')}
          disabled={busy}
          onClick={() => setDialog('headerFooter')}
        />
      </Section>
      <Section title={t('tools.security')}>
        <Action
          icon={<Lock />}
          label={t('tools.protect')}
          description={tab.protection ? t('tools.protectOn') : t('tools.protectHint')}
          disabled={busy}
          onClick={() => setDialog('security')}
        />
        <Action
          icon={<EyeOff />}
          label={t('tools.redact')}
          description={t('tools.redactHint', { count: redactionMarkCount() })}
          disabled={busy}
          onClick={() => setDialog('redact')}
        />
        <Action
          icon={<ShieldOff />}
          label={t('tools.metadata')}
          description={t('tools.metadataHint')}
          disabled={busy}
          onClick={() => setDialog('metadata')}
        />
      </Section>
      <Section title={t('tools.signing')}>
        <Action
          icon={<PenTool />}
          label={t('tools.visualSignature')}
          description={t('tools.visualSignatureHint')}
          disabled={busy}
          onClick={() => setDialog('signature')}
        />
        <Action
          icon={<Lock />}
          label={t('tools.digitalSignature')}
          description={t('tools.digitalSignatureHint')}
          disabled={busy}
          onClick={() => setDialog('sign')}
        />
        <Action
          icon={<History />}
          label={t('tools.audit')}
          description={t('tools.auditHint')}
          onClick={() => setDialog('audit')}
        />
      </Section>
      <Section title={t('tools.conversion')}>
        <Action
          icon={<ScanText />}
          label={t('tools.ocr')}
          description={t('tools.ocrHint')}
          disabled={busy}
          onClick={() => setDialog('ocr')}
        />
        <Action
          icon={<FileOutput />}
          label={t('tools.convert')}
          description={t('tools.convertHint')}
          disabled={busy}
          onClick={() => setDialog('convert')}
        />
        <Action
          icon={<Archive />}
          label={t('tools.pdfa')}
          description={t('tools.pdfaHint')}
          disabled={busy}
          onClick={() => setDialog('pdfa')}
        />
        <Action
          icon={<Layers />}
          label={t('tools.batch')}
          description={t('tools.batchHint')}
          onClick={() => setDialog('batch')}
        />
      </Section>
      <Section title={t('updates.toolsSection')}>
        <Action
          icon={<RefreshCw />}
          label={t('updates.toolsAction')}
          description={t('updates.toolsHint')}
          onClick={() => openUpdates(true)}
        />
      </Section>
      <Section title={t('tools.file')}>
        <Action
          icon={<Scissors />}
          label={t('tools.split')}
          description={t('tools.splitHint')}
          disabled={busy}
          onClick={() => setDialog('split')}
        />
        <Action
          icon={<FileStack />}
          label={t('tools.merge')}
          description={t('tools.mergeHint')}
          onClick={() => void mergeFiles()}
        />
        <Action
          icon={<FileArchive />}
          label={t('tools.optimize')}
          description={t('tools.optimizeHint')}
          disabled={busy}
          onClick={() => void optimizeDocument()}
        />
      </Section>
    </div>
  );
}
