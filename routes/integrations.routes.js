/**
 * Integrations — webhook sink for n8n, ClickUp, etc.
 */
const router = require('express').Router();
const ctrl = require('../controllers/integrationController');

router.post('/events/n8n', ctrl.createN8nEvent);
router.get('/events/n8n', ctrl.getN8nEvents);
router.post('/webhooks/clickup', ctrl.createClickUpEvent);
router.post('/webhooks/:source', ctrl.createWebhookEvent);

module.exports = router;
