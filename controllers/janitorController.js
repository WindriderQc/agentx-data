/**
 * janitorController.js — thin HTTP handlers for disk janitor + dedup pipeline.
 * Delegates all business logic to janitorService and dedupScanner.
 */
const janitorService = require('../services/janitorService');
const dedupScanner = require('../services/dedupScanner');
const janitorAI = require('../services/janitorAI');
const { log } = require('../utils/logger');

/** POST /analyze */
async function analyze(req, res, next) {
  const { path: scanPath } = req.body;
  if (!scanPath) return res.status(400).json({ status: 'error', message: 'path required' });
  if (!janitorService.validatePath(scanPath)) {
    return res.status(403).json({ status: 'error', message: 'Path blocked by safety policy' });
  }
  try {
    const result = await janitorService.analyzeDirectory(scanPath);
    delete result._fileMap;
    res.json({ status: 'success', data: result });
  } catch (err) { next(err); }
}

/** POST /suggest */
async function suggest(req, res, next) {
  const { path: scanPath, policies } = req.body;
  if (!scanPath) return res.status(400).json({ status: 'error', message: 'path required' });
  if (!janitorService.validatePath(scanPath)) {
    return res.status(403).json({ status: 'error', message: 'Path blocked by safety policy' });
  }
  try {
    const analysis = await janitorService.analyzeDirectory(scanPath);
    const active = policies || Object.keys(janitorService.POLICIES).filter(k => janitorService.POLICIES[k].enabled);
    const suggestions = janitorService.buildSuggestions(analysis, active);
    const totalSaved = suggestions.reduce((s, x) => s + (x.space_saved || 0), 0);

    const allFiles = suggestions.flatMap(s => s.files);
    const confirmationToken = allFiles.length > 0 ? janitorService.generateCleanupToken(allFiles) : null;

    res.json({
      status: 'success',
      data: {
        suggestions_count: suggestions.length,
        total_space_saved: totalSaved,
        suggestions: suggestions.slice(0, 100),
        policies_applied: active,
        confirmation_token: confirmationToken
      }
    });
  } catch (err) { next(err); }
}

/** POST /execute */
async function execute(req, res, next) {
  const { files, confirmation_token, dry_run } = req.body;
  if (!files || !Array.isArray(files)) {
    return res.status(400).json({ status: 'error', message: 'files array required' });
  }
  if (!confirmation_token) {
    return res.status(400).json({ status: 'error', message: 'confirmation_token required' });
  }

  const isDryRun = dry_run !== false;
  try {
    const result = await janitorService.executeCleanup(files, confirmation_token, isDryRun);
    if (!result.ok) {
      return res.status(403).json({ status: 'error', message: result.error });
    }
    const verb = isDryRun ? 'Dry run — no files deleted.' : 'Files permanently deleted.';
    log(`Janitor execute: ${isDryRun ? 'Would delete' : 'Deleted'} ${result.deleted.length} files, freed ${result.space_freed} bytes`);
    res.json({ status: 'success', data: { ...result, warning: verb } });
  } catch (err) { next(err); }
}

/** GET /policies */
function listPolicies(req, res) {
  res.json({ status: 'success', data: { policies: Object.values(janitorService.POLICIES) } });
}

/** POST /dedup-scan */
async function dedupScan(req, res, next) {
  const db = req.app.locals.db;
  if (!db) return res.status(503).json({ status: 'error', message: 'Database not ready' });

  const { root_path, extensions, max_depth } = req.body;
  const rootPath = root_path || '/mnt/datalake/';

  if (!janitorService.validatePath(rootPath)) {
    return res.status(403).json({ status: 'error', message: 'Path blocked by safety policy' });
  }

  try {
    const report = await dedupScanner.buildDedupReport(db, {
      rootPath,
      extensions: extensions || [],
      maxDepth: max_depth || null
    });
    const reportId = await dedupScanner.saveReport(db, report);
    log(`Dedup scan complete: ${report.summary.total_duplicate_groups} groups, ${report.summary.total_wasted_space_formatted} wasted`);
    res.json({
      status: 'success',
      message: 'Dedup scan complete',
      data: { report_id: reportId, summary: report.summary }
    });
  } catch (err) {
    log(`Dedup scan failed: ${err.message}`, 'error');
    next(err);
  }
}

/** GET /dedup-report */
async function dedupReport(req, res, next) {
  const db = req.app.locals.db;
  if (!db) return res.status(503).json({ status: 'error', message: 'Database not ready' });

  try {
    const report = await dedupScanner.getReport(db, req.query.report_id || null);
    if (!report) return res.status(404).json({ status: 'error', message: 'No dedup report found' });
    res.json({ status: 'success', data: report });
  } catch (err) { next(err); }
}

/** POST /dedup-approve */
async function dedupApprove(req, res, next) {
  const db = req.app.locals.db;
  if (!db) return res.status(503).json({ status: 'error', message: 'Database not ready' });

  const { report_id, files, confirmation_token, dry_run } = req.body;
  if (!report_id) return res.status(400).json({ status: 'error', message: 'report_id required' });
  if (!files || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ status: 'error', message: 'files array required' });
  }
  if (!confirmation_token) return res.status(400).json({ status: 'error', message: 'confirmation_token required' });

  const isDryRun = dry_run !== false;
  try {
    const result = await dedupScanner.executeApprovedDeletions(db, files, confirmation_token, report_id, isDryRun);
    if (!result.ok) {
      // C3 fix: never leak expected_token in the response
      return res.status(403).json({ status: 'error', message: result.error });
    }
    const verb = isDryRun ? 'Would delete' : 'Deleted';
    log(`Dedup approve: ${verb} ${result.deleted.length} files, freed ${result.space_freed_formatted}`);
    res.json({
      status: 'success',
      message: isDryRun ? 'Dry run — no files deleted.' : 'Approved files deleted.',
      data: result
    });
  } catch (err) { next(err); }
}

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

module.exports = { analyze, suggest, execute, listPolicies, dedupScan, dedupReport, dedupApprove, aiChat };
