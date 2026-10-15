import type { Card, CodexEntry } from './types';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Términos buscables de una entrada: nombre + alias separados por coma. */
export function entryTerms(entry: CodexEntry): string[] {
  const raw = [entry.name, ...entry.aliases.flatMap((a) => a.split(','))];
  return raw.map((t) => t.trim()).filter(Boolean);
}

function termRegex(term: string): RegExp {
  // Igual que NodeWriter: coincidencia por palabra completa, insensible a caso y acentos parciales.
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?:$|[^\\p{L}\\p{N}])`, 'iu');
}

/** Ids de entradas del codex mencionadas en el texto de una tarjeta. */
export function findMentions(text: string, entries: CodexEntry[]): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const entry of entries) {
    const terms = entryTerms(entry);
    if (terms.some((t) => termRegex(t).test(text))) {
      found.push(entry.id);
    }
  }
  return found;
}

export function cardText(card: Card): string {
  return [card.title, card.summary, card.content].filter(Boolean).join('\n');
}

/** Tarjetas que mencionan una entrada, para la vista "Aparece en". */
export function cardsMentioning(entry: CodexEntry, cards: Card[]): Card[] {
  const terms = entryTerms(entry);
  if (terms.length === 0) return [];
  const regexes = terms.map(termRegex);
  return cards.filter((c) => {
    const text = cardText(c);
    return regexes.some((re) => re.test(text));
  });
}
