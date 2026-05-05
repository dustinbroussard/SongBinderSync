import React from 'react';
import * as LucideIcons from 'lucide-react';
import { cn } from '../lib/utils';

export type IconName = 
  | 'mic' 
  | 'music' 
  | 'list' 
  | 'settings' 
  | 'trash' 
  | 'edit' 
  | 'plus' 
  | 'copy' 
  | 'search' 
  | 'play' 
  | 'pause' 
  | 'refresh'
  | 'chevron-left'
  | 'chevron-right'
  | 'x';

interface CustomIconProps {
  name: IconName;
  className?: string;
  size?: number;
  lucideFallback?: keyof typeof LucideIcons;
}

/**
 * CustomIcon component that checks for a PNG in /icons/[name].png
 * Falls back to a provided Lucide icon if the PNG is missing or fails to load.
 */
export default function CustomIcon({ 
  name, 
  className, 
  size = 24, 
  lucideFallback 
}: CustomIconProps) {
  const [hasError, setHasError] = React.useState(false);
  
  // Mapping of common names to Lucide icons for easy defaults
  const defaultLucideMap: Record<IconName, keyof typeof LucideIcons> = {
    'mic': 'Mic2',
    'music': 'Music',
    'list': 'ListMusic',
    'settings': 'Settings',
    'trash': 'Trash2',
    'edit': 'Edit3',
    'plus': 'Plus',
    'copy': 'Copy',
    'search': 'Search',
    'play': 'Play',
    'pause': 'Pause',
    'refresh': 'RotateCcw',
    'chevron-left': 'ChevronLeft',
    'chevron-right': 'ChevronRight',
    'x': 'X'
  };

  const LucideIcon = LucideIcons[(lucideFallback || defaultLucideMap[name])] as any;

  if (hasError || !name) {
    return LucideIcon ? <LucideIcon className={className} size={size} /> : null;
  }

  return (
    <img 
      src={`/icons/${name}.png`} 
      alt={name}
      className={cn("object-contain", className)}
      style={{ width: size, height: size }}
      onError={() => setHasError(true)}
      referrerPolicy="no-referrer"
    />
  );
}
