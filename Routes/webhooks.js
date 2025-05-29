const express = require('express');
const router = express.Router();

// Webhook endpoint for external services
router.post('/external', async (req, res) => {
  try {
    const { event, data } = req.body;
    
    console.log('Received webhook:', event, data);
    
    res.json({ success: true, received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
