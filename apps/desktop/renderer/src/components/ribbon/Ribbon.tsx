import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { DocTab } from '@/store/docs';
import { useRibbon } from '@/store/ribbon';
import { useUi } from '@/store/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { StyleControls } from '@/components/AnnotationBar';
import { formatShortcut } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { RIBBON, type RibbonAction, type RibbonContext, type RibbonTool } from './ribbonConfig';

/** Mueve el foco entre los botones de una barra con las flechas, Inicio y Fin (patrón «toolbar» de ARIA). */
function onToolbarKeys(event: React.KeyboardEvent<HTMLElement>): void {
  const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const buttons = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
  ];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (buttons.length === 0 || index < 0) return;
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}

/** ¿Está disponible la herramienta con lo que hay seleccionado? */
function isDisabled(tool: RibbonTool, context: RibbonContext): boolean {
  if (context.tab.busy !== null) return true;
  if (tool.pendiente) return true;
  if (tool.requiereSeleccion === 'anotacion' && !context.selectedAnnotation) return true;
  if (tool.requiereSeleccion === 'paginas' && context.selectedPages.length === 0) return true;
  return tool.deshabilitada?.(context) ?? false;
}

function ToolButton({ tool, context }: { tool: RibbonTool; context: RibbonContext }) {
  const { t } = useTranslation();
  const current = useUi((s) => s.tool);
  const disabled = isDisabled(tool, context);
  const pressed = tool.herramienta !== undefined && current === tool.herramienta;
  const label = t(tool.etiqueta);
  const Icon = tool.icono;

  let hint: string | null = null;
  if (tool.pendiente) hint = t('ribbon.pending');
  else if (disabled && tool.requiereSeleccion === 'anotacion') hint = t('ribbon.needAnnotation');
  else if (disabled && tool.requiereSeleccion === 'paginas') hint = t('ribbon.needPages');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          // Un botón deshabilitado no recibe el ratón: se usa aria-disabled para que el tooltip siga explicando por qué.
          aria-disabled={disabled}
          aria-pressed={tool.herramienta !== undefined ? pressed : undefined}
          data-ribbon-tool={tool.id}
          onClick={() => {
            if (disabled) {
              if (hint) toast.info(hint, { id: 'ribbon-disabled' });
              return;
            }
            void tool.accion(context);
          }}
          className={cn(
            'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            disabled
              ? 'cursor-not-allowed opacity-40'
              : 'hover:bg-accent hover:text-accent-foreground',
            pressed && 'bg-primary/15 text-primary',
          )}
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          <span>{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {tool.atajo ? <span className="ml-2 opacity-70">{formatShortcut(tool.atajo)}</span> : null}
        {hint ? <span className="mt-0.5 block text-xs opacity-80">{hint}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** Segunda barra: las herramientas de la acción elegida. */
function SecondaryBar({ action, context }: { action: RibbonAction; context: RibbonContext }) {
  const { t } = useTranslation();
  return (
    <div
      role="toolbar"
      id={`ribbon-panel-${action.id}`}
      aria-label={t(action.etiqueta)}
      onKeyDown={onToolbarKeys}
      className="flex h-11 items-center gap-0.5 overflow-x-auto px-2"
    >
      {action.herramientas.map((tool) => (
        <div key={tool.id} className="flex shrink-0 items-center gap-0.5">
          {tool.separadorAntes && <div className="mx-1 h-5 w-px bg-border" aria-hidden />}
          <ToolButton tool={tool} context={context} />
        </div>
      ))}
      {action.mostrarEstilo && <StyleControls tab={context.tab} />}
    </div>
  );
}

/**
 * Barra de acciones al estilo Acrobat: arriba las acciones; al elegir una se despliega debajo su barra de
 * herramientas. Pulsar la acción activa la contrae. Se construye a partir de RIBBON (ribbonConfig.ts).
 */
export function Ribbon({ tab }: { tab: DocTab }) {
  const { t } = useTranslation();
  const activeAction = useRibbon((s) => s.activeAction);
  const toggle = useRibbon((s) => s.toggle);
  const collapse = useRibbon((s) => s.collapse);
  const barRef = useRef<HTMLDivElement>(null);

  // Mientras la barra secundaria se cierra se sigue mostrando la última, para que la animación no parpadee.
  const [lastAction, setLastAction] = useState<string>(RIBBON[0]?.id ?? '');
  useEffect(() => {
    if (activeAction) setLastAction(activeAction);
  }, [activeAction]);
  const shown = RIBBON.find((a) => a.id === (activeAction ?? lastAction)) ?? RIBBON[0];
  const expanded = activeAction !== null;

  const selectedAnnotation = tab.annotations.find((a) => a.id === tab.selectedAnnotationId);
  const context: RibbonContext = { tab, selectedAnnotation, selectedPages: tab.pageSelection };

  return (
    <div
      ref={barRef}
      className="shrink-0 border-b border-border bg-background"
      onKeyDown={(event) => {
        // Esc contrae la barra secundaria y devuelve el foco a su acción.
        if (event.key === 'Escape' && expanded) {
          const id = activeAction;
          collapse();
          document.getElementById(`ribbon-tab-${id}`)?.focus();
        }
      }}
    >
      <div
        role="toolbar"
        aria-label={t('ribbon.label')}
        onKeyDown={onToolbarKeys}
        className="flex h-10 items-end gap-0.5 overflow-x-auto px-2"
      >
        {RIBBON.map((action) => {
          const Icon = action.icono;
          const active = activeAction === action.id;
          return (
            <button
              key={action.id}
              id={`ribbon-tab-${action.id}`}
              type="button"
              aria-expanded={active}
              aria-controls={`ribbon-panel-${action.id}`}
              onClick={() => toggle(action.id)}
              className={cn(
                'flex h-9 shrink-0 items-center gap-1.5 rounded-t-md border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                active
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Icon className="size-4" aria-hidden />
              {t(action.etiqueta)}
            </button>
          );
        })}
      </div>

      {/* Se despliega y se contrae animando la altura; contraída no recibe foco ni lectores de pantalla. */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div className="min-h-0 overflow-hidden border-t border-border bg-muted/30">
          {shown && <SecondaryBar action={shown} context={context} />}
        </div>
      </div>
    </div>
  );
}
