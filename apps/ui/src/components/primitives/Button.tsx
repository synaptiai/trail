import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './Button.css';

/**
 * <Button> primitive (B3 §15.2 #5).
 *
 * Variants: primary, secondary, danger, ghost.
 * Sizes: md (default), sm.
 *
 * Focus ring is the two-layer copper ring per B3 §6.3, applied via
 * :focus-visible in tokens.css.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    'button',
    `button--${variant}`,
    `button--${size}`,
    'type-ui',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
