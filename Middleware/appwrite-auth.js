const { Client, Account } = require('node-appwrite');

const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT_URL)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_SECRET);

const account = new Account(client);

// Middleware to verify Appwrite session
const verifyAppwriteAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const appwriteUserId = req.headers['x-appwrite-user-id'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No authorization token provided' });
    }

    const sessionId = authHeader.replace('Bearer ', '');

    if (!sessionId || !appwriteUserId) {
      return res.status(401).json({ error: 'Invalid authorization' });
    }

    // Verify the session with Appwrite
    try {
      const session = await account.getSession(sessionId);
      
      if (session.userId !== appwriteUserId) {
        return res.status(401).json({ error: 'Session user mismatch' });
      }

      // Add user info to request
      req.user = {
        id: session.userId,
        sessionId: sessionId,
        email: session.providerEmail || '',
        name: session.providerName || ''
      };

      next();

    } catch (appwriteError) {
      console.error('Appwrite session verification failed:', appwriteError);
      return res.status(401).json({ error: 'Invalid session' });
    }

  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

module.exports = { verifyAppwriteAuth };
