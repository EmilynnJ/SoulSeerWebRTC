require('dotenv').config();

class NotificationService {
  constructor() {
    this.webhookUrl = process.env.MAIN_APP_URL ? 
      `${process.env.MAIN_APP_URL}/api/webhooks/webrtc` : null;
    this.appwriteEndpoint = process.env.APPWRITE_ENDPOINT_URL;
    this.appwriteProjectId = process.env.APPWRITE_PROJECT_ID;
    this.appwriteApiSecret = process.env.APPWRITE_API_SECRET;
  }

  // Send notification to main SoulSeer app
  async notifyMainApp(event, data) {
    if (!this.webhookUrl) {
      console.log('⚠️ Main app webhook URL not configured');
      return false;
    }

    try {
      console.log(`📨 Sending notification to main app: ${event}`);

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.appwriteApiSecret}`,
          'X-Webhook-Source': 'webrtc-service'
        },
        body: JSON.stringify({
          event,
          data,
          timestamp: new Date().toISOString(),
          source: 'webrtc-service'
        })
      });

      if (response.ok) {
        console.log(`✅ Main app notified: ${event}`);
        return true;
      } else {
        console.error(`❌ Main app notification failed: ${response.status} ${response.statusText}`);
        return false;
      }

    } catch (error) {
      console.error('❌ Error notifying main app:', error);
      return false;
    }
  }

  // Send push notification via Appwrite (if configured)
  async sendPushNotification(userId, title, body, data = {}) {
    if (!this.appwriteEndpoint || !this.appwriteProjectId) {
      console.log('⚠️ Appwrite not configured for push notifications');
      return false;
    }

    try {
      const response = await fetch(`${this.appwriteEndpoint}/messaging/messages/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Appwrite-Project': this.appwriteProjectId,
          'X-Appwrite-Key': this.appwriteApiSecret
        },
        body: JSON.stringify({
          messageId: `webrtc_${Date.now()}`,
          title,
          body,
          data,
          users: [userId]
        })
      });

      if (response.ok) {
        console.log(`📱 Push notification sent to ${userId}: ${title}`);
        return true;
      } else {
        console.error(`❌ Push notification failed: ${response.status}`);
        return false;
      }

    } catch (error) {
      console.error('❌ Error sending push notification:', error);
      return false;
    }
  }

  // Email notification (placeholder for future implementation)
  async sendEmailNotification(userEmail, subject, content) {
    // You can integrate with your email service here
    console.log(`📧 Email notification placeholder: ${userEmail} - ${subject}`);
    return true;
  }

  // SMS notification (placeholder for future implementation)
  async sendSMSNotification(phoneNumber, message) {
    // You can integrate with SMS service here
    console.log(`📱 SMS notification placeholder: ${phoneNumber} - ${message}`);
    return true;
  }
}

module.exports = NotificationService;
