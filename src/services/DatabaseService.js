// src/services/DatabaseService.js
import SQLite from 'react-native-sqlite-storage';

// Remove SQLite debug logs in production
SQLite.DEBUG(false);
SQLite.enablePromise(true);

class DatabaseService {
  constructor() {
    this.db = null;
    this.isInitialized = false;
    this.initPromise = null;
  }

  async initialize() {
    if (this.isInitialized) return;
    
    try {
      console.log('📱 Initializing SQLite database...');
      
      // Open database
      this.db = await SQLite.openDatabase({
        name: 'PeerReachDB.db',
        location: 'default'
      },
      () => {
        console.log('✅ Database opened successfully');
      },
      (error) => {
        console.error('❌ Database open error:', error);
        throw error;
      });
      
      // Create tables
      await this.createTables();
      
      this.isInitialized = true;
      console.log('✅ Database initialized successfully');
      
    } catch (error) {
      console.error('❌ Database initialization failed:', error);
      throw error;
    }
  }

  async ensureInitialized() {
    if (this.isInitialized) return;
    if (!this.initPromise) {
      this.initPromise = this.initialize().finally(() => {
        this.initPromise = null;
      });
    }
    await this.initPromise;
  }

  async testDatabase() {
    try {
      await this.ensureInitialized();
      // Simple test query
      const [results] = await this.db.executeSql('SELECT 1+1 as test');
      const testResult = results.rows.item(0).test;
      console.log('✅ Database test passed:', testResult === 2);
    } catch (error) {
      console.error('❌ Database test failed:', error);
      throw error;
    }
  }

  async createTables() {
    try {
      // 1. Devices table
      await this.db.executeSql(`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          last_seen INTEGER,
          connection_status TEXT DEFAULT 'offline',
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        );
      `);

      // 2. Messages table
      await this.db.executeSql(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          sender_name TEXT NOT NULL,
          receiver_id TEXT,
          message_type TEXT NOT NULL, -- 'direct', 'broadcast', 'system'
          is_mine INTEGER DEFAULT 0, -- 0 = false, 1 = true
          is_broadcast INTEGER DEFAULT 0,
          timestamp INTEGER NOT NULL,
          read_status INTEGER DEFAULT 0, -- 0 = unread, 1 = read
          delivery_status TEXT DEFAULT 'sent', -- 'sending', 'sent', 'delivered', 'failed'
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          
          FOREIGN KEY (sender_id) REFERENCES devices(id),
          FOREIGN KEY (receiver_id) REFERENCES devices(id)
        );
      `);

      // 3. Conversations table (for quick access)
      await this.db.executeSql(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          device_id TEXT,
          device_name TEXT NOT NULL,
          last_message TEXT,
          last_message_time INTEGER,
          unread_count INTEGER DEFAULT 0,
          message_type TEXT, -- 'direct', 'broadcast'
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER DEFAULT (strftime('%s', 'now')),
          
          FOREIGN KEY (device_id) REFERENCES devices(id)
        );
      `);
      // 4. Create indexes for performance
      await this.db.executeSql('CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);');
      await this.db.executeSql('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);');
      await this.db.executeSql('CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);');
      await this.db.executeSql('CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(message_type);');
      await this.db.executeSql('CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);');

      console.log('✅ Database tables created');

    } catch (error) {
      console.error('❌ Error creating tables:', error);
      throw error;
    }
  }

    async executeQuery(query, params = []) {
      try {
      await this.ensureInitialized();
        if (!this.db) {
          throw new Error('Database not initialized');
        }
        
        const [results] = await this.db.executeSql(query, params);
        return results;
      } catch (error) {
        console.error('❌ Query execution error:', error);
        console.error('Query:', query);
        console.error('Params:', params);
        throw error;
      }
    }
  // ============ DEVICE OPERATIONS ============

  async saveDevice(device) {
    try {
      await this.ensureInitialized();
      const { id, name, last_seen = Date.now(), connection_status = 'online' } = device;
      
      await this.db.executeSql(
        `INSERT OR REPLACE INTO devices (id, name, last_seen, connection_status, updated_at) 
         VALUES (?, ?, ?, ?, strftime('%s', 'now'));`,
        [id, name, last_seen, connection_status]
      );
      
      return device;
    } catch (error) {
      console.error('❌ Error saving device:', error);
      throw error;
    }
  }

  async getDevice(deviceId) {
    try {
      await this.ensureInitialized();
      const [results] = await this.db.executeSql(
        'SELECT * FROM devices WHERE id = ?;',
        [deviceId]
      );
      
      return results.rows.item(0) || null;
    } catch (error) {
      console.error('❌ Error getting device:', error);
      throw error;
    }
  }

  async getAllDevices() {
    try {
      await this.ensureInitialized();
      const [results] = await this.db.executeSql(
        'SELECT * FROM devices ORDER BY last_seen DESC;'
      );
      
      const devices = [];
      for (let i = 0; i < results.rows.length; i++) {
        devices.push(results.rows.item(i));
      }
      return devices;
    } catch (error) {
      console.error('❌ Error getting all devices:', error);
      throw error;
    }
  }

  async updateDeviceStatus(deviceId, status) {
    try {
      await this.ensureInitialized();
      await this.db.executeSql(
        `UPDATE devices SET connection_status = ?, last_seen = ?, updated_at = strftime('%s', 'now') 
         WHERE id = ?;`,
        [status, Date.now(), deviceId]
      );
      return true;
    } catch (error) {
      console.error('❌ Error updating device status:', error);
      throw error;
    }
  }

  async deleteDevice(deviceId) {
    try {
      await this.ensureInitialized();
      await this.db.executeSql('DELETE FROM devices WHERE id = ?;', [deviceId]);
      return true;
    } catch (error) {
      console.error('❌ Error deleting device:', error);
      throw error;
    }
  }

  // ============ MESSAGE OPERATIONS ============

  async saveMessage(message) {
    try {
      await this.ensureInitialized();
      const {
        id,
        content,
        sender_id,
        sender_name,
        receiver_id = null,
        message_type,
        is_mine = 0,
        is_broadcast = 0,
        timestamp = Date.now(),
        read_status = 0,
        delivery_status = 'sent'
      } = message;

      // Save message
      await this.db.executeSql(
        `INSERT INTO messages 
         (id, content, sender_id, sender_name, receiver_id, message_type, is_mine, is_broadcast, timestamp, read_status, delivery_status) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [id, content, sender_id, sender_name, receiver_id, message_type, is_mine ? 1 : 0, is_broadcast ? 1 : 0, timestamp, read_status ? 1 : 0, delivery_status]
      );

      // Update conversation
      await this.updateConversation(message);

      return { ...message, id };
    } catch (error) {
      console.error('❌ Error saving message:', error);
      throw error;
    }
  }

  async getMessages(conversationId, messageType = 'direct', limit = 100, offset = 0) {
    try {
      await this.ensureInitialized();
      let query, params;

      if (messageType === 'broadcast') {
        query = `SELECT * FROM messages 
                 WHERE message_type = 'broadcast' 
                 ORDER BY timestamp DESC 
                 LIMIT ? OFFSET ?;`;
        params = [limit, offset];
      } else {
        query = `SELECT * FROM messages 
                 WHERE message_type = 'direct' 
                 AND (sender_id = ? OR receiver_id = ?) 
                 ORDER BY timestamp DESC 
                 LIMIT ? OFFSET ?;`;
        params = [conversationId, conversationId, limit, offset];
      }

      const [results] = await this.db.executeSql(query, params);
      
      const messages = [];
      for (let i = 0; i < results.rows.length; i++) {
        messages.push(this.normalizeMessage(results.rows.item(i)));
      }
      
      return messages.reverse(); // Oldest first
    } catch (error) {
      console.error('❌ Error getting messages:', error);
      throw error;
    }
  }

  async getUnreadCount(conversationId = null, messageType = null) {
    try {
      await this.ensureInitialized();
      let query = 'SELECT COUNT(*) as count FROM messages WHERE read_status = 0';
      const params = [];

      if (conversationId && messageType === 'direct') {
        query += ' AND message_type = ? AND (sender_id = ? OR receiver_id = ?)';
        params.push('direct', conversationId, conversationId);
      } else if (messageType === 'broadcast') {
        query += ' AND message_type = ?';
        params.push('broadcast');
      }

      const [results] = await this.db.executeSql(query, params);
      return results.rows.item(0).count;
    } catch (error) {
      console.error('❌ Error getting unread count:', error);
      throw error;
    }
  }

  async markMessagesAsRead(conversationId, messageType = 'direct') {
    try {
      await this.ensureInitialized();
      let query, params;

      if (messageType === 'broadcast') {
        query = `UPDATE messages SET read_status = 1 WHERE message_type = 'broadcast';`;
        params = [];
      } else {
        query = `UPDATE messages SET read_status = 1 
                 WHERE message_type = 'direct' 
                 AND (sender_id = ? OR receiver_id = ?);`;
        params = [conversationId, conversationId];
      }

      await this.db.executeSql(query, params);

      // Update conversation unread count
      await this.db.executeSql(
        `UPDATE conversations SET unread_count = 0, updated_at = strftime('%s', 'now') 
         WHERE id = ?;`,
        [messageType === 'broadcast' ? 'broadcast' : conversationId]
      );

      return true;
    } catch (error) {
      console.error('❌ Error marking messages as read:', error);
      throw error;
    }
  }

  async deleteMessage(messageId) {
    try {
      await this.ensureInitialized();
      await this.db.executeSql('DELETE FROM messages WHERE id = ?;', [messageId]);
      return true;
    } catch (error) {
      console.error('❌ Error deleting message:', error);
      throw error;
    }
  }

  async deleteConversation(conversationId, messageType = 'direct') {
    try {
      await this.ensureInitialized();
      if (messageType === 'broadcast') {
        await this.db.executeSql(`DELETE FROM messages WHERE message_type = 'broadcast';`);
        await this.db.executeSql(`DELETE FROM conversations WHERE id = 'broadcast';`);
      } else {
        await this.db.executeSql(
          `DELETE FROM messages WHERE message_type = 'direct' AND (sender_id = ? OR receiver_id = ?);`,
          [conversationId, conversationId]
        );
        await this.db.executeSql('DELETE FROM conversations WHERE device_id = ?;', [conversationId]);
      }
      return true;
    } catch (error) {
      console.error('❌ Error deleting conversation:', error);
      throw error;
    }
  }

  async clearAllMessages() {
    try {
      await this.ensureInitialized();
      await this.db.executeSql('DELETE FROM messages;');
      await this.db.executeSql('DELETE FROM conversations;');
      await this.db.executeSql('DELETE FROM devices;');
      return true;
    } catch (error) {
      console.error('❌ Error clearing all messages:', error);
      throw error;
    }
  }

  // ============ CONVERSATION OPERATIONS ============

  async updateConversation(message) {
    try {
      await this.ensureInitialized();
      const isBroadcast = message.message_type === 'broadcast';
      const conversationId = isBroadcast ? 'broadcast' : (message.is_mine ? message.receiver_id : message.sender_id);
      
      let deviceName;
      if (isBroadcast) {
        deviceName = '📢 Broadcast to All';
      } else if (message.is_mine) {
        // We sent this message, get recipient name
        const device = await this.getDevice(message.receiver_id);
        deviceName = device?.name || `Device_${message.receiver_id?.substring(0, 8)}`;
      } else {
        // We received this message
        deviceName = message.sender_name;
      }

      // Calculate unread count
      const unreadCount = await this.getUnreadCount(conversationId, message.message_type);

      // Insert or update conversation
      await this.db.executeSql(
        `INSERT OR REPLACE INTO conversations 
         (id, device_id, device_name, last_message, last_message_time, unread_count, message_type, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'));`,
        [
          conversationId,
          isBroadcast ? null : conversationId,
          deviceName,
          message.content.length > 100 ? message.content.substring(0, 100) + '...' : message.content,
          message.timestamp,
          unreadCount,
          message.message_type
        ]
      );

      return true;
    } catch (error) {
      console.error('❌ Error updating conversation:', error);
      throw error;
    }
  }

  async getConversations() {
    try {
      await this.ensureInitialized();
      const [results] = await this.db.executeSql(
        `SELECT * FROM conversations 
         ORDER BY last_message_time DESC;`
      );
      
      const conversations = [];
      for (let i = 0; i < results.rows.length; i++) {
        conversations.push(this.normalizeConversation(results.rows.item(i)));
      }
      return conversations;
    } catch (error) {
      console.error('❌ Error getting conversations:', error);
      throw error;
    }
  }

  async getConversation(conversationId) {
    try {
      await this.ensureInitialized();
      const [results] = await this.db.executeSql(
        'SELECT * FROM conversations WHERE id = ?;',
        [conversationId]
      );
      
      return results.rows.length > 0 ? this.normalizeConversation(results.rows.item(0)) : null;
    } catch (error) {
      console.error('❌ Error getting conversation:', error);
      throw error;
    }
  }

  // ============ UTILITY METHODS ============

  normalizeMessage(dbMessage) {
    return {
      id: dbMessage.id,
      text: dbMessage.content,
      senderId: dbMessage.sender_id,
      senderName: dbMessage.sender_name,
      receiverId: dbMessage.receiver_id,
      type: dbMessage.message_type,
      isMine: dbMessage.is_mine === 1,
      isBroadcast: dbMessage.is_broadcast === 1,
      timestamp: dbMessage.timestamp,
      read: dbMessage.read_status === 1,
      deliveryStatus: dbMessage.delivery_status,
      createdAt: dbMessage.created_at
    };
  }

  normalizeConversation(dbConversation) {
    return {
      id: dbConversation.id,
      deviceId: dbConversation.device_id,
      name: dbConversation.device_name,
      lastMessage: dbConversation.last_message,
      timestamp: dbConversation.last_message_time,
      unreadCount: dbConversation.unread_count,
      type: dbConversation.message_type,
      isBroadcast: dbConversation.message_type === 'broadcast',
      updatedAt: dbConversation.updated_at
    };
  }

  async getMessageCount() {
    try {
      await this.ensureInitialized();
      const [results] = await this.db.executeSql('SELECT COUNT(*) as count FROM messages;');
      return results.rows.item(0).count;
    } catch (error) {
      console.error('❌ Error getting message count:', error);
      throw error;
    }
  }

  async getDatabaseSize() {
    try {
      await this.ensureInitialized();
      const [results] = await this.db.executeSql(
        "SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size();"
      );
      return results.rows.item(0).size;
    } catch (error) {
      console.error('❌ Error getting database size:', error);
      return 0;
    }
  }

  async backupDatabase() {
    try {
      await this.ensureInitialized();
      const timestamp = Date.now();
      const backupName = `PeerReachDB_backup_${timestamp}.db`;
      
      await this.db.executeSql(`ATTACH DATABASE '${backupName}' AS backup;`);
      await this.db.executeSql('CREATE TABLE backup.messages AS SELECT * FROM main.messages;');
      await this.db.executeSql('CREATE TABLE backup.devices AS SELECT * FROM main.devices;');
      await this.db.executeSql('CREATE TABLE backup.conversations AS SELECT * FROM main.conversations;');
      await this.db.executeSql('DETACH DATABASE backup;');
      
      console.log(`✅ Database backed up as ${backupName}`);
      return backupName;
    } catch (error) {
      console.error('❌ Error backing up database:', error);
      throw error;
    }
  }

  async close() {
    try {
      if (this.db) {
        await this.db.close();
        this.db = null;
        this.isInitialized = false;
        console.log('✅ Database closed');
      }
    } catch (error) {
      console.error('❌ Error closing database:', error);
      throw error;
    }
  }
}

// Export singleton instance
const databaseService = new DatabaseService();
export default databaseService;
