import {
  Lightbulb,
  Star,
  TriangleAlert,
  CircleQuestionMark,
  Heart,
  Flag,
  Bookmark,
  User,
  MapPin,
  Clock,
  Pencil,
  CircleCheck,
  Eye,
  Zap,
  Lock,
  MessageCircle,
  Ban,
  type LucideIcon,
} from 'lucide-react';
import { CARD_ICONS } from './types';

const MAP: Record<string, LucideIcon> = {
  lightbulb: Lightbulb,
  star: Star,
  'triangle-alert': TriangleAlert,
  'circle-help': CircleQuestionMark,
  heart: Heart,
  flag: Flag,
  bookmark: Bookmark,
  user: User,
  'map-pin': MapPin,
  clock: Clock,
  pencil: Pencil,
  'check-circle': CircleCheck,
  eye: Eye,
  zap: Zap,
  lock: Lock,
  'message-circle': MessageCircle,
};

export function iconFor(key: string | null | undefined): LucideIcon | null {
  if (!key) return null;
  return MAP[key] ?? null;
}

export { CARD_ICONS, Ban };
export type { LucideIcon };
