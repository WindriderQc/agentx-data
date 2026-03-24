const router = require('express').Router();
const systemController = require('../controllers/systemController');

router.get('/resources', systemController.getSystemStats);

module.exports = router;
