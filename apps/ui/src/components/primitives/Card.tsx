import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import './Card.css';

/**
 * <Card> — bordered surface (B3 §6 / §15.2 #4).
 *
 * Trail uses borders, not shadows, for hierarchy. Cards are flat planes
 * separated by hairlines; sharp corners reinforce the audit-document aesthetic.
 *
 *   density="comfortable" — default, full --space-5/6 internal padding
 *   density="compact"     — used in dense lists (sidebar rows)
 *   tone="elevated"       — uses --surface-raised when a card needs to lift
 *                           visually inside another bordered container
 */

export type CardDensity = 'comfortable' | 'compact';
export type CardTone = 'default' | 'elevated';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  density?: CardDensity;
  tone?: CardTone;
  children: ReactNode;
}

export function Card({
  density = 'comfortable',
  tone = 'default',
  className,
  style,
  children,
  ...rest
}: CardProps) {
  const classes = ['card', `card--${density}`, `card--${tone}`, className]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} style={style as CSSProperties} {...rest}>
      {children}
    </div>
  );
}
