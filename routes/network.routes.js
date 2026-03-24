const router = require('express').Router();
const networkController = require('../controllers/networkController');

router.get('/devices', networkController.getAllDevices);
router.post('/scan', networkController.scanNetwork);
router.patch('/devices/:id', networkController.updateDevice);
router.post('/devices/:id/enrich', networkController.enrichDevice);

module.exports = router;
