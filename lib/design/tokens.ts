/**
 * Design System Tokens — Premium Arc Theme
 * Consistent spacing, colors, card styles, animations across all UI
 */

// Colors — Keep existing Arc palette, polished
export const COLORS = {
  arcBg: '#0a0a0f', // Deep dark background
  arcSurface: '#12121a', // Card base
  arcSurface2: '#1a1a2e', // Elevated surfaces
  arcBorder: '#252535', // Ring/border color
  arcPrimary: '#6366f1', // Indigo primary accent
  arcAccent: '#22d3ee', // Cyan secondary accent
  arcText: '#e5e5f0', // Primary text
  arcMuted: '#71717a', // Secondary text
  arcFaint: '#3f3f51', // Subtle elements
} as const;

// Spacing scale — 8px grid system
export const SPACING = {
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  6: '24px',
  8: '32px',
  12: '48px',
  16: '64px',
} as const;

// Animation durations
export const ANIMATION_DURATIONS = {
  fast: '200ms', // Hover effects
  normal: '300ms', // Page transitions
  slow: '500ms', // Heavy animations
} as const;

// Premium Card Style classes
export const CARD_STYLES = {
  /** Base premium card */
  base: [
    'bg-arc-surface/60',
    'ring-1',
    'ring-arc-border',
    'rounded-2xl',
    'backdrop-blur-sm',
    'shadow-glow',
    'transition-all',
    'duration-200',
    'hover:-translate-y-0.5',
    'hover:ring-arc-primary/30',
  ].join(' '),

  /** Stat card with gradient */
  stat: [
    'bg-gradient-to-br',
    'from-arc-surface',
    'to-arc-surface2/50',
    'ring-1',
    'ring-arc-border',
    'rounded-2xl',
    'p-5',
    'hover:ring-arc-primary/30',
    'hover:shadow-glow',
    'transition-all',
    'duration-200',
  ].join(' '),

  /** Interactive card */
  interactive: [
    'card-premium',
    'cursor-pointer',
  ].join(' '),

  /** Loading skeleton */
  skeleton: 'animate-pulse bg-arc-surface2/40 rounded-lg',

  /** Fade-in animation */
  fade: 'anim-fade',
};

// Utility functions for consistent styling
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

// Add to your global CSS (add to globals.css):
/*
@keyframes fadeIn {
  from { 
    opacity: 0; 
    transform: translateY(8px); 
  }
  to { 
    opacity: 1; 
    transform: translateY(0); 
  }
}

.anim-fade {
  animation: fadeIn 0.3s ease-out;
}

.hover-lift {
  transition: all 200ms;
}

.hover-lift:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 25px rgba(99, 102, 241, 0.15);
}

.shadow-glow {
  box-shadow: 0 0 40px rgba(99, 102, 241, 0.1);
}
*/

export default CARD_STYLES;
