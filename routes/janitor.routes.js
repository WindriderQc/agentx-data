/**
 * Janitor routes — thin delegation to janitorController.
 */
const router = require('express').Router();
const janitorController = require('../controllers/janitorController');
const docJanitorController = require('../controllers/docJanitorController');

router.post('/analyze',       janitorController.analyze);
router.post('/suggest',       janitorController.suggest);
router.post('/execute',       janitorController.execute);
router.get('/policies',       janitorController.listPolicies);
router.post('/dedup-scan',    janitorController.dedupScan);
router.get('/dedup-report',   janitorController.dedupReport);
router.post('/dedup-approve', janitorController.dedupApprove);
router.post('/ai',            janitorController.aiChat);

// Documentation classifier (deterministic, read-only). See ADR 0002.
router.post('/docs/scan',   docJanitorController.scanDocs);
router.get('/docs/latest',  docJanitorController.latestDocsScan);
router.get('/docs/runs',    docJanitorController.listDocsRuns);

module.exports = router;
