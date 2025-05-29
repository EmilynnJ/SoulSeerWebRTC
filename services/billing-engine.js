require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cron = require('node-cron');

class BillingEngine {
  constructor(database) {
    this.db = database;
    this.activeBilling = new Map(); // sessionId -> billing data
    this.billingIntervals = new Map(); // sessionId -> interval
    
    // Start cleanup job for stale billing sessions
    this.startCleanupJob();
  }

  async startSession(sessionData) {
    try {
      const {
        sessionId,
        clientId,
        readerId,
        clientStripeCustomerId,
        readerStripeAccountId,
        rate,
        billingType,
        duration
      } = sessionData;

      console.log(`💳 Starting billing for session ${sessionId}`);

      // Create initial payment intent for validation
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(rate * 100), // Hold amount for first minute
        currency: 'usd',
        customer: clientStripeCustomerId,
        capture_method: 'manual',
        confirmation_method: 'manual',
        metadata: {
          sessionId,
          readerId,
          type: 'reading_session_hold'
        }
      });

      // Store billing session data
      await this.db.query(`
        UPDATE webrtc_sessions 
        SET 
          stripe_payment_intent_id = $1, 
          start_time = NOW(), 
          status = 'active',
          updated_at = NOW()
        WHERE id = $2
      `, [paymentIntent.id, sessionId]);

      // Store billing data
      this.activeBilling.set(sessionId, {
        sessionId,
        clientId,
        readerId,
        clientStripeCustomerId,
        readerStripeAccountId,
        rate: parseFloat(rate),
        billingType,
        duration: duration ? parseInt(duration) : null,
        paymentIntentId: paymentIntent.id,
        startTime: Date.now(),
        totalMinutes: 0,
        totalCharged: 0,
        lastBillingTime: Date.now()
      });

      // Start per-minute billing if applicable
      if (billingType === 'per_minute') {
        this.startPerMinuteBilling(sessionId);
      } else if (billingType === 'fixed_duration' && duration) {
        await this.processFixedDurationPayment(sessionId);
      }

      return {
        success: true,
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret
      };

    } catch (error) {
      console.error('Error starting billing session:', error);
      throw error;
    }
  }

  startPerMinuteBilling(sessionId) {
    const billingData = this.activeBilling.get(sessionId);
    if (!billingData) {
      console.error(`No billing data found for session ${sessionId}`);
      return;
    }

    console.log(`⏰ Starting per-minute billing for session ${sessionId} at $${billingData.rate}/min`);

    const billingInterval = setInterval(async () => {
      try {
        await this.processMinuteBilling(sessionId);
      } catch (error) {
        console.error('Error in per-minute billing:', error);
        await this.endSession(sessionId, 'billing_error');
      }
    }, 60000); // Every minute

    this.billingIntervals.set(sessionId, billingInterval);
  }

  async processMinuteBilling(sessionId) {
    const billingData = this.activeBilling.get(sessionId);
    if (!billingData) {
      console.error(`No billing data found for session ${sessionId}`);
      return;
    }

    try {
      const minutesElapsed = Math.floor((Date.now() - billingData.startTime) / 60000);
      
      if (minutesElapsed <= billingData.totalMinutes) {
        return; // Already billed for this minute
      }

      console.log(`💳 Processing minute ${minutesElapsed} for session ${sessionId}`);

      // Create charge for this minute
      const charge = await stripe.paymentIntents.create({
        amount: Math.round(billingData.rate * 100),
        currency: 'usd',
        customer: billingData.clientStripeCustomerId,
        confirm: true,
        payment_method_types: ['card'],
        metadata: {
          sessionId,
          readerId: billingData.readerId,
          minute: minutesElapsed,
          type: 'per_minute_charge'
        }
      });

      // Calculate platform fee (15%) and reader payment (85%)
      const platformFee = Math.round(billingData.rate * 0.15 * 100);
      const readerAmount = Math.round(billingData.rate * 0.85 * 100);

      // Transfer to reader (if they have a connected account)
      if (billingData.readerStripeAccountId) {
        await stripe.transfers.create({
          amount: readerAmount,
          currency: 'usd',
          destination: billingData.readerStripeAccountId,
          metadata: {
            sessionId,
            minute: minutesElapsed,
            type: 'reading_payment'
          }
        });
      }

      // Update billing data
      billingData.totalMinutes = minutesElapsed;
      billingData.totalCharged += billingData.rate;
      billingData.lastBillingTime = Date.now();

      // Update session in database
      await this.db.query(`
        UPDATE webrtc_sessions 
        SET 
          amount_charged = amount_charged + $1,
          total_minutes = $2,
          updated_at = NOW()
        WHERE id = $3
      `, [billingData.rate, minutesElapsed, sessionId]);

      // Record billing event
      await this.db.query(`
        INSERT INTO billing_events (session_id, event_type, amount, stripe_payment_intent_id, status, metadata)
        VALUES ($1, 'charge', $2, $3, 'completed', $4)
      `, [
        sessionId, 
        billingData.rate, 
        charge.id, 
        JSON.stringify({ minute: minutesElapsed, readerAmount: readerAmount / 100 })
      ]);

      console.log(`✅ Processed $${billingData.rate} charge for session ${sessionId}, minute ${minutesElapsed}`);

    } catch (error) {
      console.error(`❌ Billing failed for session ${sessionId}:`, error);
      
      if (error.code === 'card_declined' || error.code === 'insufficient_funds') {
        console.log(`💳 Payment failed for session ${sessionId}, ending session`);
        await this.endSession(sessionId, 'payment_failed');
      } else {
        throw error;
      }
    }
  }

  async processFixedDurationPayment(sessionId) {
    const billingData = this.activeBilling.get(sessionId);
    if (!billingData || !billingData.duration) {
      throw new Error('Invalid fixed duration billing data');
    }

    try {
      const totalAmount = billingData.rate * billingData.duration;
      
      console.log(`💳 Processing fixed duration payment: $${totalAmount} for ${billingData.duration} minutes`);

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(totalAmount * 100),
        currency: 'usd',
        customer: billingData.clientStripeCustomerId,
        confirm: true,
        metadata: {
          sessionId,
          readerId: billingData.readerId,
          type: 'fixed_duration_payment',
          duration: billingData.duration
        }
      });

      // Calculate and transfer to reader
      const readerAmount = Math.round(totalAmount * 0.85 * 100);
      
      if (billingData.readerStripeAccountId) {
        await stripe.transfers.create({
          amount: readerAmount,
          currency: 'usd',
          destination: billingData.readerStripeAccountId,
          metadata: {
            sessionId,
            type: 'fixed_duration_payment'
          }
        });
      }

      // Update billing data
      billingData.totalCharged = totalAmount;

      // Update database
      await this.db.query(`
        UPDATE webrtc_sessions 
        SET amount_charged = $1, updated_at = NOW()
        WHERE id = $2
      `, [totalAmount, sessionId]);

      await this.db.query(`
        INSERT INTO billing_events (session_id, event_type, amount, stripe_payment_intent_id, status)
        VALUES ($1, 'charge', $2, $3, 'completed')
      `, [sessionId, totalAmount, paymentIntent.id]);

      console.log(`✅ Fixed duration payment processed for session ${sessionId}`);

    } catch (error) {
      console.error('Error processing fixed duration payment:', error);
      throw error;
    }
  }

  async endSession(sessionId, reason = 'completed') {
    try {
      console.log(`🏁 Ending billing for session ${sessionId}: ${reason}`);

      // Stop billing interval
      this.stopBilling(sessionId);

      const billingData = this.activeBilling.get(sessionId);
      if (!billingData) {
        console.warn(`No billing data found for session ${sessionId}`);
        return { success: true, message: 'No active billing' };
      }

      const sessionDuration = (Date.now() - billingData.startTime) / 60000; // in minutes

      // Update session status
      await this.db.query(`
        UPDATE webrtc_sessions 
        SET 
          status = 'completed', 
          end_time = NOW(), 
          total_minutes = $1,
          updated_at = NOW()
        WHERE id = $2
      `, [sessionDuration, sessionId]);

      // Handle refunds for early completion
      if (billingData.billingType === 'fixed_duration' && reason === 'ended_early') {
        await this.processEarlyEndRefund(sessionId, billingData, sessionDuration);
      }

      // Clean up
      this.activeBilling.delete(sessionId);

      console.log(`✅ Session ${sessionId} billing ended. Duration: ${sessionDuration.toFixed(2)} minutes, Charged: $${billingData.totalCharged}`);

      return {
        success: true,
        totalMinutes: sessionDuration,
        totalCharged: billingData.totalCharged,
        reason
      };

    } catch (error) {
      console.error('Error ending session:', error);
      throw error;
    }
  }

  async processEarlyEndRefund(sessionId, billingData, actualMinutes) {
    try {
      if (billingData.duration && actualMinutes < billingData.duration) {
        const refundMinutes = billingData.duration - actualMinutes;
        const refundAmount = refundMinutes * billingData.rate;
        
        if (refundAmount > 0) {
          console.log(`💰 Processing refund: $${refundAmount} for ${refundMinutes} unused minutes`);

          const refund = await stripe.refunds.create({
            payment_intent: billingData.paymentIntentId,
            amount: Math.round(refundAmount * 100),
            metadata: {
              sessionId,
              type: 'early_end_refund',
              unusedMinutes: refundMinutes
            }
          });

          await this.db.query(`
            INSERT INTO billing_events (session_id, event_type, amount, stripe_payment_intent_id, status, metadata)
            VALUES ($1, 'refund', $2, $3, 'completed', $4)
          `, [
            sessionId, 
            refundAmount, 
            refund.id, 
            JSON.stringify({ unusedMinutes: refundMinutes, reason: 'early_end' })
          ]);

          console.log(`✅ Refund processed: $${refundAmount} for session ${sessionId}`);
        }
      }
    } catch (error) {
      console.error('Error processing early end refund:', error);
    }
  }

  stopBilling(sessionId) {
    const interval = this.billingIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      this.billingIntervals.delete(sessionId);
      console.log(`⏹️ Stopped billing for session ${sessionId}`);
    }
  }

  async processGift(giftData) {
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
      } = giftData;

      console.log(`🎁 Processing gift: ${giftType} ($${amount}) from ${senderId} to ${receiverId}`);

      // Charge sender
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100),
        currency: 'usd',
        customer: senderStripeCustomerId,
        confirm: true,
        metadata: {
          streamId,
          senderId,
          receiverId,
          giftType,
          type: 'stream_gift'
        }
      });

      // Calculate platform fee (10%) and streamer payment (90%)
      const platformFee = Math.round(amount * 0.10 * 100);
      const streamerAmount = Math.round(amount * 0.90 * 100);

      // Transfer to streamer
      if (receiverStripeAccountId) {
        await stripe.transfers.create({
          amount: streamerAmount,
          currency: 'usd',
          destination: receiverStripeAccountId,
          metadata: {
            streamId,
            senderId,
            giftType,
            type: 'gift_payment'
          }
        });
      }

      // Record gift in database
      await this.db.query(`
        INSERT INTO stream_gifts (stream_id, sender_id, receiver_id, gift_type, amount, message, stripe_payment_intent_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `, [streamId, senderId, receiverId, giftType, amount, message, paymentIntent.id]);

      // Update stream total
      await this.db.query(`
        UPDATE live_streams 
        SET total_gifts = total_gifts + $1, updated_at = NOW()
        WHERE id = $2
      `, [amount, streamId]);

      console.log(`✅ Gift processed: ${giftType} ($${amount}) - Streamer receives $${streamerAmount / 100}`);

      return {
        success: true,
        paymentIntentId: paymentIntent.id,
        streamerAmount: streamerAmount / 100,
        platformFee: platformFee / 100
      };

    } catch (error) {
      console.error('Error processing gift:', error);
      throw error;
    }
  }

  // Get billing session info
  getBillingInfo(sessionId) {
    return this.activeBilling.get(sessionId);
  }

  // Start cleanup job for stale sessions
  startCleanupJob() {
    // Run every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
      console.log('🧹 Running billing cleanup job...');
      
      try {
        // Find sessions that have been active for too long without billing
        const staleThreshold = Date.now() - (30 * 60 * 1000); // 30 minutes
        
        for (const [sessionId, billingData] of this.activeBilling.entries()) {
          if (billingData.lastBillingTime < staleThreshold) {
            console.log(`🚨 Found stale billing session: ${sessionId}`);
            await this.endSession(sessionId, 'cleanup_timeout');
          }
        }

        // Clean up database sessions that are stuck in 'active' status
        await this.db.query(`
          UPDATE webrtc_sessions 
          SET status = 'completed', end_time = NOW(), updated_at = NOW()
          WHERE status = 'active' 
          AND start_time < NOW() - INTERVAL '2 hours'
        `);

      } catch (error) {
        console.error('Error in billing cleanup job:', error);
      }
    });

    console.log('🧹 Billing cleanup job scheduled');
  }

  // Get billing statistics
  async getStats() {
    try {
      const stats = await this.db.query(`
        SELECT 
          COUNT(*) as total_sessions,
          SUM(amount_charged) as total_revenue,
          AVG(total_minutes) as avg_session_duration,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_sessions
        FROM webrtc_sessions
        WHERE created_at >= NOW() - INTERVAL '24 hours'
      `);

      return {
        activeBillingSessions: this.activeBilling.size,
        last24Hours: stats.rows[0]
      };
    } catch (error) {
      console.error('Error getting billing stats:', error);
      return null;
    }
  }
}

module.exports = BillingEngine;
