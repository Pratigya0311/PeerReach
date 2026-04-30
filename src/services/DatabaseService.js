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

  async createTables() {
    try {
      // Enable foreign key enforcement — SQLite has it OFF by default
      await this.db.executeSql('PRAGMA foreign_keys = ON;');

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
      // 4. Gateway cache table
      await this.db.executeSql(`
        CREATE TABLE IF NOT EXISTS gateway_cache (
          query TEXT PRIMARY KEY,
          result TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        );
      `);

      // 5. Known users table (multi-hop discovery)
      await this.db.executeSql(`
        CREATE TABLE IF NOT EXISTS known_users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          last_seen INTEGER NOT NULL,
          hops INTEGER DEFAULT 0,
          via_peer TEXT,
          is_online INTEGER DEFAULT 1,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        );
      `);

      // 6. Migrate: add missing columns (check first so no native-level SQL errors logged)
      const [msgCols]    = await this.db.executeSql('PRAGMA table_info(messages);');
      const [devCols]    = await this.db.executeSql('PRAGMA table_info(devices);');
      const [knownCols]  = await this.db.executeSql('PRAGMA table_info(known_users);');
      const existingMsg  = new Set();
      const existingDev  = new Set();
      const existingKnown = new Set();
      for (let i = 0; i < msgCols.rows.length; i++) existingMsg.add(msgCols.rows.item(i).name);
      for (let i = 0; i < devCols.rows.length; i++) existingDev.add(devCols.rows.item(i).name);
      for (let i = 0; i < knownCols.rows.length; i++) existingKnown.add(knownCols.rows.item(i).name);

      const msgMigrations = [
        ['is_pinned',   'ALTER TABLE messages ADD COLUMN is_pinned INTEGER DEFAULT 0;'],
        ['reply_to_id', 'ALTER TABLE messages ADD COLUMN reply_to_id TEXT;'],
        ['reply_preview','ALTER TABLE messages ADD COLUMN reply_preview TEXT;'],
        ['delivered_at','ALTER TABLE messages ADD COLUMN delivered_at INTEGER;'],
        ['read_at',     'ALTER TABLE messages ADD COLUMN read_at INTEGER;'],
      ];
      const safeAlter = async (sql) => {
        try { await this.db.executeSql(sql); }
        catch (e) {
          // "duplicate column" means the column already exists — safe to ignore
          if (!String(e.message).includes('duplicate column')) throw e;
        }
      };
      for (const [col, sql] of msgMigrations) {
        if (!existingMsg.has(col)) await safeAlter(sql);
      }
      if (!existingDev.has('battery')) {
        await safeAlter('ALTER TABLE devices ADD COLUMN battery INTEGER;');
      }
      if (!existingKnown.has('is_online')) {
        await safeAlter('ALTER TABLE known_users ADD COLUMN is_online INTEGER DEFAULT 1;');
      }

      // 7. Create indexes for performance
      await this.db.executeSql('CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);');
      await this.db.executeSql('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);');
      await this.db.executeSql('CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);');
      await this.db.executeSql('CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(message_type);');
      await this.db.executeSql('CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);');
      await this.db.executeSql('CREATE INDEX IF NOT EXISTS idx_known_users_seen ON known_users(last_seen DESC);');

      console.log('✅ Database tables created');

    } catch (error) {
      // Log but don't throw — a failed migration step (e.g. duplicate column from a previous
      // concurrent init) should not prevent the app from using an otherwise valid database.
      console.error('❌ Error creating tables:', error);
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
      const { id, name, last_seen = Date.now(), connection_status = 'online', battery = null } = device;

      await this.db.executeSql(
        `INSERT OR REPLACE INTO devices (id, name, last_seen, connection_status, battery, updated_at)
         VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'));`,
        [id, name, last_seen, connection_status, battery]
      );

      return device;
    } catch (error) {
      console.error('❌ Error saving device:', error);
      throw error;
    }
  }

  async getDevice(deviceId) {
    if (!deviceId) return null;
    try {
      await this.ensureInitialized();
      const [results] = await this.db.executeSql(
        'SELECT * FROM devices WHERE id = ?;',
        [deviceId]
      );
      
      if (!results || !results.rows || results.rows.length === 0) return null;
      return results.rows.item(0);
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
        delivery_status = 'sent',
        reply_to_id = null,
        reply_preview = null,
      } = message;

      // Ensure sender/receiver rows exist so FK constraints don't fire.
      // Use INSERT OR IGNORE so we never overwrite a proper name already saved.
      if (sender_id) {
        const fallbackName = (sender_name && sender_name !== 'Unknown Device')
          ? sender_name
          : `Device_${sender_id.substring(0, 8)}`;
        await this.db.executeSql(
          `INSERT OR IGNORE INTO devices (id, name, connection_status) VALUES (?, ?, 'online');`,
          [sender_id, fallbackName]
        );
      }
      if (receiver_id) {
        // Check if receiver already has a real name before inserting a generic one
        const [existing] = await this.db.executeSql('SELECT name FROM devices WHERE id = ?', [receiver_id]);
        if (!existing || existing.rows.length === 0) {
          await this.db.executeSql(
            `INSERT OR IGNORE INTO devices (id, name, connection_status) VALUES (?, ?, 'online');`,
            [receiver_id, `Device_${receiver_id.substring(0, 8)}`]
          );
        }
      }

      // Save message
      await this.db.executeSql(
        `INSERT OR IGNORE INTO messages
         (id, content, sender_id, sender_name, receiver_id, message_type, is_mine, is_broadcast, timestamp, read_status, delivery_status, reply_to_id, reply_preview)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [id, content, sender_id, sender_name, receiver_id, message_type, is_mine ? 1 : 0, is_broadcast ? 1 : 0, timestamp, read_status ? 1 : 0, delivery_status, reply_to_id, reply_preview]
      );

      // Update conversation
      await this.updateConversation(message);

      return { ...message, id };
    } catch (error) {
      console.error('❌ Error saving message:', error);
      throw error;
    }
  }

  async updateMessageStatus(messageId, status, ts = Date.now()) {
    try {
      await this.ensureInitialized();
      if (status === 'delivered') {
        await this.db.executeSql(
          'UPDATE messages SET delivery_status = ?, delivered_at = ? WHERE id = ?',
          [status, ts, messageId]
        );
      } else if (status === 'read') {
        await this.db.executeSql(
          'UPDATE messages SET delivery_status = ?, read_at = ? WHERE id = ?',
          [status, ts, messageId]
        );
      } else {
        await this.db.executeSql(
          'UPDATE messages SET delivery_status = ? WHERE id = ?',
          [status, messageId]
        );
      }
    } catch (err) {
      console.warn('updateMessageStatus error:', err);
    }
  }

  async getQueuedMessages(receiverId = null) {
    try {
      await this.ensureInitialized();
      let query = `SELECT * FROM messages WHERE delivery_status = 'queued'`;
      const params = [];
      if (receiverId) {
        query += ` AND receiver_id = ?`;
        params.push(receiverId);
      }
      query += ` ORDER BY timestamp ASC;`;
      const [results] = await this.db.executeSql(query, params);
      const messages = [];
      for (let i = 0; i < results.rows.length; i++) {
        messages.push(this.normalizeMessage(results.rows.item(i)));
      }
      return messages;
    } catch (error) {
      console.error('Error getting queued messages:', error);
      throw error;
    }
  }

  async getQueuedBroadcastMessages() {
    try {
      await this.ensureInitialized();
      const query = `SELECT * FROM messages WHERE delivery_status = 'queued' AND message_type = 'broadcast' ORDER BY timestamp ASC;`;
      const [results] = await this.db.executeSql(query);
      const messages = [];
      for (let i = 0; i < results.rows.length; i++) {
        messages.push(this.normalizeMessage(results.rows.item(i)));
      }
      return messages;
    } catch (error) {
      console.error('Error getting queued broadcast messages:', error);
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

  async searchMessages(query, limit = 50) {
    try {
      await this.ensureInitialized();
      const term = `%${query}%`;
      const [results] = await this.db.executeSql(
        `SELECT * FROM messages
         WHERE message_type IN ('direct', 'broadcast')
         AND (content LIKE ? OR sender_name LIKE ?)
         ORDER BY timestamp DESC
         LIMIT ?`,
        [term, term, limit]
      );
      const messages = [];
      for (let i = 0; i < results.rows.length; i++) {
        messages.push(this.normalizeMessage(results.rows.item(i)));
      }
      return messages;
    } catch (error) {
      console.error('❌ Error searching messages:', error);
      return [];
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
        deviceName = 'Broadcast to All';
      } else if (message.is_mine) {
        // We sent this message, get recipient name
        const device = await this.getDevice(message.receiver_id);
        deviceName = device?.name || (message.receiver_id ? `Device_${message.receiver_id.substring(0, 8)}` : 'Unknown');
      } else {
        // We received this message
        deviceName = message.sender_name;
      }

      // Calculate unread count
      const unreadCount = await this.getUnreadCount(conversationId, message.message_type);

      // Build a short conversation preview (never store raw base64 in conversation preview)
      let preview = message.content;
      if (preview && preview.startsWith('{')) {
        try {
          const parsed = JSON.parse(preview);
          if (parsed.type === 'photo') preview = '[Photo]';
          else if (parsed.type === 'location') preview = '[Location]';
          else if (parsed.type === 'sos') preview = '[SOS] Emergency alert';
          else if (parsed.type === 'file') preview = `[File] ${parsed.fileName || 'attachment'}`;
          else if (parsed.type === 'find_me_request') preview = '[Find Me] Request';
          else if (parsed.type === 'find_me_response') preview = '[Location] Shared';
          else preview = parsed.text || preview;
        } catch (_e) { /* keep raw */ }
      }
      // For broadcast conversations, prefix with sender name so the preview is self-contained
      if (isBroadcast && !message.is_mine && message.sender_name) {
        preview = `${message.sender_name}: ${preview}`;
      }
      if (preview && preview.length > 100) preview = preview.substring(0, 100) + '...';

      // Insert or update conversation
      await this.db.executeSql(
        `INSERT OR REPLACE INTO conversations
         (id, device_id, device_name, last_message, last_message_time, unread_count, message_type, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'));`,
        [
          conversationId,
          isBroadcast ? null : conversationId,
          deviceName,
          preview,
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

  // ============ KNOWN USERS (MULTI-HOP) ============

  async upsertKnownUser(user) {
    try {
      await this.ensureInitialized();
      const {
        id,
        name,
        last_seen = Date.now(),
        hops = 0,
        via_peer = null,
        is_online = 1
      } = user;

      await this.db.executeSql(
        `INSERT OR REPLACE INTO known_users 
         (id, name, last_seen, hops, via_peer, is_online, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'));`,
        [id, name, last_seen, hops, via_peer, is_online]
      );

      return true;
    } catch (error) {
      console.error('Error upserting known user:', error);
      throw error;
    }
  }

  async getKnownUsers(minLastSeen = 0, includeOffline = false) {
    try {
      await this.ensureInitialized();
      const query = includeOffline
        ? `SELECT * FROM known_users WHERE last_seen >= ? ORDER BY last_seen DESC;`
        : `SELECT * FROM known_users WHERE last_seen >= ? AND is_online = 1 ORDER BY last_seen DESC;`;
      const [results] = await this.db.executeSql(query, [minLastSeen]);

      const users = [];
      for (let i = 0; i < results.rows.length; i++) {
        users.push(results.rows.item(i));
      }
      return users;
    } catch (error) {
      console.error('Error getting known users:', error);
      throw error;
    }
  }

  async getKnownUser(userId) {
    try {
      await this.ensureInitialized();
      const [results] = await this.db.executeSql(
        'SELECT * FROM known_users WHERE id = ? LIMIT 1;',
        [userId]
      );
      return results.rows.item(0) || null;
    } catch (error) {
      console.error('Error getting known user:', error);
      throw error;
    }
  }

  async pruneKnownUsers(expireBefore) {
    try {
      await this.ensureInitialized();
      await this.db.executeSql(
        `DELETE FROM known_users WHERE last_seen < ?;`,
        [expireBefore]
      );
      return true;
    } catch (error) {
      console.error('Error pruning known users:', error);
      throw error;
    }
  }

  async markKnownUsersStaleByViaPeer(viaPeerId) {
    try {
      await this.ensureInitialized();
      await this.db.executeSql(
        `UPDATE known_users SET is_online = 0, updated_at = strftime('%s', 'now') WHERE via_peer = ?;`,
        [viaPeerId]
      );
      return true;
    } catch (error) {
      console.error('Error marking known users stale:', error);
      throw error;
    }
  }

  // ============ UTILITY METHODS ============

  async pinMessage(messageId, pinned) {
    try {
      await this.ensureInitialized();
      await this.db.executeSql(
        'UPDATE messages SET is_pinned = ? WHERE id = ?;',
        [pinned ? 1 : 0, messageId]
      );
      return true;
    } catch (error) {
      console.error('❌ Error pinning message:', error);
      throw error;
    }
  }

  async getPinnedMessages(conversationId, isBroadcast) {
    try {
      await this.ensureInitialized();
      let query, params;
      if (isBroadcast) {
        query = `SELECT * FROM messages WHERE is_pinned = 1 AND message_type = 'broadcast' ORDER BY timestamp ASC;`;
        params = [];
      } else {
        query = `SELECT * FROM messages WHERE is_pinned = 1 AND message_type = 'direct'
                 AND (sender_id = ? OR receiver_id = ?) ORDER BY timestamp ASC;`;
        params = [conversationId, conversationId];
      }
      const [results] = await this.db.executeSql(query, params);
      const messages = [];
      for (let i = 0; i < results.rows.length; i++)
        messages.push(this.normalizeMessage(results.rows.item(i)));
      return messages;
    } catch (error) {
      console.error('❌ Error getting pinned messages:', error);
      return [];
    }
  }

  async getMediaMessages(conversationId, isBroadcast) {
    try {
      await this.ensureInitialized();
      let query, params;
      if (isBroadcast) {
        query = `SELECT * FROM messages WHERE message_type = 'broadcast'
                 AND (content LIKE '{"type":"photo"%' OR content LIKE '{"type":"location"%')
                 ORDER BY timestamp DESC;`;
        params = [];
      } else {
        query = `SELECT * FROM messages WHERE message_type = 'direct'
                 AND (sender_id = ? OR receiver_id = ?)
                 AND (content LIKE '{"type":"photo"%' OR content LIKE '{"type":"location"%')
                 ORDER BY timestamp DESC;`;
        params = [conversationId, conversationId];
      }
      const [results] = await this.db.executeSql(query, params);
      const messages = [];
      for (let i = 0; i < results.rows.length; i++)
        messages.push(this.normalizeMessage(results.rows.item(i)));
      return messages;
    } catch (error) {
      console.error('❌ Error getting media messages:', error);
      return [];
    }
  }

  normalizeMessage(dbMessage) {
    let contentType = 'text';
    let mediaData = null;

    if (dbMessage.content && dbMessage.content.startsWith('{')) {
      try {
        const parsed = JSON.parse(dbMessage.content);
        const knownTypes = ['photo', 'location', 'sos', 'file', 'find_me_request', 'find_me_response'];
        if (knownTypes.includes(parsed.type)) {
          contentType = parsed.type;
          mediaData = parsed;
        } else if (parsed.type === 'text' && parsed.text) {
          // Legacy rows stored full JSON envelope — unwrap to plain text
          return {
            ...this.normalizeMessage({ ...dbMessage, content: parsed.text }),
          };
        }
      } catch (_e) { /* not JSON */ }
    }

    return {
      id: dbMessage.id,
      text: mediaData?.text || dbMessage.content,
      contentType,
      mediaData,
      senderId: dbMessage.sender_id,
      senderName: dbMessage.sender_name,
      receiverId: dbMessage.receiver_id,
      type: dbMessage.message_type,
      isMine: dbMessage.is_mine === 1,
      isBroadcast: dbMessage.is_broadcast === 1,
      timestamp: dbMessage.timestamp,
      read: dbMessage.read_status === 1,
      deliveryStatus: dbMessage.delivery_status,
      deliveredAt: dbMessage.delivered_at || null,
      readAt: dbMessage.read_at || null,
      isPinned: dbMessage.is_pinned === 1,
      replyToId: dbMessage.reply_to_id || null,
      replyPreview: dbMessage.reply_preview || null,
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
