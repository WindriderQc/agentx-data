/**
 * Janitor routes — thin delegation to janitorController.
 */
const router = require('express').Router();
const janitorController = require('../controllers/janitorController');

router.post('/analyze',       janitorController.analyze);
router.post('/suggest',       janitorController.suggest);
router.post('/execute',       janitorController.execute);
router.get('/policies',       janitorController.listPolicies);
router.post('/dedup-scan',    janitorController.dedupScan);
router.get('/dedup-report',   janitorController.dedupReport);
router.post('/dedup-approve', janitorController.dedupApprove);
router.post('/ai',            janitorController.aiChat);

module.exports = router;
