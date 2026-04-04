jest.mock('../../utils/fetch-utils', () => ({
  fetchWithTimeoutAndRetry: jest.fn()
}));

jest.mock('../../utils/logger', () => ({
  log: jest.fn()
}));

const { fetchWithTimeoutAndRetry } = require('../../utils/fetch-utils');
const { buildPrompt, parseAIResponse, resolveJanitorTarget, ACTIONS } = require('../../services/janitorAI');

describe('ACTIONS', () => {
  test('defines all four action types', () => {
    expect(ACTIONS).toEqual(
      expect.objectContaining({
        triage: expect.any(Object),
        resolve_duplicates: expect.any(Object),
        analyze_path: expect.any(Object),
        chat: expect.any(Object)
      })
    );
  });

  test('each action has a system prompt string', () => {
    for (const [key, action] of Object.entries(ACTIONS)) {
      expect(typeof action.system).toBe('string');
      expect(action.system.length).toBeGreaterThan(20);
    }
  });
});

describe('buildPrompt', () => {
  test('returns model, system, and prompt fields', () => {
    const result = buildPrompt('chat', { message: 'hello' });
    expect(result).toHaveProperty('model', 'qwen2.5:7b');
    expect(result).toHaveProperty('system');
    expect(result).toHaveProperty('prompt');
    expect(result.prompt).toContain('hello');
  });

  test('triage action includes file context in prompt', () => {
    const context = {
      files: [{ path: '/mnt/datalake/a.txt', size: 100 }],
      stats: { totalFiles: 1 }
    };
    const result = buildPrompt('triage', context);
    expect(result.prompt).toContain('/mnt/datalake/a.txt');
    expect(result.system).toContain('KEEP');
  });

  test('resolve_duplicates includes duplicate paths', () => {
    const context = {
      duplicates: [
        { path: '/mnt/datalake/a.txt', mtime: '2024-01-01' },
        { path: '/mnt/datalake/b.txt', mtime: '2025-01-01' }
      ]
    };
    const result = buildPrompt('resolve_duplicates', context);
    expect(result.prompt).toContain('/mnt/datalake/a.txt');
    expect(result.prompt).toContain('/mnt/datalake/b.txt');
  });

  test('throws on unknown action', () => {
    expect(() => buildPrompt('unknown', {})).toThrow(/Unknown action/);
  });
});

describe('parseAIResponse', () => {
  test('extracts JSON from markdown code fence', () => {
    const raw = 'Here is my analysis:\n```json\n{"categories":[]}\n```\nDone.';
    const result = parseAIResponse(raw);
    expect(result).toEqual({ categories: [] });
  });

  test('extracts plain JSON object', () => {
    const raw = '{"keep":"/a.txt","delete":["/b.txt"],"reason":"older"}';
    const result = parseAIResponse(raw);
    expect(result).toEqual({ keep: '/a.txt', delete: ['/b.txt'], reason: 'older' });
  });

  test('returns raw text when no JSON found', () => {
    const raw = 'I recommend keeping all files.';
    const result = parseAIResponse(raw);
    expect(result).toEqual({ text: raw });
  });
});

describe('resolveJanitorTarget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('prefers scheduler advice when core responds', async () => {
    fetchWithTimeoutAndRetry
      .mockResolvedValueOnce({
        json: async () => ({
          status: 'success',
          data: { recommendation: { host: 'secondary', hostUrl: 'http://secondary:11434' } }
        })
      })
      .mockResolvedValueOnce({
        json: async () => ({
          status: 'success',
          data: { claimId: 'janitor-claim-1' }
        })
      });

    const result = await resolveJanitorTarget('qwen2.5:7b');

    expect(result).toEqual({
      source: 'scheduler',
      url: 'http://secondary:11434',
      host: 'secondary',
      claimId: 'janitor-claim-1'
    });
  });

  test('falls back to local default when scheduler lookup fails', async () => {
    fetchWithTimeoutAndRetry.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const result = await resolveJanitorTarget('qwen2.5:7b');

    expect(result).toEqual({
      source: 'fallback',
      url: 'http://192.168.2.99:11434',
      host: 'tertiary',
      claimId: null
    });
  });
});
