/**
 * janitorRunner.js — orchestrates a profile run.
 *
 * Lifecycle: load profile → guard concurrency → create run doc →
 *   scan (Scanner) → optional dedup (dedupScanner) → optional AI triage →
 *   build proposed_actions from policies → finalize run doc.
 *
 * Contract: scan + persist must succeed. Dedup and AI triage are best-effort
 * enrichments — neither failure causes the run to fail.
 *
 * Deviation from plan: Scanner is imported as a module object (`scannerMod`)
 * rather than destructured, so tests can rebind `scannerMod.Scanner` to a
 * failure class after the module loads.
 */
const { ObjectId } = require('mongodb');
const scannerMod = require('./scanner');
const dedupScanner = require('./dedupScanner');
const janitorService = require('./janitorService');
const janitorAI = require('./janitorAI');
const janitorProfiles = require('./janitorProfiles');
const { log } = require('../utils/logger');

const COLLECTION = 'janitor_runs';
const AI_SAMPLE_SIZE = 50;

// In-memory concurrency guard: profile ids currently running
const running = new Set();

function _reset() { running.clear(); }

async function _createRunDoc(db, profile) {
  const doc = {
    profile_id: profile._id,
    profile_name: profile.name,
    scan_id: null,
    started_at: new Date(),
    finished_at: null,
    status: 'running',
    counts: {},
    dedup_report_id: null,
    dedup_error: null,
    ai_triage: null,
    proposed_actions: [],
    error: null
  };
  const result = await db.collection(COLLECTION).insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

async function _patchRun(db, runId, patch) {
  await db.collection(COLLECTION).updateOne({ _id: runId }, { $set: patch });
}

async function _runScan(db, profile) {
  // Use scannerMod.Scanner (not destructured) so tests can rebind after module load.
  const scanner = new scannerMod.Scanner(db);
  const scanId = new ObjectId().toHexString();
  return new Promise((resolve, reject) => {
    scanner.once('done', (result) => resolve({ scanId, ...result }));
    scanner.run({
      roots: profile.roots,
      includeExt: profile.extensions?.include || [],
      excludeExt: profile.extensions?.exclude || [],
      computeHashes: profile.computeHashes !== false,
      batchSize: 1000,
      scanId
    }).catch(reject);
  });
}

async function _runDedup(db, profile) {
  // dedupScanner.buildDedupReport takes a single rootPath; iterate roots and merge.
  const merged = {
    groups: [],
    summary: {
      total_duplicate_groups: 0,
      total_duplicate_files: 0,
      total_wasted_space: 0
    }
  };
  for (const root of profile.roots) {
    const report = await dedupScanner.buildDedupReport(db, { rootPath: root });
    merged.groups.push(...report.groups);
    merged.summary.total_duplicate_groups += report.summary.total_duplicate_groups || 0;
    merged.summary.total_duplicate_files += report.summary.total_duplicate_files || 0;
    merged.summary.total_wasted_space += report.summary.total_wasted_space || 0;
  }
  const reportId = await dedupScanner.saveReport(db, {
    created_at: new Date(),
    status: 'complete',
    config: { roots: profile.roots, extensions: [] },
    summary: merged.summary,
    groups: merged.groups
  });
  return { reportId, merged };
}

function _buildProposedActions(profile, dedupMerged) {
  // v1: only delete_duplicates is supported in runner-driven profile runs.
  // Other policies (remove_temp_files, remove_large_files) are accepted by
  // janitorProfiles.validate() for forward compatibility but produce no
  // actions here — they require the full scan _fileMap that buildSuggestions
  // expects, which the runner does not assemble. Use the disk janitor's
  // /janitor/suggest endpoint for those policies in v1.
  const actions = [];
  if (profile.policies.includes('delete_duplicates') && dedupMerged) {
    for (const group of dedupMerged.groups) {
      // Sort files by mtime ascending (oldest first), keep oldest, delete the rest
      const sorted = [...group.files].sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
      const toDelete = sorted.slice(1);
      if (toDelete.length === 0) continue;
      actions.push({
        policy: 'delete_duplicates',
        files: toDelete.map(f => f.path),
        reason: `Duplicate of ${sorted[0].path}`,
        space_saved: (group.file_size || 0) * toDelete.length,
        status: 'pending',
        executed_at: null,
        result: null
      });
    }
  }
  return actions;
}

async function _runAiTriage(profile, runDoc, proposedActions, scanCounts) {
  const sample = proposedActions.slice(0, AI_SAMPLE_SIZE).map(a => ({
    policy: a.policy,
    files: (a.files || []).slice(0, 5),
    space_saved: a.space_saved
  }));
  try {
    const aiResult = await janitorAI.callAI('triage', {
      files: sample,
      stats: { ...scanCounts, total_proposed_actions: proposedActions.length }
    });
    return { verdict: aiResult.result, model: aiResult.model, duration_ms: aiResult.duration_ms };
  } catch (err) {
    return { error: err.message };
  }
}

async function runProfile(db, profileId) {
  const profile = await janitorProfiles.get(db, profileId);
  if (!profile) return { ok: false, notFound: true };

  const key = String(profile._id);
  if (running.has(key)) return { ok: false, alreadyRunning: true };
  running.add(key);

  let runDoc;
  try {
    runDoc = await _createRunDoc(db, profile);

    // Step 1: scan
    let scanResult;
    try {
      scanResult = await _runScan(db, profile);
      await _patchRun(db, runDoc._id, { scan_id: scanResult.scanId, counts: scanResult.counts });
    } catch (err) {
      await _patchRun(db, runDoc._id, {
        status: 'failed',
        error: `scan: ${err.message}`,
        finished_at: new Date()
      });
      return { ok: false, run_id: runDoc._id, error: err.message };
    }

    // Step 2: dedup (best-effort — only when delete_duplicates policy is active)
    let dedupMerged = null;
    if (profile.policies && profile.policies.includes('delete_duplicates')) {
      try {
        const { reportId, merged } = await _runDedup(db, profile);
        dedupMerged = merged;
        await _patchRun(db, runDoc._id, { dedup_report_id: reportId });
      } catch (err) {
        await _patchRun(db, runDoc._id, { dedup_error: err.message });
        log(`[janitorRunner] Dedup failed for profile ${profile.name}: ${err.message}`, 'warn');
      }
    }

    // Step 3: build proposed actions via buildSuggestions
    const proposedActions = _buildProposedActions(profile, dedupMerged);

    // Step 4: AI triage (best-effort)
    let aiTriage = null;
    if (profile.aiTriage === true) {
      aiTriage = await _runAiTriage(profile, runDoc, proposedActions, scanResult.counts);
    }

    // Step 5: finalize
    await _patchRun(db, runDoc._id, {
      status: 'complete',
      finished_at: new Date(),
      proposed_actions: proposedActions,
      ai_triage: aiTriage
    });

    return { ok: true, run_id: runDoc._id };
  } catch (err) {
    log(`[janitorRunner] Unexpected error in profile ${key}: ${err.message}`, 'error');
    if (runDoc) {
      try {
        await _patchRun(db, runDoc._id, {
          status: 'failed',
          error: err.message,
          finished_at: new Date()
        });
      } catch (_) { /* swallow */ }
    }
    return { ok: false, error: err.message, run_id: runDoc?._id };
  } finally {
    running.delete(key);
  }
}

async function listRunsForProfile(db, profileId, { page = 1, limit = 20 } = {}) {
  if (!ObjectId.isValid(profileId)) return { runs: [], total: 0 };
  const filter = { profile_id: new ObjectId(profileId) };
  const skip = Math.max(0, (page - 1) * limit);
  const [total, runs] = await Promise.all([
    db.collection(COLLECTION).countDocuments(filter),
    db.collection(COLLECTION).find(filter).sort({ started_at: -1 }).skip(skip).limit(limit).toArray()
  ]);
  return { runs, total, page, limit };
}

async function getRun(db, runId) {
  if (!ObjectId.isValid(runId)) return null;
  return db.collection(COLLECTION).findOne({ _id: new ObjectId(runId) });
}

async function approveAction(db, runId, actionIdx) {
  if (!ObjectId.isValid(runId)) return { ok: false, notFound: true };
  if (typeof actionIdx !== 'number' || !Number.isInteger(actionIdx) || actionIdx < 0) {
    return { ok: false, error: 'invalid action index' };
  }
  const run = await db.collection(COLLECTION).findOne({ _id: new ObjectId(runId) });
  if (!run) return { ok: false, notFound: true };

  const action = run.proposed_actions?.[actionIdx];
  if (!action) return { ok: false, notFound: true };
  if (action.status !== 'pending') return { ok: false, error: `action is ${action.status}` };

  const token = janitorService.generateCleanupToken(action.files);
  const result = await janitorService.executeCleanup(action.files, token, false);

  if (result.ok === false) {
    return { ok: false, error: result.error };
  }

  // v1 limitation: if executeCleanup processed zero files (e.g. all paths missing
  // from disk), the action stays 'pending' — allowing re-approval. A separate
  // 'execution_failed' state is deferred to v2 to avoid blocking on this edge.
  const newStatus = (result.deleted?.length || 0) > 0 ? 'executed' : 'pending';
  const updatedAction = {
    ...action,
    status: newStatus,
    executed_at: newStatus === 'executed' ? new Date() : action.executed_at,
    result: {
      deleted: result.deleted || [],
      failed: result.failed || [],
      space_freed: result.space_freed || 0
    }
  };

  await db.collection(COLLECTION).updateOne(
    { _id: run._id },
    { $set: { [`proposed_actions.${actionIdx}`]: updatedAction } }
  );

  return { ok: true, action: updatedAction, result };
}

async function rejectAction(db, runId, actionIdx) {
  if (!ObjectId.isValid(runId)) return { ok: false, notFound: true };
  if (typeof actionIdx !== 'number' || !Number.isInteger(actionIdx) || actionIdx < 0) {
    return { ok: false, error: 'invalid action index' };
  }
  const run = await db.collection(COLLECTION).findOne({ _id: new ObjectId(runId) });
  if (!run) return { ok: false, notFound: true };

  const action = run.proposed_actions?.[actionIdx];
  if (!action) return { ok: false, notFound: true };
  if (action.status !== 'pending') return { ok: false, error: `action is ${action.status}` };

  const updatedAction = { ...action, status: 'rejected', rejected_at: new Date() };
  await db.collection(COLLECTION).updateOne(
    { _id: run._id },
    { $set: { [`proposed_actions.${actionIdx}`]: updatedAction } }
  );
  return { ok: true, action: updatedAction };
}

async function sweepStaleRuns(db) {
  const result = await db.collection(COLLECTION).updateMany(
    { status: 'running' },
    { $set: { status: 'stopped', finished_at: new Date() } }
  );
  if (result.modifiedCount > 0) {
    log(`[janitorRunner] Swept ${result.modifiedCount} stale running run(s)`);
  }
  return result.modifiedCount;
}

module.exports = {
  COLLECTION,
  AI_SAMPLE_SIZE,
  runProfile,
  listRunsForProfile,
  getRun,
  approveAction,
  rejectAction,
  sweepStaleRuns,
  _reset
};
