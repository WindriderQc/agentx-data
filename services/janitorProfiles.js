/**
 * janitorProfiles.js — CRUD + validation for janitor_profiles collection.
 *
 * Pure module: takes a db handle as a parameter, returns docs/results.
 * Scheduler/runner own their own state separately.
 */
const { ObjectId } = require('mongodb');
const { POLICIES, resolveAllowedPath } = require('./janitorService');

const COLLECTION = 'janitor_profiles';

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 43200; // 30 days

/**
 * Validate a profile doc.
 * @param {Object} doc
 * @returns {Promise<{ok: true} | {ok: false, errors: string[]}>}
 */
async function validate(doc) {
  const errors = [];

  if (!doc || typeof doc !== 'object') {
    return { ok: false, errors: ['profile must be an object'] };
  }

  if (!doc.name || typeof doc.name !== 'string' || doc.name.trim() === '') {
    errors.push('name is required');
  }

  if (!Array.isArray(doc.roots) || doc.roots.length === 0) {
    errors.push('roots must be a non-empty array');
  } else {
    for (const root of doc.roots) {
      const safe = await resolveAllowedPath(root, { mustExist: false });
      if (!safe.ok) {
        errors.push(`root "${root}": ${safe.reason}`);
      }
    }
  }

  if (doc.policies !== undefined) {
    if (!Array.isArray(doc.policies)) {
      errors.push('policies must be an array');
    } else {
      for (const id of doc.policies) {
        if (!POLICIES[id]) errors.push(`unknown policy: ${id}`);
      }
    }
  }

  if (doc.schedule !== null && doc.schedule !== undefined) {
    if (typeof doc.schedule !== 'object') {
      errors.push('schedule must be an object or null');
    } else if (doc.schedule.enabled === true) {
      const m = doc.schedule.intervalMinutes;
      if (typeof m !== 'number' || !Number.isFinite(m)) {
        errors.push('schedule.intervalMinutes is required when enabled');
      } else if (m < MIN_INTERVAL_MINUTES || m > MAX_INTERVAL_MINUTES) {
        errors.push(`schedule.intervalMinutes must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`);
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * Normalize an input doc into the canonical persisted shape.
 */
function normalize(doc) {
  return {
    name: String(doc.name).trim(),
    roots: doc.roots.map(r => String(r)),
    extensions: {
      include: Array.isArray(doc.extensions?.include) ? doc.extensions.include.map(s => String(s).toLowerCase()) : [],
      exclude: Array.isArray(doc.extensions?.exclude) ? doc.extensions.exclude.map(s => String(s).toLowerCase()) : []
    },
    computeHashes: doc.computeHashes !== false,
    policies: Array.isArray(doc.policies) ? [...doc.policies] : [],
    schedule: doc.schedule ? {
      enabled: !!doc.schedule.enabled,
      intervalMinutes: doc.schedule.intervalMinutes ?? null
    } : null,
    aiTriage: !!doc.aiTriage
  };
}

async function list(db) {
  return db.collection(COLLECTION).find({}).sort({ updatedAt: -1 }).toArray();
}

async function get(db, id) {
  if (!id || !ObjectId.isValid(id)) return null;
  return db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
}

async function getByName(db, name) {
  return db.collection(COLLECTION).findOne({ name });
}

async function create(db, input) {
  const validation = await validate(input);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const existing = await getByName(db, input.name.trim());
  if (existing) return { ok: false, errors: [`name "${input.name}" already exists`], conflict: true };

  const now = new Date();
  const doc = { ...normalize(input), createdAt: now, updatedAt: now };
  const result = await db.collection(COLLECTION).insertOne(doc);
  return { ok: true, profile: { ...doc, _id: result.insertedId } };
}

async function update(db, id, input) {
  if (!id || !ObjectId.isValid(id)) return { ok: false, errors: ['invalid id'], badRequest: true };

  const validation = await validate(input);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const objectId = new ObjectId(id);

  const collision = await db.collection(COLLECTION).findOne({
    name: input.name.trim(),
    _id: { $ne: objectId }
  });
  if (collision) return { ok: false, errors: [`name "${input.name}" already exists`], conflict: true };

  const updates = { ...normalize(input), updatedAt: new Date() };
  const result = await db.collection(COLLECTION).findOneAndUpdate(
    { _id: objectId },
    { $set: updates },
    { returnDocument: 'after' }
  );
  // MongoDB driver v4/v5 returned { value: doc }; v6+ returns the doc directly.
  // This handles both shapes; do not "simplify" without confirming the driver version.
  const profile = result?.value || result;
  if (!profile) return { ok: false, errors: ['profile not found'], notFound: true };
  return { ok: true, profile };
}

async function remove(db, id) {
  if (!id || !ObjectId.isValid(id)) return { ok: false, errors: ['invalid id'], badRequest: true };
  const result = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
  if (result.deletedCount === 0) return { ok: false, notFound: true };
  return { ok: true };
}

module.exports = {
  COLLECTION,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  validate,
  normalize,
  list,
  get,
  getByName,
  create,
  update,
  remove
};
