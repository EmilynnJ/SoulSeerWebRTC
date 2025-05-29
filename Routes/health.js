const express = require('express');
const router = express.Router();

// Detailed health check
router.get('/', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '1.0.0',
      services: {}
    };

    // Check database
    try {
      await req.db.query('SELECT 1');
      health.services.database = 'healthy';
    } catch (error) {
      health.services.database = 'unhealthy';
      health.status = 'degraded';
    }

    // Check WebRTC signaling
    if (req.signaling) {
      const stats = req.signaling.getStats();
      health.services.webrtc = {
        status: 'healthy',
        connections: stats.totalConnections,
        rooms: stats.totalRooms,
        users: stats.totalUsers
      };
    } else {
      health.services.webrtc = 'unhealthy';
      health.status = 'degraded';
    }

    // Check billing engine
    if (req.billingEngine) {
      const billingStats = await req.billingEngine.getStats();
      health.services.billing = {
        status: 'healthy',
        activeSessions: billingStats?.activeBillingSessions || 0
      };
    } else {
      health.services.billing = 'unhealthy';
      health.status = 'degraded';
    }

    // Check Stripe connection
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      await stripe.balance.retrieve();
      health.services.stripe = 'healthy';
    } catch (error) {
      health.services.stripe = 'unhealthy';
      health.status = 'degraded';
    }

    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);

  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Quick health check for load balancers
router.get('/ping', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString() 
  });
});

// WebRTC signaling stats
router.get('/webrtc', (req, res) => {
  try {
    if (!req.signaling) {
      return res.status(503).json({ error: 'WebRTC signaling not available' });
    }

    const stats = req.signaling.getStats();
    res.json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('Error getting WebRTC stats:', error);
    res.status(500).json({ error: 'Failed to get WebRTC stats' });
  }
});

// Billing engine stats
router.get('/billing', async (req, res) => {
  try {
    if (!req.billingEngine) {
      return res.status(503).json({ error: 'Billing engine not available' });
    }

    const stats = await req.billingEngine.getStats();
    res.json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('Error getting billing stats:', error);
    res.status(500).json({ error: 'Failed to get billing stats' });
  }
});

module.exports = router;
