const { CATEGORIES, categoryToExts } = require('../../utils/categories');

describe('CATEGORIES map', () => {
  test('exports the five expected category keys', () => {
    expect(Object.keys(CATEGORIES).sort()).toEqual(
      ['archive', 'code', 'config', 'document', 'media'].sort()
    );
  });

  test('document category includes pdf, docx, txt, md', () => {
    expect(CATEGORIES.document).toEqual(expect.arrayContaining(['pdf', 'docx', 'txt', 'md']));
  });

  test('all extensions are lowercase strings without leading dot', () => {
    for (const exts of Object.values(CATEGORIES)) {
      for (const ext of exts) {
        expect(typeof ext).toBe('string');
        expect(ext).toBe(ext.toLowerCase());
        expect(ext.startsWith('.')).toBe(false);
      }
    }
  });

  test('CATEGORIES is frozen', () => {
    expect(Object.isFrozen(CATEGORIES)).toBe(true);
  });

  test('inner category arrays are frozen', () => {
    for (const exts of Object.values(CATEGORIES)) {
      expect(Object.isFrozen(exts)).toBe(true);
    }
  });
});

describe('categoryToExts', () => {
  test('returns the array for a known category', () => {
    expect(categoryToExts('document')).toEqual(CATEGORIES.document);
  });

  test('returns null for an unknown category', () => {
    expect(categoryToExts('nonsense')).toBeNull();
    expect(categoryToExts('')).toBeNull();
    expect(categoryToExts(null)).toBeNull();
    expect(categoryToExts(undefined)).toBeNull();
  });
});
