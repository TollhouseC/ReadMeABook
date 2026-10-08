/**
 * Component: Release Date Parser (legacy Audible series pages)
 * Documentation: documentation/features/watched-lists.md
 *
 * Legacy series rows show "Release date: 10-14-26" — MM-DD-YY on US pages, DD-MM-YY
 * on some regions. Only unambiguous dates are returned (a part > 12 decides the
 * order, or ISO YYYY-MM-DD); ambiguous ones return undefined so a book is never held
 * back as "upcoming" on a guessed date.
 */

export function parseLegacyReleaseDate(text: string | undefined): string | undefined {
  if (!text) return undefined;

  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const parts = text.match(/(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})/);
  if (!parts) return undefined;

  const [a, b] = [parseInt(parts[1], 10), parseInt(parts[2], 10)];
  const year = parts[3].length === 2 ? 2000 + parseInt(parts[3], 10) : parseInt(parts[3], 10);

  let month: number;
  let day: number;
  if (a > 12 && b <= 12) [day, month] = [a, b];
  else if (b > 12 && a <= 12) [month, day] = [a, b];
  else if (a === b) [month, day] = [a, b];
  else return undefined;

  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
