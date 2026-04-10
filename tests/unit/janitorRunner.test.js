const EventEmitter = require('events');
const { ObjectId } = require('mongodb');

jest.mock('../../services/janitorProfiles', () => ({
  get: jest.fn(),
  COLLECTION: 'janitor_profiles'
}));
jest.mock('../../services/scanner', () => {
  const EventEmitter = require('events');
  const instances = [];
  class MockScanner extends EventEmitter {
    constructor(db) { super(); this.db = db; instances.push(this); }
    async run(opts) {
      this.lastOpts = opts;
      // Simulate async scan completion
      setImmediate(() => this.emit('done', { status: 'complete', counts: { files_seen: 10, hashed: 5, errors: 0 } }));
    }
    stop() { this.stopped = true; }
  }
  return { Scanner: MockScanner, _instances: instances };
});
jest.mock('../../services/dedupScanner', () => ({
  buildDedupReport: jest.fn(),
  saveReport: jest.fn()
}));
jest.mock('../../services/janitorService', () => {
  const actual = jest.requireActual('../../services/janitorService');
  return {
    ...actual,
    buildSuggestions: jest.fn(() => [])
  };
});
jest.mock('../../services/janitorAI', () => ({
  callAI: jest.fn()
}));

const janitorProfiles = require('../../services/janitorProfiles');
const scannerMod = require('../../services/scanner');
const dedupScanner = require('../../services/dedupScanner');
const janitorService = require('../../services/janitorService');
const janitorAI = require('../../services/janitorAI');
const janitorRunner = require('../../services/janitorRunner');

function makeMockDb() {
  const collections = {};
  return {
    _collections: collections,
    collection: jest.fn((name) => {
      if (!collections[name]) {
        collections[name] = {
          docs: [],
          insertOne: jest.fn(async (doc) => {
            const _id = new ObjectId();
            collections[name].docs.push({ ...doc, _id });
            return { insertedId: _id };
          }),
          updateOne: jest.fn(async (filter, update) => {
            const idx = collections[name].docs.findIndex(d => String(d._id) === String(filter._id));
            if (idx !== -1) {
              if (update.$set) collections[name].docs[idx] = { ...collections[name].docs[idx], ...update.$set };
            }
            return { matchedCount: idx === -1 ? 0 : 1 };
          }),
          findOne: jest.fn(async (filter) => {
            return collections[name].docs.find(d => String(d._id) === String(filter._id)) || null;
          })
        };
      }
      return collections[name];
    })
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  scannerMod._instances.length = 0;
  janitorRunner._reset(); // clear in-memory concurrency guard
});

const profileFixture = {
  _id: new ObjectId(),
  name: 'Test Profile',
  roots: ['/mnt/datalake/test'],
  extensions: { include: [], exclude: [] },
  computeHashes: true,
  policies: ['delete_duplicates'],
  aiTriage: false
};

describe('janitorRunner.runProfile', () => {
  test('happy path: scan → dedup → persist run as complete', async () => {
    janitorProfiles.get.mockResolvedValue(profileFixture);
    dedupScanner.buildDedupReport.mockResolvedValue({ groups: [], summary: {} });
    dedupScanner.saveReport.mockResolvedValue(new ObjectId());
    janitorService.buildSuggestions.mockReturnValue([
      { policy: 'delete_duplicates', files: ['/a', '/b'], reason: 'dup', space_saved: 100 }
    ]);

    const db = makeMockDb();
    const result = await janitorRunner.runProfile(db, String(profileFixture._id));

    expect(result.ok).toBe(true);
    expect(result.run_id).toBeDefined();

    const runs = db._collections['janitor_runs'].docs;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('complete');
    expect(runs[0].profile_name).toBe('Test Profile');
    expect(runs[0].proposed_actions).toHaveLength(1);
    expect(runs[0].proposed_actions[0].status).toBe('pending');
  });

  test('returns notFound when profile does not exist', async () => {
    janitorProfiles.get.mockResolvedValue(null);
    const db = makeMockDb();
    const result = await janitorRunner.runProfile(db, String(new ObjectId()));
    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
  });

  test('concurrency guard rejects a 2nd call for the same profile', async () => {
    janitorProfiles.get.mockResolvedValue(profileFixture);
    dedupScanner.buildDedupReport.mockResolvedValue({ groups: [], summary: {} });
    dedupScanner.saveReport.mockResolvedValue(new ObjectId());

    const db = makeMockDb();
    const first = janitorRunner.runProfile(db, String(profileFixture._id));
    const second = await janitorRunner.runProfile(db, String(profileFixture._id));

    expect(second.ok).toBe(false);
    expect(second.alreadyRunning).toBe(true);
    await first;
  });

  test('AI triage failure does not fail the run', async () => {
    janitorProfiles.get.mockResolvedValue({ ...profileFixture, aiTriage: true });
    dedupScanner.buildDedupReport.mockResolvedValue({ groups: [], summary: {} });
    dedupScanner.saveReport.mockResolvedValue(new ObjectId());
    janitorAI.callAI.mockRejectedValue(new Error('Ollama unreachable'));

    const db = makeMockDb();
    const result = await janitorRunner.runProfile(db, String(profileFixture._id));

    expect(result.ok).toBe(true);
    const run = db._collections['janitor_runs'].docs[0];
    expect(run.status).toBe('complete');
    expect(run.ai_triage).toEqual({ error: 'Ollama unreachable' });
  });

  test('dedup failure recorded but run completes', async () => {
    janitorProfiles.get.mockResolvedValue(profileFixture);
    dedupScanner.buildDedupReport.mockRejectedValue(new Error('agg failed'));

    const db = makeMockDb();
    const result = await janitorRunner.runProfile(db, String(profileFixture._id));

    expect(result.ok).toBe(true);
    const run = db._collections['janitor_runs'].docs[0];
    expect(run.status).toBe('complete');
    expect(run.dedup_error).toBe('agg failed');
  });

  test('scanner failure marks run as failed', async () => {
    janitorProfiles.get.mockResolvedValue(profileFixture);
    // Override mock to throw on run
    const realScanner = scannerMod.Scanner;
    scannerMod.Scanner = class FailScanner extends EventEmitter {
      constructor() { super(); }
      async run() { throw new Error('disk on fire'); }
    };

    const db = makeMockDb();
    const result = await janitorRunner.runProfile(db, String(profileFixture._id));

    expect(result.ok).toBe(false);
    const run = db._collections['janitor_runs'].docs[0];
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/disk on fire/);

    scannerMod.Scanner = realScanner;
  });
});
