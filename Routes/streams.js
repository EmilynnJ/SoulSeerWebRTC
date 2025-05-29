const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

// Create live stream
router.post('/create', async (req, res) => {
  try {
    const { 
      readerId, 
      title, 
      description, 
      readerName,
      category = 'general',
      isPrivate = false
    } = req.body;

    if (!readerId) {
      return res.status(400).json({ error: 'Reader ID is required' });
    }

    const roomId = uuidv4();

    console.log(`📡 Creating live stream for reader ${readerId}: ${title}`);

    const result = await req.db.query(`
      INSERT INTO live_streams (
        reader_id, title, description, room_id, 
        is_active, started_at, category, is_private, metadata
      )
      VALUES ($1, $2, $3, $4, true, NOW(), $5, $6, $7)
      RETURNING *
    `, [
      readerId, 
      title, 
      description, 
      roomId, 
      category, 
      isPrivate,
      JSON.stringify({ readerName, createdBy: 'webrtc_service' })
    ]);

    const stream = result.rows[0];

    res.json({
      success: true,
      stream: {
        id: stream.id,
        roomId: stream.room_id,
        title: stream.title,
        description: stream.description,
        category: stream.category,
        isActive: stream.is_active,
        isPrivate: stream.is_private,
        startedAt: stream.started_at,
        viewerCount: 0,
        totalGifts: 0,
        // URLs for integration
        streamUrl: `${req.protocol}://${req.get('host')}/stream/${stream.room_id}`,
        readerUrl: `${req.protocol}://${req.get('host')}/stream/${stream.room_id}?userId=${readerId}&role=streamer`,
        wsUrl: `${req.protocol === 'https' ? 'wss' : 'ws'}://${req.get('host')}/ws`
      }
    });

  } catch (error) {
    console.error('Error creating stream:', error);
    res.status(500).json({ 
      error: 'Failed to create stream',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Join a stream as viewer
router.post('/:streamId/join', async (req, res) => {
  try {
    const { streamId } = req.params;
    const { userId, userName = 'Anonymous' } = req.body;

    // Get stream info
    const streamResult = await req.db.query(
      'SELECT * FROM live_streams WHERE id = $1 OR room_id = $1',
      [streamId]
    );

    if (streamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    const stream = streamResult.rows[0];

    if (!stream.is_active) {
      return res.status(400).json({ error: 'Stream is not active' });
    }

    // Check if stream is private and user has access
    if (stream.is_private) {
      // Add your private stream access logic here
      // For now, allow all users
    }

    // Get current room info
    const roomInfo = req.signaling.getRoomInfo(stream.room_id);
    const viewerCount = roomInfo ? 
      roomInfo.participants.filter(p => p.role === 'viewer').length : 0;

    // Update viewer count in database
    await req.db.query(`
      UPDATE live_streams 
      SET viewer_count = $1, updated_at = NOW()
      WHERE id = $2
    `, [viewerCount + 1, stream.id]);

    res.json({
      success: true,
      stream: {
        id: stream.id,
        roomId: stream.room_id,
        title: stream.title,
        description: stream.description,
        category: stream.category,
        readerId: stream.reader_id,
        viewerCount: viewerCount + 1,
        totalGifts: parseFloat(stream.total_gifts),
        startedAt: stream.started_at
      },
      urls: {
        streamUrl: `${req.protocol}://${req.get('host')}/stream/${stream.room_id}?userId=${userId}&role=viewer&name=${userName}`,
        wsUrl: `${req.protocol === 'https' ? 'wss' : 'ws'}://${req.get('host')}/ws`
      }
    });

  } catch (error) {
    console.error('Error joining stream:', error);
    res.status(500).json({ 
      error: 'Failed to join stream',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Send gift to stream
router.post('/:streamId/gift', async (req, res) => {
  try {
    const { streamId } = req.params;
    const { 
      senderId, 
      senderName = 'Anonymous',
      giftType, 
      amount, 
      message = '',
      senderStripeCustomerId,
      receiverStripeAccountId 
    } = req.body;

    if (!senderId || !giftType || !amount) {
      return res.status(400).json({ 
        error: 'Missing required fields: senderId, giftType, amount' 
      });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    // Get stream info
    const streamResult = await req.db.query(
      'SELECT * FROM live_streams WHERE id = $1 OR room_id = $1',
      [streamId]
    );

    if (streamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    const stream = streamResult.rows[0];

    if (!stream.is_active) {
      return res.status(400).json({ error: 'Stream is not active' });
    }

    console.log(`🎁 Processing gift in stream ${streamId}: ${giftType} ($${amount})`);

    // Process gift payment if Stripe info provided
    let billingResult = null;
    if (senderStripeCustomerId && receiverStripeAccountId) {
      try {
        billingResult = await req.billingEngine.processGift({
          streamId: stream.id,
          senderId,
          receiverId: stream.reader_id,
          giftType,
          amount: parseFloat(amount),
          senderStripeCustomerId,
          receiverStripeAccountId,
          message
        });
      } catch (billingError) {
        console.error('Gift payment failed:', billingError);
        return res.status(400).json({ 
          error: 'Payment failed',
          details: billingError.message 
        });
      }
    } else {
      // Record gift without payment processing
      await req.db.query(`
        INSERT INTO stream_gifts (
          stream_id, sender_id, receiver_id, gift_type, 
          amount, message, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [stream.id, senderId, stream.reader_id, giftType, amount, message]);

      // Update stream total
      await req.db.query(`
        UPDATE live_streams 
        SET total_gifts = total_gifts + $1, updated_at = NOW()
        WHERE id = $2
      `, [amount, stream.id]);
    }

    // Broadcast gift animation to all viewers
    req.signaling.broadcastToRoom(stream.room_id, {
      type: 'gift-animation',
      payload: {
        giftId: uuidv4(),
        giftType,
        amount: parseFloat(amount),
        message,
        senderId,
        senderName,
        receiverId: stream.reader_id,
        timestamp: new Date().toISOString(),
        streamId: stream.id
      }
    });

    // Notify streamer about the gift
    req.signaling.notifyUser(stream.reader_id, {
      type: 'gift_received',
      streamId: stream.id,
      giftType,
      amount: parseFloat(amount),
      senderId,
      senderName,
      message
    });

    res.json({
      success: true,
      gift: {
        giftType,
        amount: parseFloat(amount),
        message,
        senderId,
        senderName,
        streamId: stream.id,
        timestamp: new Date().toISOString()
      },
      billing: billingResult,
      stream: {
        newTotal: billingResult ? 
          parseFloat(stream.total_gifts) + billingResult.streamerAmount : 
          parseFloat(stream.total_gifts) + parseFloat(amount)
      }
    });

  } catch (error) {
    console.error('Error sending gift:', error);
    res.status(500).json({ 
      error: 'Failed to send gift',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// End a stream
router.post('/:streamId/end', async (req, res) => {
  try {
    const { streamId } = req.params;
    const { readerId } = req.body;

    // Get and verify stream
    const streamResult = await req.db.query(
      'SELECT * FROM live_streams WHERE (id = $1 OR room_id = $1) AND reader_id = $2 AND is_active = true',
      [streamId, readerId]
    );

    if (streamResult.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Active stream not found or unauthorized' 
      });
    }

    const stream = streamResult.rows[0];

    console.log(`🛑 Ending stream ${stream.id} by reader ${readerId}`);

    // Update stream status
    await req.db.query(`
      UPDATE live_streams 
      SET is_active = false, ended_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [stream.id]);

    // Get final stats
    const statsResult = await req.db.query(`
      SELECT 
        COUNT(*) as total_gifts,
        SUM(amount) as total_amount,
        MAX(created_at) as last_gift
      FROM stream_gifts 
      WHERE stream_id = $1
    `, [stream.id]);

    const stats = statsResult.rows[0];

    // End WebRTC room
    const roomEnded = req.signaling.endSession(stream.room_id, 'stream_ended');

    res.json({
      success: true,
      stream: {
        id: stream.id,
        isActive: false,
        endedAt: new Date().toISOString(),
        duration: Date.now() - new Date(stream.started_at).getTime(),
        stats: {
          totalGifts: parseInt(stats.total_gifts) || 0,
          totalAmount: parseFloat(stats.total_amount) || 0,
          lastGift: stats.last_gift
        }
      },
      webrtc: {
        roomEnded
      }
    });

  } catch (error) {
    console.error('Error ending stream:', error);
    res.status(500).json({ 
      error: 'Failed to end stream',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get stream status
router.get('/:streamId/status', async (req, res) => {
  try {
    const { streamId } = req.params;

    const result = await req.db.query(`
      SELECT 
        ls.*,
        COUNT(sg.id) as gift_count,
        COALESCE(SUM(sg.amount), 0) as total_gifts_amount
      FROM live_streams ls
      LEFT JOIN stream_gifts sg ON ls.id = sg.stream_id
      WHERE ls.id = $1 OR ls.room_id = $1
      GROUP BY ls.id
    `, [streamId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    const stream = result.rows[0];
    const roomInfo = req.signaling.getRoomInfo(stream.room_id);

    // Current viewer count from WebRTC room
    const currentViewers = roomInfo ? 
      roomInfo.participants.filter(p => p.role === 'viewer').length : 0;

    res.json({
      success: true,
      stream: {
        id: stream.id,
        roomId: stream.room_id,
        title: stream.title,
        description: stream.description,
        category: stream.category,
        readerId: stream.reader_id,
        isActive: stream.is_active,
        isPrivate: stream.is_private,
        startedAt: stream.started_at,
        endedAt: stream.ended_at,
        viewerCount: currentViewers,
        totalGifts: parseFloat(stream.total_gifts_amount),
        giftCount: parseInt(stream.gift_count),
        duration: stream.ended_at ? 
          new Date(stream.ended_at) - new Date(stream.started_at) :
          Date.now() - new Date(stream.started_at)
      },
      participants: roomInfo ? {
        total: roomInfo.participantCount,
        viewers: roomInfo.participants.filter(p => p.role === 'viewer'),
        streamer: roomInfo.participants.find(p => p.role === 'streamer')
      } : {
        total: 0,
        viewers: [],
        streamer: null
      }
    });

  } catch (error) {
    console.error('Error getting stream status:', error);
    res.status(500).json({ 
      error: 'Failed to get stream status',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get active streams (public endpoint)
router.get('/active', async (req, res) => {
  try {
    const { category, limit = 20, offset = 0 } = req.query;

    let query = `
      SELECT 
        ls.*,
        COUNT(sg.id) as gift_count,
        COALESCE(SUM(sg.amount), 0) as total_gifts_amount
      FROM live_streams ls
      LEFT JOIN stream_gifts sg ON ls.id = sg.stream_id
      WHERE ls.is_active = true AND ls.is_private = false
    `;
    const params = [];

    if (category) {
      query += ' AND ls.category = $' + (params.length + 1);
      params.push(category);
    }

    query += `
      GROUP BY ls.id
      ORDER BY ls.started_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    params.push(parseInt(limit), parseInt(offset));

    const result = await req.db.query(query, params);

    const streams = result.rows.map(stream => {
      const roomInfo = req.signaling.getRoomInfo(stream.room_id);
      const currentViewers = roomInfo ? 
        roomInfo.participants.filter(p => p.role === 'viewer').length : 0;

      return {
        id: stream.id,
        roomId: stream.room_id,
        title: stream.title,
        description: stream.description,
        category: stream.category,
        readerId: stream.reader_id,
        startedAt: stream.started_at,
        viewerCount: currentViewers,
        totalGifts: parseFloat(stream.total_gifts_amount),
        giftCount: parseInt(stream.gift_count),
        duration: Date.now() - new Date(stream.started_at).getTime()
      };
    });

    res.json({
      success: true,
      streams,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        count: streams.length
      }
    });

  } catch (error) {
    console.error('Error getting active streams:', error);
    res.status(500).json({ 
      error: 'Failed to get active streams',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get stream gifts/chat history
router.get('/:streamId/gifts', async (req, res) => {
  try {
    const { streamId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const result = await req.db.query(`
      SELECT 
        id, sender_id, gift_type, amount, message, created_at
      FROM stream_gifts
      WHERE stream_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [streamId, parseInt(limit), parseInt(offset)]);

    res.json({
      success: true,
      gifts: result.rows,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        count: result.rows.length
      }
    });

  } catch (error) {
    console.error('Error getting stream gifts:', error);
    res.status(500).json({ 
      error: 'Failed to get stream gifts',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;
