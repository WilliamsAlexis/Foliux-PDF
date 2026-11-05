import * as React from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortcut } from '@/lib/shortcuts';

interface IconButtonProps extends Omit<ButtonProps, 'size' | 'children'> {
  /** Texto accesible y del tooltip. */
  label: string;
  shortcut?: string;
  icon: React.ReactNode;
}

/** Botón con icono: siempre lleva etiqueta accesible (aria-label) y tooltip con su atajo. */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, shortcut, icon, variant = 'ghost', ...props }, ref) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button ref={ref} variant={variant} size="icon" aria-label={label} {...props}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut ? <span className="ml-2 opacity-70">{formatShortcut(shortcut)}</span> : null}
      </TooltipContent>
    </Tooltip>
  ),
);
IconButton.displayName = 'IconButton';
