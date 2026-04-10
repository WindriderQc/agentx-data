const janitorProfiles = require('../../services/janitorProfiles');

jest.mock('../../services/janitorService', () => ({
  ...jest.requireActual('../../services/janitorService'),
  resolveAllowedPath: jest.fn()
}));
const { resolveAllowedPath } = require('../../services/janitorService');

beforeEach(() => {
  jest.clearAllMocks();
  resolveAllowedPath.mockResolvedValue({ ok: true, realPath: '/mnt/datalake/test' });
});

describe('janitorProfiles.validate', () => {
  const valid = () => ({
    name: 'Media Cleanup',
    roots: ['/mnt/datalake/media'],
    extensions: { include: [], exclude: ['iso'] },
    computeHashes: true,
    policies: ['delete_duplicates'],
    schedule: { enabled: true, intervalMinutes: 1440 },
    aiTriage: false
  });

  test('accepts a valid profile', async () => {
    const result = await janitorProfiles.validate(valid());
    expect(result.ok).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  test('rejects empty name', async () => {
    const doc = valid(); doc.name = '';
    const result = await janitorProfiles.validate(doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/name/i);
  });

  test('rejects empty roots', async () => {
    const doc = valid(); doc.roots = [];
    const result = await janitorProfiles.validate(doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/roots/i);
  });

  test('rejects when a root fails resolveAllowedPath', async () => {
    resolveAllowedPath.mockResolvedValueOnce({ ok: false, reason: 'Blocked by safety policy' });
    const result = await janitorProfiles.validate(valid());
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/Blocked by safety policy/);
  });

  test('rejects unknown policy id', async () => {
    const doc = valid(); doc.policies = ['delete_duplicates', 'nuke_everything'];
    const result = await janitorProfiles.validate(doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/unknown policy: nuke_everything/);
  });

  test('accepts schedule = null', async () => {
    const doc = valid(); doc.schedule = null;
    const result = await janitorProfiles.validate(doc);
    expect(result.ok).toBe(true);
  });

  test('rejects schedule.enabled=true without intervalMinutes', async () => {
    const doc = valid(); doc.schedule = { enabled: true };
    const result = await janitorProfiles.validate(doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/intervalMinutes/);
  });

  test('rejects intervalMinutes below 5', async () => {
    const doc = valid(); doc.schedule.intervalMinutes = 1;
    const result = await janitorProfiles.validate(doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/intervalMinutes/);
  });

  test('rejects intervalMinutes above 43200', async () => {
    const doc = valid(); doc.schedule.intervalMinutes = 99999;
    const result = await janitorProfiles.validate(doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/intervalMinutes/);
  });
});

describe('janitorProfiles CRUD (mocked db)', () => {
  function makeMockDb(initialProfiles = []) {
    const profiles = [...initialProfiles];
    return {
      _profiles: profiles,
      collection: jest.fn(() => ({
        find: () => ({ sort: () => ({ toArray: async () => [...profiles] }) }),
        findOne: async (filter) => {
          if (filter._id) return profiles.find(p => String(p._id) === String(filter._id)) || null;
          if (filter.name) {
            return profiles.find(p =>
              p.name === filter.name &&
              (!filter._id || String(p._id) !== String(filter._id?.$ne))
            ) || null;
          }
          return null;
        },
        insertOne: async (doc) => {
          const inserted = { ...doc, _id: { toString: () => 'gen-' + (profiles.length + 1) } };
          profiles.push(inserted);
          return { insertedId: inserted._id };
        },
        findOneAndUpdate: async (filter, update) => {
          const idx = profiles.findIndex(p => String(p._id) === String(filter._id));
          if (idx === -1) return { value: null };
          profiles[idx] = { ...profiles[idx], ...update.$set };
          return { value: profiles[idx] };
        },
        deleteOne: async (filter) => {
          const idx = profiles.findIndex(p => String(p._id) === String(filter._id));
          if (idx === -1) return { deletedCount: 0 };
          profiles.splice(idx, 1);
          return { deletedCount: 1 };
        }
      }))
    };
  }

  const validInput = () => ({
    name: 'Media',
    roots: ['/mnt/datalake/media'],
    extensions: { include: [], exclude: [] },
    computeHashes: true,
    policies: ['delete_duplicates'],
    schedule: null,
    aiTriage: false
  });

  test('create returns conflict on duplicate name', async () => {
    const db = makeMockDb([{ _id: 'a', name: 'Media' }]);
    const result = await janitorProfiles.create(db, validInput());
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
  });

  test('create normalizes and inserts', async () => {
    const db = makeMockDb();
    const result = await janitorProfiles.create(db, validInput());
    expect(result.ok).toBe(true);
    expect(result.profile.name).toBe('Media');
    expect(result.profile.computeHashes).toBe(true);
    expect(result.profile.createdAt).toBeInstanceOf(Date);
  });

  test('remove returns notFound for unknown id', async () => {
    const db = makeMockDb();
    const result = await janitorProfiles.remove(db, '507f1f77bcf86cd799439011');
    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
  });

  test('remove returns notFound for malformed id', async () => {
    const db = makeMockDb();
    const result = await janitorProfiles.remove(db, 'not-an-objectid');
    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
  });
});
