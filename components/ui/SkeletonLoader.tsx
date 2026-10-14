/**
 * Universal Skeleton Loader Component
 * 
 * Provides smooth loading states to improve perceived performance and UX quality!
 */

type Variant = 'card' | 'button' | 'text' | 'image' | 'avatar' | 'table';
type Height = 'sm' | 'md' | 'lg' | 'xl';
type Width = 'full' | 'half' | 'quarter' | 'three-quarters';

interface SkeletonLoaderProps {
  variant?: Variant;
  width?: Width;
  height?: Height;
  className?: string;
  children?: React.ReactNode;
}

export function SkeletonLoader({
  variant = 'card',
  width = 'full',
  height = 'md',
  className = '',
  children,
}: SkeletonLoaderProps) {
  const baseClasses = 'animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700';
  
  const variants = {
    card: 'p-4 space-y-3 h-full',
    button: 'px-4 py-2 rounded-lg h-10 w-32',
    text: 'h-4 w-3/4 mb-2',
    image: 'h-48 w-full',
    avatar: 'rounded-full h-12 w-12',
    table: 'w-full space-y-2 p-3',
  };
  
  const heights = {
    sm: 'h-4',
    md: 'h-6',
    lg: 'h-12',
    xl: 'h-24',
  };
  
  const widths = {
    full: 'w-full',
    half: 'w-1/2',
    quarter: 'w-1/4',
    'three-quarters': 'w-3/4',
  };
  
  return (
    <div
      className={`${baseClasses} ${variants[variant]} ${heights[height]} ${widths[width]} ${className}`}
      role="progressbar"
      aria-label={ariaLabel(variant)}
    >
      {children}
      {/* Pulse animation overlay */}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-gray-100 to-transparent dark:via-gray-700 animate-shimmer" />
    </div>
  );
}

function ariaLabel(variant: Variant): string {
  const labels: Record<Variant, string> = {
    card: 'Loading content card',
    button: 'Loading button',
    text: 'Loading text',
    image: 'Loading image placeholder',
    avatar: 'Loading avatar placeholder',
    table: 'Loading table row',
  };
  return labels[variant];
}

// Add shimmer animation via styled-components or global CSS
// .animate-shimmer {
//   position: absolute;
//   top: 0;
//   left: 0;
//   right: 0;
//   bottom: 0;
//   background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.1) 50%, transparent 100%);
//   animation: shimmer 1.5s infinite;
// }
// @keyframes shimmer {
//   0% { transform: translateX(-100%); }
//   100% { transform: translateX(100%); }
// }
