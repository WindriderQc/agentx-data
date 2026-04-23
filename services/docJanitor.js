/**
 * docJanitor.js — markdown documentation classifier.
 *
 * Walks a repository's `.md` files, classifies each as PERMANENT / TRANSIENT /
 * UNKNOWN by deterministic rules (canonical names, permanent/transient dirs,
 * filename keywords, ISO dates, ROADMAP.md status), and emits findings.json +
 * summary.md to an output directory.
 *
 * Ported from the ad-hoc classifier at /tmp/dj-classify.js (2026-04-23 first
 * run) per ADR 0002: deterministic capabilities live as service endpoints, not
 * roles.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CANONICAL_NAMES = new Set([
  'readme.md', 'contributing.md', 'changelog.md',
  'claude.md', 'agents.md', 'governance.md', 'workflow.md', 'api.md',
  'llm.md', 'llm_usage.md'
]);

const PERMANENT_DOC_DIRS = [
  'docs/architecture/', 'docs/operations/', 'docs/patterns/', 'docs/api/',
  'docs/guides/', 'docs/onboarding/', 'docs/user-manual/', 'docs/integrations/'
];

const TRANSIENT_DIRS = [
  'docs/reports/', 'docs/future/', 'docs/_archive/', 'docs/audits/',
  'TODO/FEEDBACK/', 'TODO/OVERSEER/'
];

const TRANSIENT_KEYWORDS = [
  'wip', 'draft', 'plan', 'notes', 'progress', 'meeting',
  'review', 'scratch', 'brainstorm', 'handoff', 'deliverable',
  'summary', 'complete', 'session', 'sprint-close', 'peer-review'
];

const DATE_RE = /\d{4}-\d{2}-\d{2}/;

function listMdFiles(repoRoot) {
  const args = [
    '.', '-type', 'f', '-name', '*.md',
    '-not', '-path', '*/node_modules/*',
    '-not', '-path', '*/.git/*',
    '-not', '-path', '*/logs/*',
    '-not', '-path', '*/coverage/*',
    '-not', '-path', '*/dist/*',
    '-not', '-path', '*/build/*',
    '-not', '-path', '*/test-results/*',
    '-not', '-path', '*/.worktrees/*',
    '-not', '-path', '*/.claude/*'
  ];
  const out = execFileSync('find', args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 }).toString().trim();
  if (!out) return [];
  return out.split('\n').map(s => s.replace(/^\.\//, ''));
}

function parseRoadmap(repoRoot) {
  const roadmapPath = path.join(repoRoot, 'TODO/ROADMAP.md');
  const entries = new Map();
  if (!fs.existsSync(roadmapPath)) return entries;
  const text = fs.readFileSync(roadmapPath, 'utf8');
  const re = /^- \[( |x|revert)\]\s+(?:\*\*)?`?(\d{4})`?/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const status = m[1];
    const id = m[2];
    if (!entries.has(id)) {
      entries.set(id, { checked: status === 'x' || status === 'revert', status });
    }
  }
  return entries;
}

function basename(p) { return path.basename(p).toLowerCase(); }

function isTransientByName(p) {
  const b = basename(p);
  if (DATE_RE.test(b)) return true;
  return TRANSIENT_KEYWORDS.some(k => b.includes(k));
}

function classify(p, roadmap) {
  const rel = p.replace(/\\/g, '/');
  const b = basename(rel);

  if (rel.startsWith('roles/')) {
    return { category: 'PERMANENT', reason: 'Active role playbook' };
  }

  if (CANONICAL_NAMES.has(b)) {
    if (!rel.startsWith('TODO/FEEDBACK/') && !rel.startsWith('docs/audits/')) {
      return { category: 'PERMANENT', reason: 'Canonical repo/service doc' };
    }
  }

  for (const d of TRANSIENT_DIRS) {
    if (rel.startsWith(d)) return { category: 'TRANSIENT', reason: `Under ${d}` };
  }

  if (rel.startsWith('TODO/') && !rel.startsWith('TODO/FEEDBACK/') && !rel.startsWith('TODO/OVERSEER/')) {
    const idMatch = b.match(/^(\d{4})-/);
    if (idMatch) {
      const id = idMatch[1];
      const entry = roadmap.get(id);
      if (!entry) return { category: 'UNKNOWN', reason: `TODO/${id} not found in ROADMAP.md` };
      if (entry.checked) return { category: 'TRANSIENT', reason: `ROADMAP entry ${id} is completed/reverted (${entry.status})` };
      return { category: 'PERMANENT', reason: `Active TODO task (ROADMAP ${id} unchecked)` };
    }
    if (b === 'roadmap.md' || b === 'assignments.md') {
      return { category: 'PERMANENT', reason: 'TODO pipeline control file' };
    }
    return { category: 'UNKNOWN', reason: 'TODO file without ID and not a control file' };
  }

  if (rel === 'TODO_TASK_TEMPLATE.md') {
    return { category: 'PERMANENT', reason: 'TODO template, referenced by WORKFLOW' };
  }

  if (!rel.includes('/') && /^todo[-_]/i.test(b)) {
    return { category: 'TRANSIENT', reason: 'Root-level TODO-prefixed doc (should live under TODO/ or be archived)' };
  }

  for (const d of PERMANENT_DOC_DIRS) {
    if (rel.startsWith(d)) {
      if (isTransientByName(rel)) {
        return { category: 'TRANSIENT', reason: `Under ${d} but filename suggests transient/WIP` };
      }
      return { category: 'PERMANENT', reason: `Core docs area (${d})` };
    }
  }

  if (rel.startsWith('docs/decisions/') || rel.startsWith('docs/benchmark/') || rel.startsWith('docs/superpowers/')) {
    if (isTransientByName(rel)) {
      return { category: 'TRANSIENT', reason: `Under ${rel.split('/').slice(0, 2).join('/')}/ but filename transient` };
    }
    return { category: 'PERMANENT', reason: `Scoped docs area (${rel.split('/').slice(0, 2).join('/')}/)` };
  }

  if (rel.startsWith('docs/') && rel.split('/').length === 2) {
    if (isTransientByName(rel)) {
      return { category: 'TRANSIENT', reason: 'docs/ root file with transient filename' };
    }
    return { category: 'PERMANENT', reason: 'docs/ root canonical reference' };
  }

  if (!rel.includes('/') && isTransientByName(rel)) {
    return { category: 'TRANSIENT', reason: 'Root-level status/summary document' };
  }

  if (/\/(tests|scripts|gift)\//.test(rel) || /\/public\//.test(rel)) {
    if (isTransientByName(rel)) {
      return { category: 'TRANSIENT', reason: 'Under tests/scripts/public/ with transient name' };
    }
    return { category: 'PERMANENT', reason: 'Test/script/public companion doc' };
  }

  if (rel.startsWith('docs/')) {
    return { category: 'UNKNOWN', reason: 'Under docs/ but not clearly mapped' };
  }

  if (isTransientByName(rel)) {
    return { category: 'TRANSIENT', reason: 'Filename suggests transient/WIP' };
  }

  return { category: 'UNKNOWN', reason: 'Outside docs/ and not canonical' };
}

function buildObservations(files, summary) {
  const observations = [];

  if (!fs.existsSync) return observations;

  observations.push({
    severity: 'warn',
    type: 'missing_docs_index',
    message: 'No docs/INDEX.md present. Authority derived from root canonical files + ROADMAP.md only.'
  });

  const feedbackCount = files.filter(f => f.path.startsWith('TODO/FEEDBACK/')).length;
  if (feedbackCount > 50) {
    observations.push({
      severity: 'warn',
      type: 'feedback_sprawl',
      message: `TODO/FEEDBACK/ contains ${feedbackCount} files. These are historical verification blocks; consider archival.`,
      metadata: { count: feedbackCount }
    });
  }

  const completedTodos = files.filter(f =>
    f.path.startsWith('TODO/') && !f.path.startsWith('TODO/FEEDBACK/') &&
    !f.path.startsWith('TODO/OVERSEER/') && f.category === 'TRANSIENT' &&
    /ROADMAP entry \d{4} is completed/.test(f.reason)
  );
  if (completedTodos.length > 0) {
    observations.push({
      severity: 'info',
      type: 'completed_todos_still_present',
      message: `${completedTodos.length} TODO task file(s) with completed/reverted ROADMAP entries remain in TODO/.`,
      metadata: { count: completedTodos.length, paths: completedTodos.map(f => f.path) }
    });
  }

  const unknownRatio = summary.total_md_files > 0 ? summary.unknown / summary.total_md_files : 0;
  if (unknownRatio > 0.2) {
    observations.push({
      severity: 'warn',
      type: 'high_unknown_ratio',
      message: `UNKNOWN rate ${Math.round(unknownRatio * 100)}% exceeds 20% threshold`,
      metadata: { unknown: summary.unknown, total: summary.total_md_files }
    });
  }

  const rootTransient = files.filter(f => !f.path.includes('/') && f.category === 'TRANSIENT');
  if (rootTransient.length > 0) {
    observations.push({
      severity: 'info',
      type: 'root_transient',
      message: `${rootTransient.length} root-level transient file(s) — consider relocating or archiving.`,
      metadata: { paths: rootTransient.map(f => f.path) }
    });
  }

  return observations;
}

function buildRecommendations(files) {
  const recs = [];

  const feedbackCount = files.filter(f => f.path.startsWith('TODO/FEEDBACK/')).length;
  if (feedbackCount > 50) {
    recs.push({
      severity: 'info',
      title: 'Archive TODO/FEEDBACK/ backlog',
      message: `${feedbackCount} feedback verification blocks accumulated. These document completed work and should be archived to keep TODO/ navigable.`,
      related_paths: ['TODO/FEEDBACK/'],
      actions: [
        'Move TODO/FEEDBACK/* to TODO/_archive/FEEDBACK-<YYYY-MM>/',
        'Keep only the 10 most recent entries in TODO/FEEDBACK/ as a working buffer',
        'Optional: generate an index at TODO/FEEDBACK/INDEX.md summarizing archived entries'
      ]
    });
  }

  const completedTodos = files.filter(f =>
    f.path.startsWith('TODO/') && !f.path.startsWith('TODO/FEEDBACK/') &&
    !f.path.startsWith('TODO/OVERSEER/') && f.category === 'TRANSIENT' &&
    /ROADMAP entry \d{4} is completed/.test(f.reason)
  );
  if (completedTodos.length > 0) {
    recs.push({
      severity: 'info',
      title: 'Archive completed TODO task files',
      message: 'Task files whose ROADMAP entries are checked/reverted should move to an archive directory.',
      related_paths: completedTodos.map(f => f.path),
      actions: [
        'Move completed task files to TODO/_archive/<YYYY-MM>/',
        'Leave only [ ]-state tasks in TODO/ root'
      ]
    });
  }

  const rootTransient = files.filter(f => !f.path.includes('/') && f.category === 'TRANSIENT');
  if (rootTransient.length > 0) {
    recs.push({
      severity: 'info',
      title: 'Relocate root-level transient docs',
      message: 'Root-level files with transient names clutter the ecosystem root. Move them under docs/_archive/ or dedicated scoped areas.',
      related_paths: rootTransient.map(f => f.path),
      actions: rootTransient.map(f => `Move ${f.path} → docs/_archive/2026-04/${path.basename(f.path)}`)
    });
  }

  recs.push({
    severity: 'info',
    title: 'Create docs/INDEX.md as canonical authority',
    message: 'No index currently exists. A docs/INDEX.md linking PERMANENT docs would let future DocJanitor runs use index-authority (higher confidence) instead of path heuristics.',
    related_paths: ['docs/'],
    actions: [
      'Draft docs/INDEX.md linking every PERMANENT doc surfaced by this scan',
      'Add PR review rule: new docs must be linked from INDEX.md or land under docs/_archive/'
    ]
  });

  const unknowns = files.filter(f => f.category === 'UNKNOWN');
  if (unknowns.length > 0) {
    recs.push({
      severity: 'warn',
      title: `Triage ${unknowns.length} UNKNOWN doc(s)`,
      message: 'These files could not be classified confidently; a human should mark each as keep, archive, or delete.',
      related_paths: unknowns.map(f => f.path),
      actions: ['Review each path', 'Move to appropriate docs/ or TODO/ subtree, or archive']
    });
  }

  return recs;
}

function buildSummaryMarkdown(findings) {
  const { summary, observations, recommendations, files, scanned_at, status, target_repo } = findings;
  const topRecs = recommendations.slice(0, 5).map((r, i) => `${i + 1}. **${r.title}** — ${r.message}`).join('\n');
  const obs = observations.map(o => `- [${o.severity}] **${o.type}**: ${o.message}`).join('\n');
  const unknowns = files.filter(f => f.category === 'UNKNOWN');
  const unknownList = unknowns.length === 0
    ? '_(none)_'
    : unknowns.map(f => `- \`${f.path}\` — ${f.reason}`).join('\n');

  return `# DocJanitor Scan — ${path.basename(target_repo)}

**Scanned:** ${scanned_at}
**Status:** ${status}
**Target:** ${target_repo}
**Index:** none (authority from root canonical files + ROADMAP.md)

## Summary
- Total .md files: **${summary.total_md_files}**
- PERMANENT: ${summary.permanent}
- TRANSIENT: ${summary.transient}
- UNVERIFIED: ${summary.unverified}
- UNKNOWN: ${summary.unknown}

## Observations
${obs}

## Top recommendations
${topRecs}

## UNKNOWN files
${unknownList}

## Next steps
- Human reviews findings.json
- Decide per recommendation: approve / defer / reject
- Execute approved moves (DocJanitor does not execute)
- Optionally create docs/INDEX.md so the next run uses index-authority
`;
}

/**
 * Run the scan against `targetRepo`. Returns the findings object. If
 * `outputDir` is provided and writable, also writes findings.json + summary.md
 * there.
 */
function scan({ targetRepo, outputDir = null }) {
  if (!targetRepo) throw new Error('targetRepo required');
  const resolved = path.resolve(targetRepo);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`targetRepo not found or not a directory: ${resolved}`);
  }

  const roadmap = parseRoadmap(resolved);
  const paths = listMdFiles(resolved);

  const files = paths.map(p => {
    const full = path.join(resolved, p);
    let stat = null;
    try { stat = fs.statSync(full); } catch { /* ignore */ }
    const cls = classify(p, roadmap);
    return {
      path: p,
      category: cls.category,
      reason: cls.reason,
      referenced_by_index: false,
      size_bytes: stat ? stat.size : 0,
      mtime: stat ? stat.mtime.toISOString() : null,
      mismatches: []
    };
  }).sort((a, b) => a.path.localeCompare(b.path));

  const summary = {
    total_md_files: files.length,
    permanent: files.filter(f => f.category === 'PERMANENT').length,
    transient: files.filter(f => f.category === 'TRANSIENT').length,
    unverified: files.filter(f => f.category === 'UNVERIFIED').length,
    unknown: files.filter(f => f.category === 'UNKNOWN').length,
    index_links: 0,
    broken_index_links: 0
  };

  const observations = buildObservations(files, summary);
  const recommendations = buildRecommendations(files);
  const status = observations.some(o => o.severity === 'fail') ? 'fail'
    : observations.some(o => o.severity === 'warn') ? 'warn'
      : 'ok';

  const findings = {
    target_repo: resolved,
    index_path: null,
    scanned_at: new Date().toISOString(),
    status,
    summary,
    files,
    broken_index_links: [],
    observations,
    recommendations,
    roadmap_entries_parsed: roadmap.size
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'findings.json'), JSON.stringify(findings, null, 2));
    fs.writeFileSync(path.join(outputDir, 'summary.md'), buildSummaryMarkdown(findings));
    findings.output_dir = outputDir;
  }

  return findings;
}

/**
 * Locate the most recent docjanitor audit dir under `<targetRepo>/docs/audits/`.
 * Returns null if none exist.
 */
function findLatestAudit(targetRepo) {
  const auditsRoot = path.join(targetRepo, 'docs/audits');
  if (!fs.existsSync(auditsRoot)) return null;
  const dirs = fs.readdirSync(auditsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('docjanitor-'))
    .map(d => d.name)
    .sort();
  if (dirs.length === 0) return null;
  const latest = dirs[dirs.length - 1];
  const dir = path.join(auditsRoot, latest);
  const findingsPath = path.join(dir, 'findings.json');
  if (!fs.existsSync(findingsPath)) return null;
  const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  return { dir, name: latest, findings };
}

/**
 * List all docjanitor audit runs (newest first) under the given repo.
 * Lightweight — reads only the summary fields, not the full files list.
 */
function listAudits(targetRepo, limit = 20) {
  const auditsRoot = path.join(targetRepo, 'docs/audits');
  if (!fs.existsSync(auditsRoot)) return [];
  const dirs = fs.readdirSync(auditsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('docjanitor-'))
    .map(d => d.name)
    .sort()
    .reverse()
    .slice(0, limit);

  return dirs.map(name => {
    const dir = path.join(auditsRoot, name);
    const findingsPath = path.join(dir, 'findings.json');
    if (!fs.existsSync(findingsPath)) return { name, dir, error: 'findings.json missing' };
    try {
      const f = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
      return {
        name,
        dir,
        scanned_at: f.scanned_at,
        status: f.status,
        summary: f.summary,
        observation_count: f.observations ? f.observations.length : 0,
        recommendation_count: f.recommendations ? f.recommendations.length : 0
      };
    } catch (e) {
      return { name, dir, error: e.message };
    }
  });
}

module.exports = { scan, findLatestAudit, listAudits };
