/**
 * Component: Release Language Detection Tests
 * Documentation: documentation/phase3/ranking-algorithm.md
 */

import { describe, expect, it } from 'vitest';
import { detectReleaseLanguage, filterByLanguage, matchesRequiredLanguage } from '@/lib/utils/release-language';

describe('detectReleaseLanguage', () => {
  it.each([
    ['Andreas Eschbach - Das Jesus-Video (Hörbuch, ungekürzt)', 'german'],
    ['Sebastian Fitzek - Der Heimweg [GER]', 'german'],
    ['Project Hail Mary - German Edition', 'german'],
    ['Dune - Frank Herbert - Deutsch - 2021', 'german'],
    ['Le Petit Prince - livre audio lu par Gérard Philipe', 'french'],
    ['Harry Potter (FR) MP3', 'french'],
    ['Cien años de soledad [Español] m4b', 'spanish'],
    ['Il nome della rosa - letto da Pino Insegno', 'italian'],
    ['De ontdekking van de hemel - luisterboek', 'dutch'],
    ['Wiedźmin - czyta Krzysztof Gosztyła', 'polish'],
    ['Мастер и Маргарита аудиокнига', 'russian'],
    ['Millennium (SWE) ljudbok', 'swedish'],
    ['Harry Potter [ENG/GER] m4b', 'english'], // multi-language incl. English
    ['The Martian [English] 64kbps', 'english'],
  ])('%s → %s', (title, expected) => {
    expect(detectReleaseLanguage(title)).toBe(expected);
  });

  it('marks unidentified non-English releases as other', () => {
    expect(detectReleaseLanguage('三体 刘慈欣 有声书')).toBe('other');
    expect(detectReleaseLanguage('El Principito - audiolibro')).toBe('other');
  });

  it.each([
    'The German Girl - Armando Lucas Correa (Unabridged)',
    'Russian Doll - M4B',
    'The Dutch House by Ann Patchett',
    'The French Lieutenant\'s Woman',
    'Gerald Durrell - My Family and Other Animals',
    'Colleen Hoover - It Starts with Us (It Ends with Us 2)',
    'Ready Player Two [Sci-Fi] 2020',
    'Dune Part Two (Unabridged) [64k]',
    'Brandon Sanderson - Mistborn (Book 1) - Michael Kramer',
    'Stephen King - IT [2017] m4b',
  ])('no false positive: %s', (title) => {
    expect(detectReleaseLanguage(title)).toBeNull();
  });

  it('ignores a marker that is part of the requested book title', () => {
    expect(detectReleaseLanguage('Deutsche Bank Story - Unabridged', { bookTitle: 'Deutsche Bank Story' })).toBeNull();
    expect(detectReleaseLanguage('In German Lands - Audiobook', { bookTitle: 'In German Lands' })).toBeNull();
  });

  it('trusts indexer-provided languages when present', () => {
    expect(detectReleaseLanguage('Some Book', { languages: [{ id: 4, name: 'German' }] })).toBe('german');
    expect(detectReleaseLanguage('Some Book [GER]', { languages: [{ name: 'English' }, { name: 'German' }] })).toBe('english');
    expect(detectReleaseLanguage('Some Book', { languages: [{ name: 'Unknown' }] })).toBeNull();
  });
});

describe('matchesRequiredLanguage / filterByLanguage', () => {
  const results = [
    { title: 'Der Astronaut (Hörbuch)' },
    { title: 'Project Hail Mary (Unabridged)' },
    { title: 'Project Hail Mary [ENG]' },
    { title: '三体' },
  ];

  it('keeps English and untagged releases when English is required', () => {
    const { kept, removed } = filterByLanguage(results, 'english', 'Project Hail Mary');
    expect(kept.map(r => r.title)).toEqual(['Project Hail Mary (Unabridged)', 'Project Hail Mary [ENG]']);
    expect(removed).toHaveLength(2);
  });

  it('keeps everything when set to any', () => {
    expect(filterByLanguage(results, 'any').kept).toHaveLength(4);
  });

  it('for another required language, drops other known languages but keeps untagged', () => {
    expect(matchesRequiredLanguage({ title: 'Der Astronaut (Hörbuch)' }, 'german')).toBe(true);
    expect(matchesRequiredLanguage({ title: 'Project Hail Mary [ENG]' }, 'german')).toBe(false);
    expect(matchesRequiredLanguage({ title: 'Project Hail Mary' }, 'german')).toBe(true);
  });
});
