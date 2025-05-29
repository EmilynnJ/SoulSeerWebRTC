const express = require('express');
const router = express.Router();

// Get billing info for session
router.get('/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Basic billing calculation
    const sessionStart = req.query.startTime || Date.now();
    const currentTime = Date.now();
    const durationMs = currentTime - sessionStart;
    const totalMinutes = Math.floor(durationMs / (1000 * 60));
    const rate = parseFloat(req.query.rate) || 3.99; // Default $3.99/min
    const amountCharged = (totalMinutes * rate).toFixed(2);
    
    res.json({
      success: true,
      sessionId,
      totalMinutes,
      rate,
      amountCharged: parseFloat(amountCharged),
      status: 'active',
      currency: 'USD'
    });
  } catch (error) {
    console.error('Error getting billing info:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get billing info' 
    });
  }
});

// Calculate final billing for completed session
router.post('/session/:sessionId/finalize', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { startTime, endTime, rate } = req.body;
    
    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'Missing startTime or endTime'
      });
    }
    
    const durationMs = endTime - startTime;
    const totalMinutes = Math.ceil(durationMs / (1000 * 60)); // Round up minutes
    const sessionRate = parseFloat(rate) || 3.99;
    const amountCharged = (totalMinutes * sessionRate).toFixed(2);
    
    res.json({
      success: true,
      sessionId,
      totalMinutes,
      rate: sessionRate,
      amountCharged: parseFloat(amountCharged),
      status: 'completed',
      currency: 'USD',
      billingDetails: {
        startTime,
        endTime,
        durationMs,
        ratePerMinute: sessionRate
      }
    });
  } catch (error) {
    console.error('Error finalizing billing:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to finalize billing' 
    });
  }
});

// Get billing summary for user
router.get('/user/:userId/summary', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // This would typically query your database for user's billing history
    res.json({
      success: true,
      userId,
      totalSessions: 0,
      totalAmount: 0.00,
      averageSessionLength: 0,
      currency: 'USD'
    });
  } catch (error) {
    console.error('Error getting billing summary:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get billing summary' 
    });
  }
});

module.exports = router;
