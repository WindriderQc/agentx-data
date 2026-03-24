const router = require('express').Router();
const db = require('../controllers/databasesController');

router.get('/collections', db.listCollections);
router.get('/collections/:name', db.queryCollection);
router.get('/collections/:name/stats', db.getCollectionStats);
router.get('/collections/:name/:id', db.getDocument);

module.exports = router;
