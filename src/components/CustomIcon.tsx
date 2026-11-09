import React from 'react';
import {
  Mic2,
  Music,
  ListMusic,
  Settings,
  Trash2,
  Edit3,
  Plus,
  Copy,
  Search,
  Play,
  Pause,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  X,
  type LucideIcon,
} from 'lucide-react';
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

const iconComponentMap: Record<IconName, LucideIcon> = {
  'mic': Mic2,
  'music': Music,
  'list': ListMusic,
  'settings': Settings,
  'trash': Trash2,
  'edit': Edit3,
  'plus': Plus,
  'copy': Copy,
  'search': Search,
  'play': Play,
  'pause': Pause,
  'refresh': RotateCcw,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'x': X,
};

interface CustomIconProps {
  name: IconName;
  className?: string;
  size?: number;
  lucideFallback?: string;
}

/**
 * CustomIcon component that displays optimized Lucide icons by default
 * with support for custom PNG overrides if available.
 */
export default function CustomIcon({ 
  name, 
  className, 
  size = 24, 
}: CustomIconProps) {
  const IconComponent = iconComponentMap[name] || Music;

  return <IconComponent className={className} size={size} />;
}
