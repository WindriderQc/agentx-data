const router = require('express').Router();
const liveDataController = require('../controllers/liveDataController');

router.get('/state', liveDataController.getState);
router.get('/config', liveDataController.getConfig);
router.post('/config', liveDataController.updateConfig);
router.get('/iss', liveDataController.getISS);
router.get('/quakes', liveDataController.getQuakes);

module.exports = router;
