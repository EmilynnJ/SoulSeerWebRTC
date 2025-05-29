const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

// Create a new WebRTC session
router.post('/create', async (req, res) => {
  try {
    const {
      externalSessionId, // ID from main SoulSeer app
      clientId,
      readerId,
      sessionType,
      billingType,
      rate,
      duration,
      clientStripeCustomerId,
      readerStripeAccountId,
      metadata = {}
    } = req.body;

    const roomId = uuidv4();
    
    // Create session in database
    const result = await req.db.query(`
      INSERT INTO webrtc_sessions 
      (external_session_id, client_id, reader_id, session_type, billing_type, rate, duration_minutes, room_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [externalSessionId, clientId, readerId, sessionType, billingType, rate, duration, roomId, JSON.stringify(metadata)]);

    const session = result.rows[0];

    // Initialize billing if provided
    let billingResult = null;
    if (clientStripeCustomerId && readerStripeAccountId) {
      billingResult = await req.billingEngine.startSession(
        session.id,
        clientStripeCustomerId,
        readerStripeAccountId,
        rate
      );
    }

    res.json({
      success: true,
      session: {
        id: session.id,
        roomId: session.room_id,
        sessionType: session.session_type,
        billingType: session.billing_type,
        rate: session.rate,
        duration: session.duration_minutes,
        status: session.status,
        webrtcUrl: `${req.protocol}://${req.get('host')}/session/${session.room_id}`,
        wsUrl: `${req.protocol === 'https' ? 'wss' : 'ws'}://${req.get('host')}/ws`
      },
      billing: billingResult
    });

  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Join a session
router.post('/:sessionId/join', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { userId, role } = req.body;

    // Verify session exists and is active
    const sessionResult = await req.db.query(
      'SELECT * FROM webrtc_sessions WHERE id = $1 OR room_id = $1',
      [sessionId]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = sessionResult.rows[0];

    if (session.status !== 'pending' && session.status !== 'active') {
      return res.status(400).json({ error: 'Session is not available' });
    }

    // Add participant
    await req.db.query(`
      INSERT INTO session_participants (session_id, user_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (session_id, user_id) DO UPDATE SET joined_at = NOW()
    `, [session.id, userId, role]);

    // Get room info
    const roomInfo = req.signaling.getRoomInfo(session.room_id);

    res.json({
      success: true,
      session: {
        roomId: session.room_id,
        sessionType: session.session_type,
        status: session.status,
        participants: roomInfo ? roomInfo.participants : []
      },
      webrtcUrl: `${req.protocol}://${req.get('host')}/session/${session.room_id}`,
      wsUrl: `${req.protocol === 'https' ? 'wss' : 'ws'}://${req.get('host')}/ws`
    });

  } catch (error) {
    console.error('Error joining session:', error);
    res.status(500).json({ error: 'Failed to join session' });
  }
});

// End a session
router.post('/:sessionId/end', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { reason = 'completed' } = req.body;

    // Get session
    const sessionResult = await req.db.query(
      'SELECT * FROM webrtc_sessions WHERE id = $1 OR room_id = $1',
      [sessionId]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = sessionResult.rows[0];

    // End billing
    const billingResult = await req.billingEngine.endSession(session.id, reason);

    // End WebRTC room
    req.signaling.endSession(session.room_id);

    // Update participants
    await req.db.query(`
      UPDATE session_participants 
      SET left_at = NOW() 
      WHERE session_id = $1 AND left_at IS NULL
    `, [session.id]);

    res.json({
      success: true,
      session: {
        id: session.id,
        status: 'completed',
        totalMinutes: billingResult.totalMinutes,
        totalCharged: billingResult.totalCharged
      }
    });

  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// Get session status
router.get('/:sessionId/status', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const result = await req.db.query(`
      SELECT ws.*, 
             COUNT(sp.user_id) as participant_count,
             ARRAY_AGG(sp.user_id) as participants
      FROM webrtc_sessions ws
      LEFT JOIN session_participants sp ON ws.id = sp.session_id AND sp.left_at IS NULL
      WHERE ws.id = $1 OR ws.room_id = $1
      GROUP BY ws.id
    `, [sessionId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = result.rows[0];
    const roomInfo = req.signaling.getRoomInfo(session.room_id);

    res.json({
      success: true,
      session: {
        id: session.id,
        roomId: session.room_id,
        status: session.status,
        sessionType: session.session_type,
        billingType: session.billing_type,
        rate: session.rate,
        totalMinutes: session.total_minutes,
        amountCharged: session.amount_charged,
        startTime: session.start_time,
        endTime: session.end_time,
        participantCount: roomInfo ? roomInfo.participantCount : 0,
        participants: roomInfo ? roomInfo.participants : []
      }
    });

  } catch (error) {
    console.error('Error getting session status:', error);
    res.status(500).json({ error: 'Failed to get session status' });
  }
});

// Create live stream
router.post('/stream/create', async (req, res) => {
  try {
    const { readerId, title, description } = req.body;
    const roomId = uuidv4();

    const result = await req.db.query(`
      INSERT INTO live_streams (reader_id, title, description, room_id, is_active, started_at)
      VALUES ($1, $2, $3, $4, true, NOW())
      RETURNING *
    `, [readerId, title, description, roomId]);

    const stream = result.rows[0];

    res.json({
      success: true,
      stream: {
        id: stream.id,
        roomId: stream.room_id,
        title: stream.title,
        description: stream.description,
        isActive: stream.is_active,
        streamUrl: `${req.protocol}://${req.get('host')}/session/${stream.room_id}?type=stream`,
        wsUrl: `${req.protocol === 'https' ? 'wss' : 'ws'}://${req.get('host')}/ws`
      }
    });

  } catch (error) {
    console.error('Error creating stream:', error);
    res.status(500).json({ error: 'Failed to create stream' });
  }
});

// Send gift to stream
router.post('/stream/:streamId/gift', async (req, res) => {
  try {
    const { streamId } = req.params;
    const { 
      senderId, 
      giftType, 
      amount, 
      message,
      senderStripeCustomerId,
      receiverStripeAccountId 
    } = req.body;

    // Process gift payment
    const billingResult = await req.billingEngine.processGift(
      streamId,
      amount,
      senderStripeCustomerId,
      receiverStripeAccountId
    );

    // Record gift
    await req.db.query(`
      INSERT INTO stream_gifts (stream_id, sender_id, gift_type, amount, message, stripe_payment_intent_id)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [streamId, senderId, giftType, amount, message, billingResult.paymentIntentId]);

    // Update stream total
    await req.db.query(`
      UPDATE live_streams 
      SET total_gifts = total_gifts + $1
      WHERE id = $2
    `, [amount, streamId]);

    // Get stream room ID
    const streamResult = await req.db.query(
      'SELECT room_id FROM live_streams WHERE id = $1',
      [streamId]
    );

    if (streamResult.rows.length > 0) {
      const roomId = streamResult.rows[0].room_id;
      
      // Broadcast gift animation
      req.signaling.broadcastToRoom(roomId, {
        type: 'gift-animation',
        payload: {
          giftType,
          amount,
          message,
          senderId,
          timestamp: new Date().toISOString()
        }
      });
    }

    res.json({
      success: true,
      gift: {
        giftType,
        amount,
        streamerAmount: billingResult.streamerAmount
      }
    });

  } catch (error) {
    console.error('Error sending gift:', error);
    res.status(500).json({ error: 'Failed to send gift' });
  }
});

module.exports = router;
