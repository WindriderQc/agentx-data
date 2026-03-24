const router = require('express').Router();
const storageController = require('../controllers/storageController');
const fileBrowserController = require('../controllers/fileBrowserController');

// --- Storage Scanner ---
router.get('/scans', storageController.listScans);
router.post('/scan', storageController.scan);
router.get('/status/:scan_id', storageController.getStatus);
router.post('/stop/:scan_id', storageController.stopScan);
router.get('/directory-count', storageController.getDirectoryCount);
router.get('/summary', storageController.getSummary);

// Batch operations (n8n workflow support)
router.post('/scan/:scan_id/batch', storageController.insertBatch);
router.patch('/scan/:scan_id', storageController.updateScan);
router.get('/scan/:scan_id', storageController.getStatus);

// --- File Browser ---
router.get('/files/browse', fileBrowserController.browseFiles);
router.patch('/files/:id', fileBrowserController.updateFile);
router.get('/files/stats', fileBrowserController.getStats);
router.get('/files/tree', fileBrowserController.getDirectoryTree);
router.get('/files/duplicates', fileBrowserController.findDuplicates);
router.get('/files/cleanup-recommendations', fileBrowserController.getCleanupRecommendations);

// --- Datalake Janitor ---
router.post('/janitor/suggest-deletions', fileBrowserController.suggestDeletions);
router.post('/janitor/mark-for-deletion', fileBrowserController.markForDeletion);
router.get('/janitor/pending-deletions', fileBrowserController.getPendingDeletions);
router.delete('/janitor/confirm-deletion/:id', fileBrowserController.confirmDeletion);

module.exports = router;
