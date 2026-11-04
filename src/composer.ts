import type { CodexType } from './types';

/* Clasificación de ideas del composer inferior (adaptada del prototipo
   Brainstorming Canvas, con léxico EN/ES ampliado). */

export type IdeaKind = 'character' | 'location' | 'item' | 'event' | 'idea';

/** Metadatos derivados: icono, color de la paleta y tag en español. */
export const IDEA_STYLE: Record<IdeaKind, { color: string; icon: string; tag: string }> = {
  character: { color: '#2563EB', icon: 'user', tag: 'personaje' },
  location: { color: '#16A34A', icon: 'map-pin', tag: 'lugar' },
  item: { color: '#CA8A04', icon: 'bookmark', tag: 'objeto' },
  event: { color: '#EA580C', icon: 'clock', tag: 'evento' },
  idea: { color: '#9333EA', icon: 'lightbulb', tag: 'idea' },
};

/* Solo estos tipos generan entrada de codex (evento e idea no lo son). */
export const IDEA_CODEX: Partial<Record<IdeaKind, CodexType>> = {
  character: 'character',
  location: 'location',
  item: 'item',
};

export function classifyIdea(text: string): IdeaKind {
  if (
    /\b(city|room|forest|island|archive|station|castle|town|village|mountain|street|plaza|cave|desert|lake|ciudad|habitaci[oó]n|bosque|isla|archivo|estaci[oó]n|castillo|pueblo|monta[nñ]a|calle|cueva|desierto|lago)\b/i.test(
      text,
    )
  )
    return 'location';
  if (
    /\b(he|she|they|girl|boy|woman|man|captain|doctor|princess|witch|merchant|girl|ella|capit[aá]n|doctora|ni[nñ]a|ni[nñ]o|mujer|bruja|princesa|mercader)\b/i.test(
      text,
    )
  )
    return 'character';
  if (
    /\b(when|after|before|arrives|vanishes|discovers|returns|kills|marries|llega|desaparece|descubre|regresa|mata|cuando|despu[eé]s|antes)\b/i.test(
      text,
    )
  )
    return 'event';
  if (
    /\b(sword|key|map|letter|crown|ring|dagger|espada|llave|mapa|carta|corona|anillo|daga|reliquia)\b/i.test(
      text,
    )
  )
    return 'item';
  return 'idea';
}

/** Primer sustantivo propio: mayúscula inicial que no abre la frase. */
export function detectName(text: string): string | null {
  const m = /[\s,;:—–.(]([A-ZÁÉÍÓÚÑÜ][\p{L}]{2,})/u.exec(text);
  return m ? m[1] : null;
}
