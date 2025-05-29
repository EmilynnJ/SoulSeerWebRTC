require('dotenv').config();
const express = require('express');
const router = express.Router();

// Charge for session billing
router.post('/charge', async (req, res) => {
  try {
    const {
      sessionId,
      clientId,
      readerId,
      clientStripeCustomerId,
      readerStripeAccountId,
      rate,
      billingType = 'per_minute',
      duration
    } = req.body;

    if (!sessionId || !clientId || !readerId || !rate) {
      return res.status(400).json({ 
        error: 'Missing required fields: sessionId, clientId, readerId, rate' 
      });
    }

    console.log(`💳 Starting billing for session ${sessionId}`);

    const billingResult = await req.billingEngine.startSession({
      sessionId,
      clientId,
      readerId,
      clientStripeCustomerId,
      readerStripeAccountId,
      rate: parseFloat(rate),
      billingType,
      duration: duration ? parseInt(duration) : null
    });

    res.json({
      success: true,
      billing: billingResult,
      message: `Billing started for session ${sessionId}`
    });

  } catch (error) {
    console.error('Error starting billing:', error);
    res.status(500).json({ 
      error: 'Failed to start billing',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// End billing for a session
router.post('/end', async (req, res) => {
  try {
    const { sessionId, reason = 'completed' } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    const billingResult = await req.billingEngine.endSession(sessionId, reason);

    res.json({
      success: true,
      billing: billingResult,
      message: `Billing ended for session ${sessionId}`
    });

  } catch (error) {
    console.error('Error ending billing:', error);
    res.status(500).json({ 
      error: 'Failed to end billing',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Process gift payment
router.post('/gift', async (req, res) => {
  try {
    const {
      streamId,
      senderId,
      receiverId,
      giftType,
      amount,
      senderStripeCustomerId,
      receiverStripeAccountId,
      message = ''
    } = req.body;

    if (!streamId || !senderId || !receiverId || !giftType || !amount) {
      return res.status(400).json({ 
        error: 'Missing required fields: streamId, senderId, receiverId, giftType, amount' 
      });
    }

    const giftResult = await req.billingEngine.processGift({
      streamId,
      senderId,
      receiverId,
      giftType,
      amount: parseFloat(amount),
      senderStripeCustomerId,
      receiverStripeAccountId,
      message
    });

    res.json({
      success: true,
      gift: giftResult,
      message: `Gift processed: ${giftType} ($${amount})`
    });

  } catch (error) {
    console.error('Error processing gift:', error);
    res.status(500).json({ 
      error: 'Failed to process gift',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get billing statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await req.billingEngine.getStats();
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error getting billing stats:', error);
    res.status(500).json({ 
      error: 'Failed to get billing stats',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Webhook endpoint for Stripe events
router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SIGNING_SECRET;

  let event;

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console
