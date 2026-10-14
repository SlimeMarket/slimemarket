'use client';

/**
 * Optimized Image Component
 * 
 * Replaces plain img tags with Next.js Image component for:
 * - Automatic WebP conversion
 * - Lazy loading
 * - Blur placeholders
 * - Responsive sizing
 */

import Image from 'next/image';
import { memo } from 'react';

interface OptimizedImageProps {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  priority?: boolean;
  className?: string;
  onLoad?: () => void;
  onError?: () => void;
}

function OptimizedImageInner({
  src,
  alt,
  width = 300,
  height = 200,
  priority = false,
  className = '',
  onLoad,
  onError
}: OptimizedImageProps) {
  // Generate blur placeholder data URI (simulated)
  const blurDataURL = `data:image/svg+xml,%3csvg%3e%3crect%20fill='%231f2937'%20width='${width}'%20height='${height}'/%3e%3c/svg%3e`;

  return (
    <div className={`relative overflow-hidden rounded-lg ${className}`}>
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        loading={priority ? 'eager' : 'lazy'}
        priority={priority}
        placeholder="blur"
        blurDataURL={blurDataURL}
        quality={75}
        className="object-cover w-full h-full"
        onLoad={onLoad}
        onError={() => {
          console.warn('Image load failed:', src);
          if (onError) onError();
        }}
        sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
      />
      
      {/* Loading skeleton */}
      {!priority && (
        <div className="absolute inset-0 animate-pulse bg-slate-700" />
      )}
    </div>
  );
}

OptimizedImageInner.displayName = 'OptimizedImageInner';

// Memoize with optimized comparison
export const OptimizedImage = memo(OptimizedImageInner);
OptimizedImage.displayName = 'OptimizedImage';

export default OptimizedImage;
