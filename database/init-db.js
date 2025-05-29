require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initializeDatabase() {
  try {
    console.log('🗄️ Initializing WebRTC database...');

    // Create WebRTC sessions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webrtc_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        external_session_id VARCHAR(255),
        client_id VARCHAR(255) NOT NULL,
        reader_id VARCHAR(255) NOT NULL,
        session_type VARCHAR(20) NOT NULL CHECK (session_type IN ('chat', 'phone', 'video')),
        billing_type VARCHAR(20) NOT NULL DEFAULT 'per_minute' CHECK (billing_type IN ('per_minute', 'fixed_duration')),
        rate DECIMAL(5,2) NOT NULL,
        duration_minutes INTEGER,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'cancelled')),
        room_id VARCHAR(255) UNIQUE NOT NULL,
        start_time TIMESTAMP,
        end_time TIMESTAMP,
        total_minutes DECIMAL(8,2) DEFAULT 0.00,
        amount_charged DECIMAL(10,2) DEFAULT 0.00,
        stripe_payment_intent_id VARCHAR(255),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create session participants table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_participants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES webrtc_sessions(id) ON DELETE CASCADE,
        user_id VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL CHECK (role IN ('client', 'reader')),
        joined_at TIMESTAMP DEFAULT NOW(),
        left_at TIMESTAMP,
        metadata JSONB DEFAULT '{}',
        UNIQUE(session_id, user_id)
      )
    `);

    // Create reader rates table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reader_rates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reader_id VARCHAR(255) UNIQUE NOT NULL,
        chat_rate DECIMAL(5,2) DEFAULT 0.00,
        phone_rate DECIMAL(5,2) DEFAULT 0.00,
        video_rate DECIMAL(5,2) DEFAULT 0.00,
        is_available BOOLEAN DEFAULT true,
        stripe_account_id VARCHAR(255),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create live streams table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS live_streams (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reader_id VARCHAR(255) NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        room_id VARCHAR(255) UNIQUE NOT NULL,
        category VARCHAR(50) DEFAULT 'general',
        is_active BOOLEAN DEFAULT true,
        is_private BOOLEAN DEFAULT false,
        viewer_count INTEGER DEFAULT 0,
        total_gifts DECIMAL(10,2) DEFAULT 0.00,
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create stream gifts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stream_gifts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
        sender_id VARCHAR(255) NOT NULL,
        receiver_id VARCHAR(255) NOT NULL,
        gift_type VARCHAR(50) NOT NULL,
        amount DECIMAL(5,2) NOT NULL,
        message TEXT,
        stripe_payment_intent_id VARCHAR(255),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create billing events table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS billing_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID REFERENCES webrtc_sessions(id) ON DELETE CASCADE,
        stream_id UUID REFERENCES live_streams(id) ON DELETE CASCADE,
        event_type VARCHAR(30) NOT NULL CHECK (event_type IN ('charge', 'refund', 'transfer_created', 'payment_succeeded', 'payment_failed')),
        amount DECIMAL(10,2) NOT NULL,
        stripe_payment_intent_id VARCHAR(255),
        status VARCHAR(20) DEFAULT
