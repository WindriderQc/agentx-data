# Janitor Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an AI-powered janitor dashboard page with health metrics, storage breakdown, duplicate groups, cleanup suggestions, AI triage, and a conversational AI chat panel.

**Architecture:** Standalone `janitor.html` page served by agentx-core, with JS logic in `janitor.js`. All data fetched from agentx-data (port 3083) via the existing `/api/data/*` proxy. One new backend service (`janitorAI.js`) wraps Ollama calls to qwen2.5:7b on UGFrank. Frontend follows the IIFE pattern from `storage.js`; backend follows Express controller/service pattern.

**Tech Stack:** Vanilla JS, HTML/CSS (dark theme, Space Grotesk), Express, MongoDB, Ollama API

**Spec:** `docs/superpowers/specs/2026-04-03-janitor-dashboard-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `data/services/janitorAI.js` | Ollama integration: prompt templates, structured response parsing |
| Create | `data/tests/unit/janitorAI.test.js` | Unit tests for AI service |
| Update | `data/controllers/janitorController.js` | Add `aiChat` handler |
| Update | `data/routes/janitor.routes.js` | Add `POST /ai` route |
| Create | `core/public/janitor.html` | Page shell, CSS (jn- prefix), section skeletons |
| Create | `core/public/js/janitor.js` | All page logic: polling, rendering, AI chat |
| Update | `core/public/js/components/nav.js` | Add "Janitor" entry under "More > Data" |

---

### Task 1: Create `data/services/janitorAI.js` — Ollama integration

**Files:**
- Create: `data/services/janitorAI.js`
- Create: `data/tests/unit/janitorAI.test.js`

- [ ] **Step 1: Write failing tests for janitorAI**

```js
// data/tests/unit/janitorAI.test.js
const { buildPrompt, parseAIResponse, ACTIONS } = require('../../services/janitorAI');

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/janitorAI.test.js --no-coverage 2>&1 | tail -5`
Expected: FAIL — `Cannot find module '../../services/janitorAI'`

- [ ] **Step 3: Implement janitorAI.js**

```js
// data/services/janitorAI.js
/**
 * janitorAI.js — Ollama integration for the janitor dashboard.
 * Builds prompts, calls qwen2.5:7b on UGFrank, parses structured responses.
 */
const { fetchWithTimeoutAndRetry } = require('../utils/fetch-utils');
const { log } = require('../utils/logger');

const OLLAMA_URL = process.env.JANITOR_AI_URL || 'http://192.168.2.99:11434';
const OLLAMA_MODEL = process.env.JANITOR_AI_MODEL || 'qwen2.5:7b';

const ACTIONS = {
  triage: {
    system: `You are a storage analyst. Given file metadata (paths, sizes, ages, extensions), classify files into three categories: KEEP, ARCHIVE, or JUNK. KEEP = actively used or important. ARCHIVE = stale but potentially valuable (suggest cold storage). JUNK = safe to delete (temp, cache, orphaned). Respond ONLY with JSON: { "categories": [{ "label": "KEEP|ARCHIVE|JUNK", "reason": "string", "files_count": number, "total_size": number, "paths": ["..."] }] }`
  },
  resolve_duplicates: {
    system: `You are a deduplication advisor. Given a set of duplicate file paths with timestamps and locations, recommend which copy to keep and which to delete. Consider: originals over copies, organized paths over temp/backup paths, oldest creation date as the original. Respond ONLY with JSON: { "keep": "path", "delete": ["paths"], "reason": "string" }`
  },
  analyze_path: {
    system: `You are a storage analyst. Given directory statistics (file counts, sizes, extensions, ages), identify anomalies, waste patterns, and actionable recommendations. Respond ONLY with JSON: { "findings": [{ "type": "anomaly|waste|recommendation", "severity": "high|medium|low", "description": "string", "recommendation": "string" }] }`
  },
  chat: {
    system: `You are a disk janitor AI assistant for a self-hosted NAS/datalake. You have access to storage statistics and file metadata provided as context. Answer questions about the filesystem, suggest cleanups, identify waste, and help the user understand their storage usage. Be concise and actionable. When suggesting deletions, always recommend a dry-run first.`
  }
};

/**
 * Build an Ollama prompt payload for a given action.
 * @param {string} action - One of: triage, resolve_duplicates, analyze_path, chat
 * @param {Object} context - Action-specific context data
 * @returns {{ model: string, system: string, prompt: string, stream: boolean }}
 */
function buildPrompt(action, context = {}) {
  const actionDef = ACTIONS[action];
  if (!actionDef) throw new Error(`Unknown action: ${action}`);

  let prompt;
  switch (action) {
    case 'triage':
      prompt = `Analyze these files and classify them:\n\n${JSON.stringify(context.files || [], null, 2)}\n\nOverall stats: ${JSON.stringify(context.stats || {})}`;
      break;
    case 'resolve_duplicates':
      prompt = `These files are duplicates (same SHA256 hash). Which copy should we keep?\n\n${JSON.stringify(context.duplicates || [], null, 2)}`;
      break;
    case 'analyze_path':
      prompt = `Analyze this directory:\nPath: ${context.path || 'unknown'}\nStats: ${JSON.stringify(context.stats || {})}`;
      break;
    case 'chat':
      prompt = context.message || '';
      if (context.stats) prompt += `\n\n[Storage context: ${JSON.stringify(context.stats)}]`;
      break;
  }

  return { model: OLLAMA_MODEL, system: actionDef.system, prompt, stream: false };
}

/**
 * Parse AI response text, extracting JSON if present.
 * @param {string} raw - Raw response text from Ollama
 * @returns {Object} Parsed JSON or { text: raw }
 */
function parseAIResponse(raw) {
  if (!raw || typeof raw !== 'string') return { text: '' };

  // Try extracting from markdown code fence
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  // Try parsing the whole string as JSON
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch {}
  }

  return { text: raw };
}

/**
 * Call Ollama and return structured response.
 * @param {string} action - Action type
 * @param {Object} context - Context data
 * @returns {Promise<{ action, result, model, duration_ms }>}
 */
async function callAI(action, context = {}) {
  const payload = buildPrompt(action, context);
  const start = Date.now();

  const res = await fetchWithTimeoutAndRetry(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 60000,
    retries: 1,
    name: `janitor-ai-${action}`
  });

  const data = await res.json();
  const raw = data.response || '';
  const result = parseAIResponse(raw);

  log(`Janitor AI [${action}] completed in ${Date.now() - start}ms`, 'info');

  return {
    action,
    result,
    model: OLLAMA_MODEL,
    duration_ms: Date.now() - start
  };
}

module.exports = { ACTIONS, buildPrompt, parseAIResponse, callAI, OLLAMA_URL, OLLAMA_MODEL };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/janitorAI.test.js --no-coverage 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/janitorAI.js tests/unit/janitorAI.test.js
git commit -m "feat(janitor): add janitorAI service — Ollama integration with prompt templates"
```

---

### Task 2: Add AI route and controller handler

**Files:**
- Modify: `data/controllers/janitorController.js`
- Modify: `data/routes/janitor.routes.js`
- Modify: `data/tests/unit/janitorRoutes.test.js`

- [ ] **Step 1: Write failing test for the AI route**

Append to `data/tests/unit/janitorRoutes.test.js`:

```js
// At top of file, add mock for janitorAI
jest.mock('../../services/janitorAI', () => ({
  callAI: jest.fn(),
  ACTIONS: { triage: {}, resolve_duplicates: {}, analyze_path: {}, chat: {} }
}));

const janitorAI = require('../../services/janitorAI');

describe('POST /api/v1/janitor/ai', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 400 when action is missing', async () => {
    const res = await request(buildApp()).post('/api/v1/janitor/ai').send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/action required/);
  });

  test('returns 400 for unknown action', async () => {
    const res = await request(buildApp()).post('/api/v1/janitor/ai').send({ action: 'hack' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid action/);
  });

  test('calls AI and returns result', async () => {
    janitorAI.callAI.mockResolvedValue({
      action: 'chat',
      result: { text: 'Your storage looks healthy.' },
      model: 'qwen2.5:7b',
      duration_ms: 500
    });

    const res = await request(buildApp()).post('/api/v1/janitor/ai').send({
      action: 'chat',
      context: { message: 'how is my storage?' }
    });

    expect(res.status).toBe(200);
    expect(res.body.data.result.text).toContain('healthy');
    expect(janitorAI.callAI).toHaveBeenCalledWith('chat', { message: 'how is my storage?' });
  });

  test('returns 503 when Ollama is unreachable', async () => {
    janitorAI.callAI.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await request(buildApp()).post('/api/v1/janitor/ai').send({
      action: 'chat',
      context: { message: 'hello' }
    });

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/AI service unavailable/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/janitorRoutes.test.js -t "POST /api/v1/janitor/ai" --no-coverage 2>&1 | tail -5`
Expected: FAIL — route not found (404)

- [ ] **Step 3: Add `aiChat` handler to janitorController.js**

Append before `module.exports` in `data/controllers/janitorController.js`:

```js
const janitorAI = require('../services/janitorAI');

/** POST /ai */
async function aiChat(req, res) {
  const { action, context } = req.body;
  if (!action) return res.status(400).json({ status: 'error', message: 'action required' });
  if (!janitorAI.ACTIONS[action]) {
    return res.status(400).json({ status: 'error', message: `Invalid action: ${action}. Valid: ${Object.keys(janitorAI.ACTIONS).join(', ')}` });
  }

  try {
    const result = await janitorAI.callAI(action, context || {});
    res.json({ status: 'success', data: result });
  } catch (err) {
    log(`Janitor AI failed: ${err.message}`, 'error');
    res.status(503).json({ status: 'error', message: 'AI service unavailable — Ollama may be offline' });
  }
}
```

Update `module.exports` to include `aiChat`:

```js
module.exports = { analyze, suggest, execute, listPolicies, dedupScan, dedupReport, dedupApprove, aiChat };
```

- [ ] **Step 4: Add route to janitor.routes.js**

Add before `module.exports` in `data/routes/janitor.routes.js`:

```js
router.post('/ai', janitorController.aiChat);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/janitorRoutes.test.js --no-coverage 2>&1 | tail -15`
Expected: All PASS

- [ ] **Step 6: Run all tests to confirm nothing broke**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/ --no-coverage 2>&1 | tail -10`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add controllers/janitorController.js routes/janitor.routes.js tests/unit/janitorRoutes.test.js
git commit -m "feat(janitor): add POST /ai route — Ollama chat, triage, dedup resolution"
```

---

### Task 3: Create `core/public/janitor.html` — page shell

**Files:**
- Create: `core/public/janitor.html`

- [ ] **Step 1: Create the HTML page with all section skeletons**

Create `core/public/janitor.html` with the full page shell. This file contains:
- Head with meta, fonts, styles.css link, Font Awesome, and inline `jn-` prefixed CSS
- Nav container + nav injection
- All 7 sections as empty skeletons with IDs that janitor.js will populate
- Toast element
- Script tags for nav.js and janitor.js

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AgentX - Disk Janitor</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/styles.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        /* Janitor — jn- prefix */
        .jn-container {
            padding-top: 90px; max-width: 1500px; margin: 0 auto;
            padding-left: 24px; padding-right: 24px; padding-bottom: 40px;
            min-height: 100vh; display: flex; gap: 16px;
        }
        .jn-main { flex: 1; min-width: 0; }

        /* Header */
        .jn-header {
            background: rgba(255,255,255,0.03); backdrop-filter: blur(10px);
            padding: 1.5rem 2rem; margin-bottom: 1.5rem; border-radius: 16px;
            border: 1px solid var(--panel-border);
            display: flex; justify-content: space-between; align-items: center;
        }
        .jn-header h1 { font-size: 24px; font-weight: 700; margin: 0; color: #fff; display: flex; align-items: center; gap: 10px; }
        .jn-header h1 i { color: var(--accent); }
        .jn-header p { color: var(--muted); margin: 4px 0 0; font-size: 13px; }
        .jn-header-actions { display: flex; gap: 8px; align-items: center; }

        /* Stat cards */
        .jn-stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 1.5rem; }
        .jn-stat {
            background: var(--panel-bg); border: 1px solid var(--panel-border);
            border-radius: 12px; padding: 16px; cursor: pointer; transition: border-color 0.2s;
        }
        .jn-stat:hover { border-color: rgba(124,240,255,0.3); }
        .jn-stat-top { display: flex; justify-content: space-between; align-items: flex-start; }
        .jn-stat-val { font-size: 24px; font-weight: 700; color: #fff; }
        .jn-stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin-top: 3px; }
        .jn-stat-sub { margin-top: 6px; font-size: 10px; color: var(--muted); }
        .jn-stat-tag { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }

        /* Panel */
        .jn-panel {
            background: var(--panel-bg); border: 1px solid var(--panel-border);
            border-radius: 12px; padding: 20px; margin-bottom: 1.5rem;
        }
        .jn-panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
        .jn-panel-title { font-size: 15px; font-weight: 600; color: #fff; display: flex; align-items: center; gap: 8px; }
        .jn-panel-title i { color: var(--accent); font-size: 13px; }
        .jn-panel-sub { font-size: 11px; color: var(--muted); font-weight: 400; margin-left: 8px; }
        .jn-panel-actions { display: flex; gap: 6px; }

        /* Buttons */
        .jn-btn {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 6px 14px; border-radius: 8px; font-family: inherit;
            font-size: 11px; font-weight: 600; cursor: pointer;
            border: 1px solid transparent; transition: all 0.2s; background: none;
        }
        .jn-btn:hover { filter: brightness(1.2); }
        .jn-btn:disabled { opacity: 0.4; cursor: not-allowed; filter: none; }
        .jn-btn-primary { background: rgba(124,240,255,0.12); color: #7cf0ff; border-color: rgba(124,240,255,0.25); }
        .jn-btn-success { background: rgba(34,197,94,0.12); color: #22c55e; border-color: rgba(34,197,94,0.25); }
        .jn-btn-warn { background: rgba(245,158,11,0.12); color: #f59e0b; border-color: rgba(245,158,11,0.25); }
        .jn-btn-danger { background: rgba(239,68,68,0.12); color: #ef4444; border-color: rgba(239,68,68,0.25); }
        .jn-btn-ai { background: rgba(139,92,246,0.12); color: #a78bfa; border-color: rgba(139,92,246,0.25); }
        .jn-btn-ghost { background: rgba(255,255,255,0.04); color: var(--muted); }

        /* Stacked bar */
        .jn-bar { height: 28px; display: flex; border-radius: 6px; overflow: hidden; gap: 2px; margin-bottom: 14px; }
        .jn-bar-seg { display: flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 700; color: #fff; min-width: 20px; }

        /* Table */
        .jn-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .jn-table th {
            text-align: left; padding: 8px 10px; color: var(--muted); font-weight: 500;
            font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px;
            border-bottom: 1px solid var(--panel-border);
        }
        .jn-table td { padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.03); color: var(--text); }
        .jn-table tr:hover td { background: rgba(255,255,255,0.02); }
        .jn-table .jn-mono { font-family: 'Fira Code', monospace; font-size: 11px; color: var(--accent); }

        /* Progress bar (inline) */
        .jn-progress { height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; }
        .jn-progress-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }

        /* Badges */
        .jn-badge {
            display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px;
            border-radius: 4px; font-size: 10px; font-weight: 600;
        }
        .jn-badge-delete { background: rgba(239,68,68,0.15); color: #ef4444; }
        .jn-badge-review { background: rgba(245,158,11,0.15); color: #f59e0b; }
        .jn-badge-keep { background: rgba(34,197,94,0.15); color: #22c55e; }
        .jn-badge-ai { background: rgba(139,92,246,0.15); color: #a78bfa; }

        /* Suggestion row */
        .jn-sug-row {
            display: flex; align-items: center; gap: 10px; padding: 10px;
            background: rgba(255,255,255,0.02); border-radius: 8px; margin-bottom: 6px;
        }
        .jn-sug-row input[type="checkbox"] { accent-color: #22c55e; }

        /* Triage cards */
        .jn-triage-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
        .jn-triage-card {
            padding: 14px; background: rgba(255,255,255,0.02); border-radius: 8px;
            border-left: 3px solid var(--muted); font-size: 12px;
        }
        .jn-triage-card.keep { border-left-color: #22c55e; }
        .jn-triage-card.archive { border-left-color: #f59e0b; }
        .jn-triage-card.junk { border-left-color: #ef4444; }
        .jn-triage-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }

        /* AI panel */
        .jn-ai-panel {
            width: 320px; min-width: 320px; background: rgba(0,0,0,0.25);
            border: 1px solid var(--panel-border); border-radius: 12px;
            display: flex; flex-direction: column; font-size: 12px;
            max-height: calc(100vh - 110px); position: sticky; top: 90px;
        }
        .jn-ai-panel.collapsed { width: 48px; min-width: 48px; }
        .jn-ai-panel.collapsed .jn-ai-body,
        .jn-ai-panel.collapsed .jn-ai-input,
        .jn-ai-panel.collapsed .jn-ai-model { display: none; }
        .jn-ai-header {
            padding: 14px 16px; border-bottom: 1px solid var(--panel-border);
            display: flex; align-items: center; gap: 8px; cursor: pointer;
        }
        .jn-ai-model { margin-left: auto; padding: 2px 8px; background: rgba(34,197,94,0.15); border-radius: 4px; color: #22c55e; font-size: 10px; }
        .jn-ai-body { flex: 1; padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
        .jn-ai-msg {
            border-radius: 10px; padding: 10px; line-height: 1.5; font-size: 11px;
            max-width: 95%; word-wrap: break-word;
        }
        .jn-ai-msg.assistant { background: rgba(139,92,246,0.1); color: var(--text); }
        .jn-ai-msg.user { background: rgba(255,255,255,0.05); color: var(--text); align-self: flex-end; }
        .jn-ai-input {
            padding: 12px; border-top: 1px solid var(--panel-border);
            display: flex; gap: 8px;
        }
        .jn-ai-input input {
            flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px; padding: 8px 12px; color: var(--text); font-family: inherit;
            font-size: 11px; outline: none;
        }
        .jn-ai-input input:focus { border-color: rgba(139,92,246,0.4); }
        .jn-ai-send {
            padding: 8px 12px; background: rgba(139,92,246,0.2); border-radius: 8px;
            color: #a78bfa; cursor: pointer; border: none; font-size: 14px;
        }
        .jn-ai-send:hover { background: rgba(139,92,246,0.3); }

        /* AI panel section (purple tint) */
        .jn-panel-ai { background: rgba(139,92,246,0.04); border-color: rgba(139,92,246,0.15); }

        /* Expand row detail */
        .jn-expand { padding: 0 10px 10px 28px; font-size: 11px; display: none; }
        .jn-expand.open { display: block; }
        .jn-file-row {
            display: flex; align-items: center; gap: 8px; padding: 5px 8px;
            border-radius: 4px; margin-bottom: 4px;
        }
        .jn-file-keep { background: rgba(34,197,94,0.06); border-left: 2px solid #22c55e; }
        .jn-file-delete { background: rgba(239,68,68,0.04); border-left: 2px solid rgba(239,68,68,0.3); }
        .jn-file-ai { background: rgba(139,92,246,0.06); border-left: 2px solid #a78bfa; }

        /* Toast */
        .jn-toast {
            position: fixed; bottom: 24px; right: 24px; padding: 12px 20px;
            border-radius: 10px; font-size: 14px; font-weight: 500; z-index: 9999;
            transform: translateY(80px); opacity: 0; transition: all 0.3s ease; pointer-events: none;
        }
        .jn-toast.show { transform: translateY(0); opacity: 1; }
        .jn-toast.info { background: rgba(124,240,255,0.15); color: #7cf0ff; border: 1px solid rgba(124,240,255,0.3); }
        .jn-toast.success { background: rgba(34,197,94,0.15); color: #22c55e; border: 1px solid rgba(34,197,94,0.3); }
        .jn-toast.error { background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.3); }

        /* Modal overlay */
        .jn-modal-overlay {
            position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
            z-index: 9000; display: none; align-items: center; justify-content: center;
        }
        .jn-modal-overlay.open { display: flex; }
        .jn-modal {
            background: var(--panel-bg); border: 1px solid var(--panel-border);
            border-radius: 16px; padding: 24px; max-width: 500px; width: 90%;
        }

        /* Responsive */
        @media (max-width: 1100px) {
            .jn-container { flex-direction: column; }
            .jn-ai-panel { width: 100%; min-width: 100%; max-height: 400px; position: static; }
            .jn-stats { grid-template-columns: repeat(3, 1fr); }
            .jn-triage-grid { grid-template-columns: 1fr; }
        }
        @media (max-width: 700px) {
            .jn-stats { grid-template-columns: repeat(2, 1fr); }
            .jn-header { flex-direction: column; gap: 12px; align-items: flex-start; }
        }
    </style>
</head>
<body>
    <div id="nav-container"></div>

    <div class="main-content">
        <div class="jn-container">
            <div class="jn-main">

                <!-- 1. Header -->
                <div class="jn-header">
                    <div>
                        <h1><i class="fas fa-broom"></i> Disk Janitor</h1>
                        <p>AI-powered storage analysis, deduplication &amp; cleanup</p>
                    </div>
                    <div class="jn-header-actions">
                        <span id="jn-last-scan" style="font-size:11px; color:var(--muted);"></span>
                        <button class="jn-btn jn-btn-primary" id="jn-analyze-btn"><i class="fas fa-search"></i> Analyze Directory</button>
                        <button class="jn-btn jn-btn-success" id="jn-dedup-btn"><i class="fas fa-play"></i> Run Dedup Scan</button>
                    </div>
                </div>

                <!-- 2. Health Metrics -->
                <div class="jn-stats" id="jn-stats">
                    <div class="jn-stat" id="jn-stat-files"><div class="jn-stat-top"><div><div class="jn-stat-val">--</div><div class="jn-stat-label">Total Files</div></div></div></div>
                    <div class="jn-stat" id="jn-stat-size"><div class="jn-stat-top"><div><div class="jn-stat-val">--</div><div class="jn-stat-label">Total Size</div></div></div></div>
                    <div class="jn-stat" id="jn-stat-dupes"><div class="jn-stat-top"><div><div class="jn-stat-val">--</div><div class="jn-stat-label">Duplicate Groups</div></div></div></div>
                    <div class="jn-stat" id="jn-stat-reclaimable"><div class="jn-stat-top"><div><div class="jn-stat-val">--</div><div class="jn-stat-label">Reclaimable</div></div></div></div>
                    <div class="jn-stat" id="jn-stat-policies"><div class="jn-stat-top"><div><div class="jn-stat-val">--</div><div class="jn-stat-label">Policies Active</div></div></div></div>
                </div>

                <!-- 3. Storage Breakdown -->
                <div class="jn-panel" id="jn-breakdown-panel">
                    <div class="jn-panel-head">
                        <div class="jn-panel-title"><i class="fas fa-chart-bar"></i> Storage Breakdown</div>
                        <span id="jn-breakdown-info" style="font-size:10px; color:var(--muted);"></span>
                    </div>
                    <div class="jn-bar" id="jn-bar"></div>
                    <table class="jn-table">
                        <thead><tr><th></th><th>Path</th><th>Files</th><th>Size</th><th>Dupes</th><th>Usage</th></tr></thead>
                        <tbody id="jn-breakdown-tbody"><tr><td colspan="6" style="text-align:center; color:var(--muted); padding:20px;">Loading...</td></tr></tbody>
                    </table>
                </div>

                <!-- 4. Duplicate Groups -->
                <div class="jn-panel" id="jn-dupes-panel">
                    <div class="jn-panel-head">
                        <div class="jn-panel-title"><i class="fas fa-clone"></i> Duplicate Groups <span class="jn-panel-sub" id="jn-dupes-sub"></span></div>
                        <div class="jn-panel-actions">
                            <button class="jn-btn jn-btn-ai" id="jn-ai-resolve-all"><i class="fas fa-sparkles"></i> AI Resolve All</button>
                            <button class="jn-btn jn-btn-ghost" id="jn-export-dupes"><i class="fas fa-download"></i> Export CSV</button>
                        </div>
                    </div>
                    <table class="jn-table">
                        <thead><tr><th>Sample Path</th><th>Copies</th><th>Each</th><th>Wasted</th><th>Actions</th></tr></thead>
                        <tbody id="jn-dupes-tbody"><tr><td colspan="5" style="text-align:center; color:var(--muted); padding:20px;">Loading...</td></tr></tbody>
                    </table>
                    <div id="jn-dupes-more" style="text-align:center; padding:10px; display:none;">
                        <button class="jn-btn jn-btn-ghost" id="jn-load-more-dupes">Load more...</button>
                    </div>
                </div>

                <!-- 5. Cleanup Suggestions -->
                <div class="jn-panel" id="jn-cleanup-panel">
                    <div class="jn-panel-head">
                        <div class="jn-panel-title"><i class="fas fa-broom"></i> Cleanup Suggestions <span class="jn-panel-sub" id="jn-cleanup-sub"></span></div>
                        <div class="jn-panel-actions">
                            <button class="jn-btn jn-btn-warn" id="jn-preview-cleanup"><i class="fas fa-eye"></i> Preview (Dry Run)</button>
                            <button class="jn-btn jn-btn-success" id="jn-apply-cleanup"><i class="fas fa-check"></i> Apply Selected</button>
                        </div>
                    </div>
                    <div id="jn-cleanup-list"><div style="text-align:center; color:var(--muted); padding:20px;">Loading...</div></div>
                </div>

                <!-- 6. AI Triage -->
                <div class="jn-panel jn-panel-ai" id="jn-triage-panel">
                    <div class="jn-panel-head">
                        <div class="jn-panel-title"><i class="fas fa-sparkles" style="color:#a78bfa;"></i> AI Triage <span class="jn-panel-sub" id="jn-triage-sub"></span></div>
                        <button class="jn-btn jn-btn-ai" id="jn-run-triage"><i class="fas fa-sparkles"></i> Run Triage</button>
                    </div>
                    <div class="jn-triage-grid" id="jn-triage-grid">
                        <div style="grid-column: 1/-1; text-align:center; color:var(--muted); padding:20px;">Click "Run Triage" to analyze your storage with AI</div>
                    </div>
                </div>

            </div>

            <!-- 7. AI Chat Panel -->
            <div class="jn-ai-panel" id="jn-ai-panel">
                <div class="jn-ai-header" id="jn-ai-toggle">
                    <i class="fas fa-sparkles" style="color:#a78bfa; font-size:16px;"></i>
                    <span style="color:#fff; font-weight:600; font-size:13px;">Janitor AI</span>
                    <span class="jn-ai-model">qwen2.5:7b</span>
                </div>
                <div class="jn-ai-body" id="jn-ai-body">
                    <div class="jn-ai-msg assistant">Welcome! I can help you analyze storage, resolve duplicates, and plan cleanups. Ask me anything about your filesystem.</div>
                </div>
                <div class="jn-ai-input">
                    <input type="text" id="jn-ai-input" placeholder="Ask the janitor..." />
                    <button class="jn-ai-send" id="jn-ai-send">&#10148;</button>
                </div>
            </div>

        </div>
    </div>

    <!-- Confirm modal -->
    <div class="jn-modal-overlay" id="jn-modal">
        <div class="jn-modal" id="jn-modal-content"></div>
    </div>

    <div class="jn-toast" id="jn-toast"></div>

    <script src="/js/components/nav.js"></script>
    <script src="/js/janitor.js"></script>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            if (typeof injectNav === 'function') injectNav('janitor');
            if (typeof JanitorPage !== 'undefined') JanitorPage.init();
        });
    </script>
</body>
</html>
```

- [ ] **Step 2: Verify page loads**

Open `http://localhost:3080/janitor.html` in a browser. Should show the page shell with "Loading..." placeholders. (Requires agentx-core running.)

- [ ] **Step 3: Commit**

```bash
cd /home/yb/codes/agentx-platform/core
git add public/janitor.html
git commit -m "feat(janitor): add janitor.html page shell with all section skeletons"
```

---

### Task 4: Create `core/public/js/janitor.js` — core logic, metrics, and storage breakdown

**Files:**
- Create: `core/public/js/janitor.js`

This is the main JS file. We build it incrementally. This task covers: init, helpers, health metrics, and storage breakdown. Tasks 5-7 will append the remaining sections.

- [ ] **Step 1: Create janitor.js with core logic, health metrics, and storage breakdown**

```js
// core/public/js/janitor.js
/**
 * JanitorPage — Disk Janitor command center UI logic
 * Talks to data service via core proxy at /api/data/*
 */
const JanitorPage = (() => {
    // ── State ───────────────────────────────────────────────
    let summaryData = null;
    let dedupReport = null;
    let policiesData = null;
    let treeData = null;
    let dupePageOffset = 0;
    const DUPES_PER_PAGE = 20;

    // ── Helpers ─────────────────────────────────────────────

    function $(id) { return document.getElementById(id); }

    function showToast(msg, type = 'info') {
        const el = $('jn-toast');
        if (!el) return;
        el.textContent = msg;
        el.className = `jn-toast ${type} show`;
        clearTimeout(el._t);
        el._t = setTimeout(() => el.classList.remove('show'), 3500);
    }

    async function api(path, opts = {}) {
        const res = await fetch(`/api/data${path}`, {
            headers: { 'Content-Type': 'application/json' },
            ...opts
        });
        if (!res.ok) {
            const text = await res.text().catch(() => res.statusText);
            throw new Error(`${res.status}: ${text}`);
        }
        return res.json();
    }

    function fmtBytes(bytes) {
        if (bytes == null || isNaN(bytes) || bytes < 0) return '--';
        if (bytes === 0) return '0 B';
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
    }

    function timeAgo(d) {
        if (!d) return '--';
        const diff = Date.now() - new Date(d).getTime();
        const m = Math.floor(diff / 60000);
        if (m < 1) return 'just now';
        if (m < 60) return m + 'm ago';
        const h = Math.floor(m / 60);
        if (h < 24) return h + 'h ago';
        return Math.floor(h / 24) + 'd ago';
    }

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    const BAR_COLORS = ['#3b82f6', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#6b7280'];

    // ── Health Metrics ──────────────────────────────────────

    function renderMetrics() {
        const s = summaryData || {};
        const d = s.duplicates || {};
        const p = policiesData || [];

        // Total Files
        $('jn-stat-files').innerHTML = `
            <div class="jn-stat-top">
                <div><div class="jn-stat-val">${s.totalFiles != null ? s.totalFiles.toLocaleString() : '--'}</div>
                <div class="jn-stat-label">Total Files</div></div>
            </div>`;

        // Total Size
        const pct = s.totalSize && s.diskTotal ? Math.round(s.totalSize / s.diskTotal * 100) : null;
        $('jn-stat-size').innerHTML = `
            <div class="jn-stat-top">
                <div><div class="jn-stat-val">${s.totalSizeFormatted || fmtBytes(s.totalSize)}</div>
                <div class="jn-stat-label">Total Size</div></div>
                ${pct != null ? `<span class="jn-stat-tag" style="background:rgba(245,158,11,0.15);color:#f59e0b;">${pct}% used</span>` : ''}
            </div>`;

        // Duplicate Groups
        $('jn-stat-dupes').innerHTML = `
            <div class="jn-stat-top">
                <div><div class="jn-stat-val" style="color:#ef4444;">${d.groups != null ? d.groups.toLocaleString() : '--'}</div>
                <div class="jn-stat-label">Duplicate Groups</div></div>
                ${d.groups > 0 ? '<span class="jn-stat-tag" style="background:rgba(239,68,68,0.15);color:#ef4444;">Action</span>' : ''}
            </div>
            <div class="jn-stat-sub">${d.groups ? `${(d.totalFiles || 0).toLocaleString()} redundant files` : ''}</div>`;

        // Reclaimable
        const savings = d.potentialSavings || 0;
        $('jn-stat-reclaimable').innerHTML = `
            <div class="jn-stat-top">
                <div><div class="jn-stat-val" style="color:#f59e0b;">${d.potentialSavingsFormatted || fmtBytes(savings)}</div>
                <div class="jn-stat-label">Reclaimable</div></div>
            </div>
            <div class="jn-stat-sub">${savings > 0 ? `${((savings / (s.totalSize || 1)) * 100).toFixed(1)}% of total` : ''}</div>`;

        // Policies
        const activeCount = p.filter(x => x.enabled).length;
        $('jn-stat-policies').innerHTML = `
            <div class="jn-stat-top">
                <div><div class="jn-stat-val" style="color:#22c55e;">${activeCount} <span style="font-size:12px;color:var(--muted);">/ ${p.length}</span></div>
                <div class="jn-stat-label">Policies Active</div></div>
            </div>
            <div class="jn-stat-sub">${p.filter(x => x.enabled).map(x => x.name.replace(/^(Delete|Remove|Flag)\s+/i, '')).join(' · ')}</div>`;

        // Last scan
        const ls = s.lastScan;
        $('jn-last-scan').textContent = ls ? `Last scan: ${timeAgo(ls.started_at || ls.finished_at)}` : '';
    }

    // ── Storage Breakdown ───────────────────────────────────

    function renderBreakdown() {
        const dirs = treeData || [];
        if (dirs.length === 0) {
            $('jn-bar').innerHTML = '';
            $('jn-breakdown-tbody').innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:20px;">No directory data. Run a storage scan first.</td></tr>';
            return;
        }

        const totalSize = dirs.reduce((s, d) => s + (d.totalSize || 0), 0);
        $('jn-breakdown-info').textContent = `${dirs.length} directories · ${fmtBytes(totalSize)} total`;

        // Stacked bar
        $('jn-bar').innerHTML = dirs.slice(0, 7).map((d, i) => {
            const pct = totalSize > 0 ? Math.max((d.totalSize / totalSize) * 100, 3) : 0;
            const name = (d.path || '').split('/').filter(Boolean).pop() || d.path;
            return `<div class="jn-bar-seg" style="width:${pct}%;background:${BAR_COLORS[i % BAR_COLORS.length]};">${escHtml(name)}/ ${fmtBytes(d.totalSize)}</div>`;
        }).join('') + (dirs.length > 7 ? `<div class="jn-bar-seg" style="flex:1;background:#6b7280;">+${dirs.length - 7} more</div>` : '');

        // Table
        $('jn-breakdown-tbody').innerHTML = dirs.map((d, i) => {
            const color = BAR_COLORS[i % BAR_COLORS.length];
            const pct = totalSize > 0 ? (d.totalSize / totalSize * 100) : 0;
            return `<tr style="cursor:pointer;">
                <td><span style="color:${color};">&#9632;</span></td>
                <td style="color:#fff;font-weight:500;">${escHtml(d.path)}</td>
                <td>${(d.fileCount || 0).toLocaleString()}</td>
                <td style="font-weight:600;color:#fff;">${fmtBytes(d.totalSize)}</td>
                <td style="color:${(d.duplicates || 0) > 0 ? '#ef4444' : 'var(--muted)'};">${d.duplicates || '-'}</td>
                <td><div class="jn-progress" style="width:100px;"><div class="jn-progress-fill" style="width:${pct}%;background:${color};"></div></div></td>
            </tr>`;
        }).join('');
    }

    // ── Data Loading ────────────────────────────────────────

    async function loadSummary() {
        try {
            const json = await api('/storage/summary');
            summaryData = json.data || json;
            renderMetrics();
        } catch (err) { console.warn('loadSummary:', err); }
    }

    async function loadTree() {
        try {
            const json = await api('/storage/files/tree');
            treeData = (json.data && json.data.tree) || json.data || [];
            renderBreakdown();
        } catch (err) {
            console.warn('loadTree:', err);
            treeData = [];
            renderBreakdown();
        }
    }

    async function loadPolicies() {
        try {
            const json = await api('/janitor/policies');
            policiesData = (json.data && json.data.policies) || [];
            renderMetrics();
        } catch (err) { console.warn('loadPolicies:', err); }
    }

    async function loadDedupReport() {
        try {
            const json = await api('/janitor/dedup-report');
            dedupReport = json.data || null;
            renderMetrics();
            renderDupes();
        } catch (err) {
            if (!String(err).includes('404')) console.warn('loadDedupReport:', err);
            dedupReport = null;
            renderDupes();
        }
    }

    // (renderDupes, renderCleanup, triage, and chat are added in Tasks 5-7)

    function renderDupes() { /* filled in Task 5 */ }
    function renderCleanup() { /* filled in Task 6 */ }

    // ── Init ────────────────────────────────────────────────

    function init() {
        // Parallel initial load
        loadSummary();
        loadTree();
        loadPolicies();
        loadDedupReport();

        // Periodic refresh (30s)
        setInterval(() => {
            if (!document.hidden) { loadSummary(); loadDedupReport(); }
        }, 30000);
    }

    return { init };
})();
```

- [ ] **Step 2: Verify page renders metrics**

Open `http://localhost:3080/janitor.html`. Health metrics and storage breakdown should populate from live data (requires data service running with nas_files data).

- [ ] **Step 3: Commit**

```bash
cd /home/yb/codes/agentx-platform/core
git add public/js/janitor.js
git commit -m "feat(janitor): add janitor.js — init, helpers, health metrics, storage breakdown"
```

---

### Task 5: Add duplicate groups section to janitor.js

**Files:**
- Modify: `core/public/js/janitor.js`

- [ ] **Step 1: Replace the `renderDupes` stub with the full implementation**

Replace the line `function renderDupes() { /* filled in Task 5 */ }` with:

```js
    // ── Duplicate Groups ────────────────────────────────────

    function renderDupes() {
        const groups = dedupReport ? (dedupReport.groups || []) : [];
        const summary = dedupReport ? (dedupReport.summary || {}) : {};

        $('jn-dupes-sub').textContent = groups.length > 0
            ? `${summary.total_duplicate_groups || groups.length} groups · ${summary.total_duplicate_files || 0} redundant files`
            : '';

        if (groups.length === 0) {
            $('jn-dupes-tbody').innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px;">No duplicates found. Run a dedup scan.</td></tr>';
            $('jn-dupes-more').style.display = 'none';
            return;
        }

        const page = groups.slice(0, dupePageOffset + DUPES_PER_PAGE);
        $('jn-dupes-tbody').innerHTML = page.map((g, idx) => {
            const sample = (g.files && g.files[0]) || {};
            const samplePath = sample.path || sample.filename || g.hash || '';
            const dir = samplePath.split('/').slice(0, -1).join('/') || '';
            const fname = samplePath.split('/').pop() || samplePath;

            return `<tr style="cursor:pointer;" onclick="JanitorPage._toggleDupe(${idx})">
                <td>
                    <span style="color:var(--muted);margin-right:4px;" id="jn-dupe-arrow-${idx}">&#9654;</span>
                    <span style="color:var(--text);">${escHtml(fname)}</span><br>
                    <span style="color:var(--muted);font-size:10px;">${escHtml(dir)}</span>
                </td>
                <td style="color:#ef4444;font-weight:700;">${g.count || g.files?.length || 0}</td>
                <td>${fmtBytes(g.file_size || g.size || sample.size)}</td>
                <td style="color:#f59e0b;font-weight:600;">${fmtBytes(g.wasted_space || g.wasted)}</td>
                <td>
                    <button class="jn-btn jn-btn-ai" style="padding:2px 6px;font-size:9px;" onclick="event.stopPropagation();JanitorPage._aiResolveDupe(${idx})"><i class="fas fa-sparkles"></i> AI</button>
                    <button class="jn-btn jn-btn-success" style="padding:2px 6px;font-size:9px;" onclick="event.stopPropagation();JanitorPage._keepOldest(${idx})">Keep 1</button>
                </td>
            </tr>
            <tr><td colspan="5" style="padding:0;"><div class="jn-expand" id="jn-dupe-detail-${idx}"></div></td></tr>`;
        }).join('');

        $('jn-dupes-more').style.display = page.length < groups.length ? 'block' : 'none';
    }

    function _toggleDupe(idx) {
        const el = $(`jn-dupe-detail-${idx}`);
        const arrow = $(`jn-dupe-arrow-${idx}`);
        if (!el) return;
        const open = el.classList.toggle('open');
        if (arrow) arrow.innerHTML = open ? '&#9660;' : '&#9654;';
        if (open && !el.dataset.loaded) {
            el.dataset.loaded = '1';
            _renderDupeDetail(idx);
        }
    }

    function _renderDupeDetail(idx) {
        const groups = dedupReport ? (dedupReport.groups || []) : [];
        const g = groups[idx];
        if (!g || !g.files) return;

        const el = $(`jn-dupe-detail-${idx}`);
        const sorted = [...g.files].sort((a, b) => new Date(a.mtime || 0) - new Date(b.mtime || 0));

        el.innerHTML = sorted.map((f, i) => {
            const isKeep = i === 0;
            return `<div class="jn-file-row ${isKeep ? 'jn-file-keep' : 'jn-file-delete'}">
                ${isKeep
                    ? '<span style="color:#22c55e;font-weight:700;min-width:40px;">KEEP</span>'
                    : '<input type="checkbox" checked style="accent-color:#ef4444;min-width:40px;">'}
                <span style="color:var(--text);flex:1;font-family:monospace;font-size:10px;">${escHtml(f.path)}</span>
                <span style="color:var(--muted);font-size:10px;">${f.mtime ? new Date(f.mtime).toLocaleDateString() : ''} · ${isKeep ? 'oldest' : 'copy'}</span>
            </div>`;
        }).join('') + `<div class="jn-file-row jn-file-ai" id="jn-dupe-ai-${idx}" style="display:none;">
            <span style="color:#a78bfa;">&#10024;</span>
            <span style="color:#a78bfa;font-size:10px;line-height:1.4;" id="jn-dupe-ai-text-${idx}"></span>
        </div>`;
    }

    async function _aiResolveDupe(idx) {
        const groups = dedupReport ? (dedupReport.groups || []) : [];
        const g = groups[idx];
        if (!g || !g.files) return;

        // Ensure detail is open
        const el = $(`jn-dupe-detail-${idx}`);
        if (!el.classList.contains('open')) _toggleDupe(idx);

        const aiEl = $(`jn-dupe-ai-${idx}`);
        const aiText = $(`jn-dupe-ai-text-${idx}`);
        if (aiEl) aiEl.style.display = 'flex';
        if (aiText) aiText.textContent = 'Thinking...';

        try {
            const json = await api('/janitor/ai', {
                method: 'POST',
                body: JSON.stringify({
                    action: 'resolve_duplicates',
                    context: { duplicates: g.files }
                })
            });
            const result = json.data?.result || {};
            if (aiText) aiText.textContent = `AI: ${result.reason || result.text || JSON.stringify(result)}`;
        } catch (err) {
            if (aiText) aiText.textContent = 'AI unavailable — UGFrank may be offline.';
        }
    }

    function _keepOldest(idx) {
        // Just open the detail view — oldest is already marked KEEP
        if (!$(`jn-dupe-detail-${idx}`)?.classList.contains('open')) _toggleDupe(idx);
        showToast('Oldest copy marked as KEEP. Check newer copies to delete.', 'info');
    }
```

Also add at the bottom of the IIFE, before `return { init }`:

```js
    // Wire up buttons
    function wireButtons() {
        $('jn-load-more-dupes')?.addEventListener('click', () => {
            dupePageOffset += DUPES_PER_PAGE;
            renderDupes();
        });

        $('jn-dedup-btn')?.addEventListener('click', async () => {
            try {
                showToast('Starting dedup scan...', 'info');
                await api('/janitor/dedup-scan', { method: 'POST', body: '{}' });
                showToast('Dedup scan started!', 'success');
                setTimeout(loadDedupReport, 3000);
            } catch (err) { showToast('Dedup scan failed: ' + err.message, 'error'); }
        });
    }
```

Update the `init` function to call `wireButtons()`:

```js
    function init() {
        loadSummary();
        loadTree();
        loadPolicies();
        loadDedupReport();
        wireButtons();

        setInterval(() => {
            if (!document.hidden) { loadSummary(); loadDedupReport(); }
        }, 30000);
    }

    return { init, _toggleDupe, _aiResolveDupe, _keepOldest };
```

- [ ] **Step 2: Test in browser**

Open janitor.html. If there's a dedup report in the database, duplicate groups should render with expand/collapse and AI buttons.

- [ ] **Step 3: Commit**

```bash
cd /home/yb/codes/agentx-platform/core
git add public/js/janitor.js
git commit -m "feat(janitor): add duplicate groups section with expand, AI resolve, keep-oldest"
```

---

### Task 6: Add cleanup suggestions section to janitor.js

**Files:**
- Modify: `core/public/js/janitor.js`

- [ ] **Step 1: Replace the `renderCleanup` stub with the full implementation**

Replace the line `function renderCleanup() { /* filled in Task 6 */ }` with:

```js
    // ── Cleanup Suggestions ─────────────────────────────────

    let cleanupSuggestions = [];
    let cleanupToken = null;

    async function loadCleanup(scanPath) {
        const body = scanPath ? { path: scanPath } : { path: '/mnt/datalake/' };
        try {
            const json = await api('/janitor/suggest', { method: 'POST', body: JSON.stringify(body) });
            const data = json.data || {};
            cleanupSuggestions = data.suggestions || [];
            cleanupToken = data.confirmation_token || null;
            renderCleanup();
        } catch (err) {
            console.warn('loadCleanup:', err);
            cleanupSuggestions = [];
            renderCleanup();
        }
    }

    function renderCleanup() {
        const total = cleanupSuggestions.reduce((s, x) => s + (x.space_saved || 0), 0);
        $('jn-cleanup-sub').textContent = cleanupSuggestions.length > 0
            ? `${cleanupSuggestions.length} actionable · ${fmtBytes(total)} reclaimable`
            : '';

        if (cleanupSuggestions.length === 0) {
            $('jn-cleanup-list').innerHTML = '<div style="text-align:center;color:var(--muted);padding:20px;">No suggestions yet. Run an analysis first.</div>';
            return;
        }

        $('jn-cleanup-list').innerHTML = cleanupSuggestions.map((s, i) => {
            const isDelete = s.action === 'delete';
            const badgeClass = isDelete ? 'jn-badge-delete' : 'jn-badge-review';
            const label = isDelete ? 'DELETE' : 'REVIEW';
            const fileDisplay = s.files.length === 1 ? escHtml(s.files[0]) : `${s.files.length} files`;

            return `<div class="jn-sug-row">
                <input type="checkbox" ${isDelete ? 'checked' : ''} data-sug-idx="${i}" class="jn-sug-check" style="accent-color:${isDelete ? '#22c55e' : '#f59e0b'};">
                <span class="jn-badge ${badgeClass}">${label}</span>
                <span style="flex:1;color:var(--text);">${fileDisplay}${s.reason ? ` <span style="color:var(--muted);">— ${escHtml(s.reason)}</span>` : ''}</span>
                <span style="color:#f59e0b;font-weight:600;min-width:60px;">${fmtBytes(s.space_saved)}</span>
                <span style="padding:2px 8px;background:rgba(255,255,255,0.05);border-radius:4px;color:var(--muted);font-size:10px;">${escHtml(s.policy)}</span>
            </div>`;
        }).join('');
    }

    function getCheckedCleanupFiles() {
        const checks = document.querySelectorAll('.jn-sug-check:checked');
        const files = [];
        checks.forEach(cb => {
            const idx = parseInt(cb.dataset.sugIdx);
            const sug = cleanupSuggestions[idx];
            if (sug) files.push(...sug.files);
        });
        return files;
    }

    async function executeCleanup(dryRun) {
        const files = getCheckedCleanupFiles();
        if (files.length === 0) return showToast('No files selected.', 'error');
        if (!cleanupToken) return showToast('No confirmation token. Re-run suggestions first.', 'error');

        if (!dryRun) {
            // Show confirmation modal
            $('jn-modal-content').innerHTML = `
                <h3 style="color:#fff;margin:0 0 12px;">Confirm Deletion</h3>
                <p style="color:var(--muted);font-size:13px;">This will permanently delete <strong style="color:#ef4444;">${files.length} files</strong>.</p>
                <p style="color:var(--muted);font-size:12px;margin-top:8px;">This cannot be undone.</p>
                <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;">
                    <button class="jn-btn jn-btn-ghost" onclick="document.getElementById('jn-modal').classList.remove('open')">Cancel</button>
                    <button class="jn-btn jn-btn-danger" onclick="JanitorPage._confirmDelete()"><i class="fas fa-trash"></i> Delete ${files.length} files</button>
                </div>`;
            $('jn-modal').classList.add('open');
            return;
        }

        try {
            showToast('Running dry run...', 'info');
            const json = await api('/janitor/execute', {
                method: 'POST',
                body: JSON.stringify({ files, confirmation_token: cleanupToken, dry_run: dryRun })
            });
            const r = json.data || {};
            showToast(`Dry run: would delete ${r.deleted?.length || 0} files, free ${fmtBytes(r.space_freed || 0)}`, 'success');
        } catch (err) { showToast('Cleanup failed: ' + err.message, 'error'); }
    }

    async function _confirmDelete() {
        $('jn-modal').classList.remove('open');
        const files = getCheckedCleanupFiles();
        try {
            showToast('Deleting files...', 'info');
            const json = await api('/janitor/execute', {
                method: 'POST',
                body: JSON.stringify({ files, confirmation_token: cleanupToken, dry_run: false })
            });
            const r = json.data || {};
            showToast(`Deleted ${r.deleted?.length || 0} files, freed ${fmtBytes(r.space_freed || 0)}`, 'success');
            loadSummary();
            loadCleanup();
        } catch (err) { showToast('Delete failed: ' + err.message, 'error'); }
    }
```

Add to `wireButtons()`:

```js
        $('jn-preview-cleanup')?.addEventListener('click', () => executeCleanup(true));
        $('jn-apply-cleanup')?.addEventListener('click', () => executeCleanup(false));

        $('jn-analyze-btn')?.addEventListener('click', () => {
            const path = prompt('Enter directory path to analyze:', '/mnt/datalake/');
            if (path) loadCleanup(path);
        });
```

Update `init` to call `loadCleanup()`:

```js
    function init() {
        loadSummary();
        loadTree();
        loadPolicies();
        loadDedupReport();
        loadCleanup();
        wireButtons();
        setInterval(() => {
            if (!document.hidden) { loadSummary(); loadDedupReport(); }
        }, 30000);
    }

    return { init, _toggleDupe, _aiResolveDupe, _keepOldest, _confirmDelete };
```

- [ ] **Step 2: Test in browser**

Verify cleanup suggestions render, checkboxes work, dry-run preview shows toast.

- [ ] **Step 3: Commit**

```bash
cd /home/yb/codes/agentx-platform/core
git add public/js/janitor.js
git commit -m "feat(janitor): add cleanup suggestions with confirmation flow and dry-run"
```

---

### Task 7: Add AI triage and chat panel to janitor.js

**Files:**
- Modify: `core/public/js/janitor.js`

- [ ] **Step 1: Add AI triage rendering and chat logic**

Add after the cleanup section in janitor.js:

```js
    // ── AI Triage ───────────────────────────────────────────

    async function runTriage() {
        $('jn-triage-grid').innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:#a78bfa;"><i class="fas fa-spinner fa-spin"></i> AI is analyzing your storage...</div>';
        $('jn-triage-sub').textContent = '';

        try {
            // Assemble context from loaded data
            const context = {
                files: (treeData || []).map(d => ({
                    path: d.path, size: d.totalSize, fileCount: d.fileCount
                })),
                stats: summaryData || {}
            };

            const json = await api('/janitor/ai', {
                method: 'POST',
                body: JSON.stringify({ action: 'triage', context })
            });

            const result = json.data?.result || {};
            const categories = result.categories || [];

            if (categories.length === 0 && result.text) {
                $('jn-triage-grid').innerHTML = `<div style="grid-column:1/-1;padding:14px;color:var(--text);font-size:12px;line-height:1.5;">${escHtml(result.text)}</div>`;
                return;
            }

            const classMap = { KEEP: 'keep', ARCHIVE: 'archive', JUNK: 'junk' };
            const colorMap = { KEEP: '#22c55e', ARCHIVE: '#f59e0b', JUNK: '#ef4444' };

            $('jn-triage-grid').innerHTML = categories.map(c => {
                const cls = classMap[c.label] || '';
                const color = colorMap[c.label] || 'var(--muted)';
                return `<div class="jn-triage-card ${cls}">
                    <div class="jn-triage-head">
                        <span style="color:${color};font-weight:700;">${escHtml(c.label)}</span>
                        <span style="color:var(--muted);font-size:10px;">${c.files_count || 0} files · ${fmtBytes(c.total_size || 0)}</span>
                    </div>
                    <div style="color:var(--muted);line-height:1.5;">${escHtml(c.reason)}</div>
                </div>`;
            }).join('');

            $('jn-triage-sub').textContent = `${categories.length} categories · ${json.data?.duration_ms || 0}ms`;
        } catch (err) {
            $('jn-triage-grid').innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:20px;color:#ef4444;">AI unavailable — ${escHtml(err.message)}</div>`;
        }
    }

    // ── AI Chat ─────────────────────────────────────────────

    let chatHistory = [];

    function appendChatMsg(role, text) {
        const body = $('jn-ai-body');
        if (!body) return;
        const div = document.createElement('div');
        div.className = `jn-ai-msg ${role}`;
        div.textContent = text;
        body.appendChild(div);
        body.scrollTop = body.scrollHeight;
    }

    async function sendChat() {
        const input = $('jn-ai-input');
        const msg = (input?.value || '').trim();
        if (!msg) return;
        input.value = '';

        appendChatMsg('user', msg);
        chatHistory.push({ role: 'user', content: msg });

        // Show typing indicator
        const typingId = 'jn-ai-typing';
        const body = $('jn-ai-body');
        const typing = document.createElement('div');
        typing.id = typingId;
        typing.className = 'jn-ai-msg assistant';
        typing.style.opacity = '0.6';
        typing.textContent = 'Thinking...';
        body.appendChild(typing);
        body.scrollTop = body.scrollHeight;

        try {
            const json = await api('/janitor/ai', {
                method: 'POST',
                body: JSON.stringify({
                    action: 'chat',
                    context: {
                        message: msg,
                        stats: summaryData || {},
                        recentTriage: treeData ? treeData.slice(0, 10) : []
                    }
                })
            });

            const result = json.data?.result || {};
            const reply = result.text || result.reason || JSON.stringify(result);

            typing.remove();
            appendChatMsg('assistant', reply);
            chatHistory.push({ role: 'assistant', content: reply });
        } catch (err) {
            typing.remove();
            appendChatMsg('assistant', 'AI unavailable — UGFrank may be offline.');
        }
    }

    function toggleAiPanel() {
        $('jn-ai-panel')?.classList.toggle('collapsed');
    }
```

Add to `wireButtons()`:

```js
        $('jn-run-triage')?.addEventListener('click', runTriage);
        $('jn-ai-toggle')?.addEventListener('click', toggleAiPanel);
        $('jn-ai-send')?.addEventListener('click', sendChat);
        $('jn-ai-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
```

Update the return statement:

```js
    return { init, _toggleDupe, _aiResolveDupe, _keepOldest, _confirmDelete };
```

- [ ] **Step 2: Test in browser**

Verify: AI triage shows spinner then results (requires UGFrank online). Chat panel sends messages and shows responses. Panel collapses on header click.

- [ ] **Step 3: Commit**

```bash
cd /home/yb/codes/agentx-platform/core
git add public/js/janitor.js
git commit -m "feat(janitor): add AI triage section and chat panel with qwen2.5:7b"
```

---

### Task 8: Add nav entry

**Files:**
- Modify: `core/public/js/components/nav.js`

- [ ] **Step 1: Add Janitor to the nav structure**

In `core/public/js/components/nav.js`, find the "Data" section in `navStructure` (after `{ section: 'Data' }`). Add the janitor entry after the "Storage" entry:

```js
                { label: 'Janitor', href: corePage('janitor.html'), icon: 'fa-broom', id: 'janitor' },
```

The section should now read:

```js
                { section: 'Data' },
                { label: 'Storage', href: corePage('storage.html'), icon: 'fa-hard-drive', id: 'storage' },
                { label: 'Janitor', href: corePage('janitor.html'), icon: 'fa-broom', id: 'janitor' },
                { label: 'Files', href: corePage('files.html'), icon: 'fa-folder-open', id: 'files' },
```

- [ ] **Step 2: Verify nav shows Janitor link**

Open any page and check the More > Data dropdown. "Janitor" with broom icon should appear.

- [ ] **Step 3: Commit**

```bash
cd /home/yb/codes/agentx-platform/core
git add public/js/components/nav.js
git commit -m "feat(nav): add Janitor entry under More > Data"
```

---

## Summary of Issue Coverage

| Spec Section | Task |
|-------------|------|
| Header with actions | 3 (HTML), 5 (dedup scan button), 6 (analyze button) |
| Health metrics (5 cards) | 4 (rendering) |
| Storage breakdown (bar + table) | 4 (rendering) |
| Duplicate groups (expand/collapse, AI resolve) | 5 |
| Cleanup suggestions (checkboxes, dry-run, confirm) | 6 |
| AI triage (3-card grid) | 7 |
| AI chat panel (collapsible) | 7 |
| AI backend endpoint | 1 (service), 2 (route/controller) |
| Nav entry | 8 |
| Graceful degradation (AI offline) | 5, 7 (error handling in AI calls) |
