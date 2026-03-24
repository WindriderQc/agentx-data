const router = require('express').Router();
const exportController = require('../controllers/exportController');

router.post('/generate', exportController.generateReport);
router.get('/', exportController.listExports);
router.delete('/:filename', exportController.deleteExport);

module.exports = router;
