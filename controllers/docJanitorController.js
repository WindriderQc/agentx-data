/**
 * docJanitorController.js — HTTP handlers for the markdown documentation
 * classifier. Thin wrappers around services/docJanitor.js.
 *
 * Safety posture: read-only scan. Writes are confined to the audit output
 * directory computed from the target repo; no user-supplied output paths.
 */
const path = require('path');
const fs = require('fs');
const docJanitor = require('../services/docJanitor');
const { log } = require('../utils/logger');

const DEFAULT_REPO = path.resolve(__dirname, '..', '..');

function resolveTargetRepo(raw) {
  if (!raw) return DEFAULT_REPO;
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return null;
  }
  return resolved;
}

function defaultOutputDir(targetRepo) {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(targetRepo, 'docs/audits', `docjanitor-${date}`);
}

/** POST /docs/scan — run a fresh scan, write audit, return findings */
async function scanDocs(req, res) {
  const { target_repo, write = true } = req.body || {};
  const targetRepo = resolveTargetRepo(target_repo);
  if (!targetRepo) {
    return res.status(400).json({
      status: 'error',
      message: `target_repo not found or not a directory: ${target_repo}`
    });
  }

  try {
    const outputDir = write ? defaultOutputDir(targetRepo) : null;
    const findings = docJanitor.scan({ targetRepo, outputDir });
    log(`docJanitor scan: target=${targetRepo} total=${findings.summary.total_md_files} status=${findings.status}`);
    res.json({ status: 'success', data: findings });
  } catch (err) {
    log(`docJanitor scan failed: ${err.message}`, 'error');
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/** GET /docs/latest — read the latest audit from disk (does not re-scan) */
async function latestDocsScan(req, res) {
  const { target_repo } = req.query;
  const targetRepo = resolveTargetRepo(target_repo);
  if (!targetRepo) {
    return res.status(400).json({
      status: 'error',
      message: `target_repo not found or not a directory: ${target_repo}`
    });
  }

  try {
    const latest = docJanitor.findLatestAudit(targetRepo);
    if (!latest) {
      return res.status(404).json({ status: 'error', message: 'No prior docjanitor audit found', data: { target_repo: targetRepo } });
    }
    res.json({ status: 'success', data: latest });
  } catch (err) {
    log(`docJanitor latest failed: ${err.message}`, 'error');
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/** GET /docs/runs — list historical audits (summary only) */
async function listDocsRuns(req, res) {
  const { target_repo, limit } = req.query;
  const targetRepo = resolveTargetRepo(target_repo);
  if (!targetRepo) {
    return res.status(400).json({
      status: 'error',
      message: `target_repo not found or not a directory: ${target_repo}`
    });
  }

  try {
    const parsedLimit = limit ? Math.max(1, Math.min(100, parseInt(limit, 10))) : 20;
    const runs = docJanitor.listAudits(targetRepo, parsedLimit);
    res.json({ status: 'success', data: { target_repo: targetRepo, runs } });
  } catch (err) {
    log(`docJanitor runs failed: ${err.message}`, 'error');
    res.status(500).json({ status: 'error', message: err.message });
  }
}

module.exports = { scanDocs, latestDocsScan, listDocsRuns };
