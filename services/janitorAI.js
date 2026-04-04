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

function parseAIResponse(raw) {
  if (!raw || typeof raw !== 'string') return { text: '' };

  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ }
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
  }

  return { text: raw };
}

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
