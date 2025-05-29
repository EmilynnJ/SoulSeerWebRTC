require('dotenv').config();

// Add ICE server configuration using your env variables
const ICE_SERVERS = JSON.parse(process.env.WEBRTC_ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]');

// Add TURN server configuration
if (process.env.TURN_SERVERS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    ICE_SERVERS.push({
        urls: `turn:${process.env.TURN_SERVERS}`,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL
    });
}

console.log('🔗 ICE Servers configured:', ICE_SERVERS);
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

class WebRTCSignaling {
  constructor() {
    this.rooms = new Map();
    this.connections = new Map();
    this.userConnections = new Map();
    this.heartbeatInterval = null;
  }

  initialize(server) {
    this.wss = new WebSocket.Server({ 
      server,
      path: '/ws'
    });
    
    console.log('🔗 WebRTC Signaling initialized');
    
    this.wss.on('connection', (ws, req) => {
      const connectionId = uuidv4();
      this.connections.set(connectionId, ws);
      
      ws.connectionId = connectionId;
      ws.isAlive = true;
      ws.lastPing = Date.now();
      
      console.log(`🔌 New connection: ${connectionId}`);
      
      ws.on('pong', () => {
        ws.isAlive = true;
        ws.lastPing = Date.now();
      });
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          this.handleMessage(ws, message);
        } catch (error) {
          console.error('Invalid WebSocket message:', error);
          ws.send(JSON.stringify({
            type: 'error',
            payload: { message: 'Invalid message format' }
          }));
        }
      });
      
      ws.on('close', () => {
        console.log(`🔌 Connection closed: ${connectionId}`);
        this.handleDisconnection(ws);
      });

      ws.on('error', (error) => {
        console.error(`WebSocket error for ${connectionId}:`, error);
        this.handleDisconnection(ws);
      });
    });

    // Heartbeat mechanism
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
          console.log(`💔 Terminating dead connection: ${ws.connectionId}`);
          this.handleDisconnection(ws);
          return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    console.log('💓 Heartbeat mechanism started');
  }

  handleMessage(ws, message) {
    const { type, roomId, payload, userId } = message;

    // Associate user with connection
    if (userId && !ws.userId) {
      ws.userId = userId;
      this.userConnections.set(userId, ws);
      console.log(`👤 User ${userId} connected via ${ws.connectionId}`);
    }

    switch (type) {
      case 'join-room':
        this.joinRoom(ws, roomId, payload);
        break;
      case 'leave-room':
        this.leaveRoom(ws, roomId);
        break;
      case 'webrtc-offer':
      case 'webrtc-answer':
      case 'ice-candidate':
        this.forwardMessage(ws, roomId, { type, payload });
        break;
      case 'chat-message':
        this.broadcastToRoom(roomId, { 
          type: 'chat-message', 
          payload: {
            ...payload,
            timestamp: new Date().toISOString(),
            id: uuidv4()
          }
        });
        break;
      case 'stream-join':
        this.joinStream(ws, roomId, payload);
        break;
      case 'gift-animation':
        this.broadcastToRoom(roomId, { type: 'gift-animation', payload });
        break;
      case 'session-update':
        this.broadcastToRoom(roomId, { type: 'session-update', payload });
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
      default:
        console.log(`❓ Unknown message type: ${type}`);
        ws.send(JSON.stringify({
          type: 'error',
          payload: { message: `Unknown message type: ${type}` }
        }));
    }
  }

  joinRoom(ws, roomId, payload) {
    if (!roomId) {
      ws.send(JSON.stringify({
        type: 'error',
        payload: { message: 'Room ID is required' }
      }));
      return;
    }

    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        participants: new Map(),
        type: payload.roomType || 'reading',
        created: Date.now(),
        metadata: payload.metadata || {}
      });
      console.log(`🏠 Created room: ${roomId} (${payload.roomType || 'reading'})`);
    }

    const room = this.rooms.get(roomId);
    room.participants.set(ws.connectionId, {
      ws,
      userId: payload.userId,
      role: payload.role,
      joined: Date.now(),
      metadata: payload.metadata || {}
    });

    ws.roomId = roomId;
    ws.role = payload.role;

    console.log(`🚪 ${payload.userId} (${payload.role}) joined room ${roomId}`);

    // Notify others in the room
    this.broadcastToRoom(roomId, {
      type: 'participant-joined',
      payload: {
        userId: payload.userId,
        role: payload.role,
        participantCount: room.participants.size,
        timestamp: new Date().toISOString()
      }
    }, ws.connectionId);

    // Send current participants to new joiner
    const participants = Array.from(room.participants.values()).map(p => ({
      userId: p.userId,
      role: p.role,
      joined: p.joined
    }));

    ws.send(JSON.stringify({
      type: 'room-joined',
      payload: { 
        participants, 
        roomId, 
        roomType: room.type,
        participantCount: room.participants.size
      }
    }));
  }

  joinStream(ws, streamId, payload) {
    this.joinRoom(ws, streamId, { 
      ...payload, 
      roomType: 'stream',
      role: payload.role || 'viewer'
    });
    
    const room = this.rooms.get(streamId);
    if (room) {
      // Count only viewers (exclude the streamer)
      const viewerCount = Array.from(room.participants.values())
        .filter(p => p.role === 'viewer').length;
        
      this.broadcastToRoom(streamId, {
        type: 'viewer-count-update',
        payload: { count: viewerCount }
      });
    }
  }

  leaveRoom(ws, roomId) {
    if (!roomId || !this.rooms.has(roomId)) return;

    const room = this.rooms.get(roomId);
    const participant = room.participants.get(ws.connectionId);
    
    if (participant) {
      room.participants.delete(ws.connectionId);
      console.log(`🚪 ${participant.userId} left room ${roomId}`);
      
      this.broadcastToRoom(roomId, {
        type: 'participant-left',
        payload: {
          userId: participant.userId,
          role: participant.role,
          participantCount: room.participants.size,
          timestamp: new Date().toISOString()
        }
      });

      // Clean up empty rooms
      if (room.participants.size === 0) {
        this.rooms.delete(roomId);
        console.log(`🗑️ Deleted empty room: ${roomId}`);
      } else if (room.type === 'stream') {
        // Update viewer count for streams
        const viewerCount = Array.from(room.participants.values())
          .filter(p => p.role === 'viewer').length;
          
        this.broadcastToRoom(roomId, {
          type: 'viewer-count-update',
          payload: { count: viewerCount }
        });
      }
    }

    delete ws.roomId;
    delete ws.role;
  }

  forwardMessage(ws, roomId, message) {
    const room = this.rooms.get(roomId);
    if (!room) {
      ws.send(JSON.stringify({
        type: 'error',
        payload: { message: 'Room not found' }
      }));
      return;
    }

    let forwardedCount = 0;
    room.participants.forEach((participant, connectionId) => {
      if (connectionId !== ws.connectionId && participant.ws.readyState === WebSocket.OPEN) {
        participant.ws.send(JSON.stringify(message));
        forwardedCount++;
      }
    });

    console.log(`📡 Forwarded ${message.type} to ${forwardedCount} participants in ${roomId}`);
  }

  broadcastToRoom(roomId, message, excludeId = null) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    let broadcastCount = 0;
    room.participants.forEach((participant, connectionId) => {
      if (connectionId !== excludeId && participant.ws.readyState === WebSocket.OPEN) {
        participant.ws.send(JSON.stringify(message));
        broadcastCount++;
      }
    });

    console.log(`📢 Broadcast ${message.type} to ${broadcastCount} participants in ${roomId}`);
  }

  handleDisconnection(ws) {
    if (ws.roomId) {
      this.leaveRoom(ws, ws.roomId);
    }
    
    if (ws.userId) {
      this.userConnections.delete(ws.userId);
      console.log(`👤 User ${ws.userId} disconnected`);
    }
    
    this.connections.delete(ws.connectionId);
  }

  // External API methods
  notifyUser(userId, notification) {
    const ws = this.userConnections.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'notification',
        payload: {
          ...notification,
          timestamp: new Date().toISOString()
        }
      }));
      return true;
    }
    return false;
  }

  getRoomInfo(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    
    const participants = Array.from(room.participants.values()).map(p => ({
      userId: p.userId,
      role: p.role,
      joined: p.joined
    }));

    return {
      participantCount: room.participants.size,
      participants,
      type: room.type,
      created: room.created,
      metadata: room.metadata
    };
  }

  endSession(roomId, reason = 'ended_by_system') {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    console.log(`🛑 Ending session ${roomId}: ${reason}`);

    this.broadcastToRoom(roomId, {
      type: 'session-ended',
      payload: { 
        reason,
        timestamp: new Date().toISOString()
      }
    });

    // Close all connections in the room
    room.participants.forEach((participant) => {
      if (participant.ws.readyState === WebSocket.OPEN) {
        participant.ws.close(1000, `Session ended: ${reason}`);
      }
    });

    this.rooms.delete(roomId);
    return true;
  }

  getStats() {
    return {
      totalConnections: this.connections.size,
      totalRooms: this.rooms.size,
      totalUsers: this.userConnections.size,
      rooms: Array.from(this.rooms.entries()).map(([id, room]) => ({
        id,
        type: room.type,
        participantCount: room.participants.size,
        created: room.created
      }))
    };
  }

  // Cleanup method
  destroy() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    if (this.wss) {
      this.wss.close();
    }
    
    console.log('🧹 WebRTC Signaling service destroyed');
  }
}

module.exports = WebRTCSignaling;
