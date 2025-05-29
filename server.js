const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Import auth middleware
const { verifyAppwriteAuth, devAuth } = require('./middleware/appwrite-auth');

const app = express();
const server = http.createServer(app);

// Configure CORS
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:5000'
  ],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Socket.IO setup
const io = socketIo(server, {
  cors: corsOptions
});

// Make io available to routes
app.set('socketio', io);

// Health check endpoint (no auth required)
app.use('/api/health', require('./routes/health'));

// Choose auth middleware based on environment
const authMiddleware = process.env.NODE_ENV === 'development' && process.env.SKIP_AUTH === 'true' 
  ? devAuth 
  : verifyAppwriteAuth;

// Apply auth middleware to protected routes
app.use('/api/sessions', authMiddleware, require('./routes/sessions'));
app.use('/api/streams', authMiddleware, require('./routes/streams'));
app.use('/api/billing', authMiddleware, require('./routes/billing'));

// Public routes (no auth required)
app.use('/api/webhooks', require('./routes/webhooks'));

// Session pages (public for now, auth handled in frontend)
app.get('/session/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'session.html'));
});

app.get('/stream/:streamId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stream.html'));
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', (roomId, userId) => {
    socket.join(roomId);
    socket.to(roomId).emit('user-connected', userId);
    console.log(`User ${userId} joined room ${roomId}`);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || 3002;

server.listen(PORT, () => {
  console.log(`🎥 WebRTC Service running on port ${PORT}`);
  console.log(`🔐 Authentication: ${process.env.NODE_ENV === 'development' && process.env.SKIP_AUTH === 'true' ? 'Development (Skipped)' : 'Appwrite'}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});
