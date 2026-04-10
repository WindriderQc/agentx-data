/**
 * janitorProfilesController.js — HTTP handlers for /api/v1/janitor/profiles.
 *
 * Thin layer over janitorProfiles + janitorRunner + janitorScheduler.
 * Translates service results into HTTP status codes; never owns business logic.
 *
 * Response shape:
 *   Success: { status: 'success', data: { ... } }
 *   Error:   { status: 'error', message: string }     (single-message errors)
 *            { status: 'error', errors: string[] }    (validation / multi-error)
 *
 * Status mapping: 201 create, 202 run accepted, 400 validation/badRequest,
 * 404 missing, 409 conflict/alreadyRunning/action-not-pending, 500 internal.
 *
 * Each mutating endpoint (create/update/remove) calls scheduler.reload() in
 * a guarded try/catch so a reload failure does not poison a successful write.
 */
const janitorProfiles = require('../services/janitorProfiles');
const janitorRunner = require('../services/janitorRunner');
const janitorScheduler = require('../services/janitorScheduler');
const { log } = require('../utils/logger');

const list = async (req, res) => {
  try {
    const profiles = await janitorProfiles.list(req.app.locals.db);
    res.json({ status: 'success', data: { profiles } });
  } catch (err) {
    log(`[janitorProfiles] list error: ${err.message}`, 'error');
    res.status(500).json({ status: 'error', message: err.message });
  }
};

const get = async (req, res) => {
  try {
    const profile = await janitorProfiles.get(req.app.locals.db, req.params.id);
    if (!profile) return res.status(404).json({ status: 'error', message: 'profile not found' });
    res.json({ status: 'success', data: { profile } });
  } catch (err) {
    log(`[janitorProfiles] get error: ${err.message}`, 'error');
    res.status(500).json({ status: 'error', message: err.message });
  }
};

const create = async (req, res) => {
  try {
    const result = await janitorProfiles.create(req.app.locals.db, req.body || {});
    if (!result.ok) {
      const status = result.conflict ? 409 : 400;
      return res.status(status).json({ status: 'error', errors: result.errors });
    }
    try {
      await janitorScheduler.reload(req.app.locals.db, String(result.profile._id));
    } catch (reloadErr) {
      log(`[janitorProfiles] scheduler reload failed (profile ${result.profile._id} created): ${reloadErr.message}`, 'warn');
    }
    res.status(201).json({ status: 'success', data: { profile: result.profile } });
  } catch (err) {
    log(`[janitorProfiles] create error: ${err.message}`, 'error');
    res.status(500).json({ status: 'error', message: err.message });
  }
};

const update = async (req, res) => {
  try {
    const result = await janitorProfiles.update(req.app.locals.db, req.params.id, req.body || {});
    if (!result.ok) {
      let status = 400;
      if (result.notFound) status = 404;
      else if (result.conflict) status = 409;
      else if (result.badRequest) status = 400;
      return res.status(status).json({ status: 'error', errors: result.errors });
    }
    try {
      await janitorScheduler.reload(req.app.locals.db, req.params.id);
    } catch (reloadErr) {
      log(`[janitorProfiles] scheduler reload failed (profile ${req.params.id} updated): ${reloadErr.message}`, 'warn');
    }
    res.json({ status: 'success', data: { profile: result.profile } });
  } catch (err) {
    log(`[janitorProfiles] update error: ${err.message}`, 'error');
    res.status(500).json({ status: 'error', message: err.message });
  }
};

const remove = async (req, res) => {
  try {
    const result = await janitorProfiles.remove(req.app.locals.db, req.params.id);
    if (!result.ok) {
      const status = result.badRequest ? 400 : 404;
      return res.status(status).json({ status: 'error', errors: result.errors });
    }
    try {
      await janitorScheduler.reload(req.app.locals.db, req.params.id);
    } catch (reloadErr) {
      log(`[janitorProfiles] scheduler reload failed (profile ${req.params.id} deleted): ${reloadErr.message}`, 'warn');
    }
    res.json({ status: 'success', message: 'profile deleted' });
  } catch (err) {
    log(`[janitorProfiles] remove error: ${err.message}`, 'error');
    res.status(500).json({ status: 'error', message: err.message });
  }
};

const run = async (req, res) => {
  try {
    const result = await janitorRunner.runProfile(req.app.locals.db, req.params.id);
    if (!result.ok) {
      if (result.notFound) return res.status(404).json({ status: 'error', message: 'profile not found' });
      if (result.alreadyRunning) return res.status(409).json({ status: 'error', message: 'profile is already running' });
      return res.status(500).json({ status: 'error', message: result.error || 'run failed' });
    }
    res.status(202).json({ status: 'success', data: { run_id: result.run_id } });
  } catch (err) {
    log(`[janitorProfiles] run error: ${err.message}`, 'error');
    res.status(500).json({ status: 'error', message: err.message });
  }
};

const listRuns = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const result = await janitorRunner.listRunsForProfile(req.app.locals.db, req.params.id, { page, limit });
    res.json({
      status: 'success',
      data: {
        runs: result.runs,
        pagination: { total: result.total, page: result.page, limit: result.limit, pages: Math.ceil(result.total / result.limit) }
      }
    });
  } catch (err) {
    log(`[janitorProfiles] listRuns error: ${err.message}`, 'error');
    res.status(500).json({ status: 'error', message: err.message });
  }
};

const getRun = async (req, res) => {
  try {
    const run = await janitorRunner.getRun(req.app.locals.db, req.params.run_id);
    if (!run) return res.status(404).json({ status: 'error', message: 'run not found' });
    res.json({ status: 'success', data: { run } });
  } catch (err) {
    log(`[janitorProfiles] getRun error: ${err.message}`, 'error');
    res.status(500).json({ status: 'error', message: err.message });
  }
};

const approve = async (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    if (Number.isNaN(idx) || idx < 0) return res.status(400).json({ status: 'error', message: 'invalid action index' });
    const result = await janitorRunner.approveAction(req.app.locals.db, req.params.run_id, idx);
    if (!result.ok) {
      if (result.notFound) return res.status(404).json({ status: 'error', message: 'run or action not found' });
      return res.status(409).json({ status: 'error', message: result.error });
    }
    res.json({ status: 'success', data: { action: result.action, result: result.result } });
  } catch (err) {
    log(`[janitorProfiles] approve error: ${err.message}`, 'error');
    res.status(500).json({ status: 'error', message: err.message });
  }
};

const reject = async (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    if (Number.isNaN(idx) || idx < 0) return res.status(400).json({ status: 'error', message: 'invalid action index' });
    const result = await janitorRunner.rejectAction(req.app.locals.db, req.params.run_id, idx);
    if (!result.ok) {
      if (result.notFound) return res.status(404).json({ status: 'error', message: 'run or action not found' });
      return res.status(409).json({ status: 'error', message: result.error });
    }
    res.json({ status: 'success', data: { action: result.action } });
  } catch (err) {
    log(`[janitorProfiles] reject error: ${err.message}`, 'error');
    res.status(500).json({ status: 'error', message: err.message });
  }
};

module.exports = { list, get, create, update, remove, run, listRuns, getRun, approve, reject };
