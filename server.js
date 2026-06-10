const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (
        !origin || 
        origin.startsWith('http://localhost:') || 
        origin.startsWith('http://127.0.0.1:') ||
        origin.endsWith('.railway.app') ||
        origin === 'https://bestiechat.up.railway.app'
      ) {
        return callback(null, true);
      }
      callback(new Error('Not allowed by CORS'));
    },
    methods: ["GET", "POST"]
  }
});

// SQLite DB Setup
const db = new sqlite3.Database('./chat.db');

db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, name TEXT, avatar TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, senderId INTEGER, receiverId INTEGER, text TEXT, time TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  db.run("CREATE TABLE IF NOT EXISTS friend_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, senderId INTEGER, receiverId INTEGER, status TEXT DEFAULT 'pending', timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  db.run("CREATE TABLE IF NOT EXISTS instants (id INTEGER PRIMARY KEY AUTOINCREMENT, senderId INTEGER, receiverId INTEGER, imageUrl TEXT, caption TEXT, status TEXT DEFAULT 'unread', timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  
  // Add status column to messages if it doesn't exist
  db.run("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'sent'", (err) => {
    // Ignore error if column already exists
  });

  // Add lastSeen column to users if it doesn't exist
  db.run("ALTER TABLE users ADD COLUMN lastSeen DATETIME", (err) => {
    // Ignore error if column already exists
  });
});

// REST APIs
app.post('/api/register', (req, res) => {
  const { username, password, name, avatar: clientAvatar } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'All fields are required' });
  const avatar = clientAvatar || `https://i.pravatar.cc/150?u=${username}`;

  db.run("INSERT INTO users (username, password, name, avatar) VALUES (?, ?, ?, ?)", 
    [username, password, name, avatar], 
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, username, name, avatar });
    }
  );
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT id, username, name, avatar FROM users WHERE username = ? AND password = ?", 
    [username, password], 
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(401).json({ error: 'Invalid credentials' });
      res.json(row);
    }
  );
});

app.post('/api/update-avatar', (req, res) => {
  const { userId, avatar } = req.body;
  if (!userId || !avatar) return res.status(400).json({ error: 'User ID and avatar are required' });
  
  db.run("UPDATE users SET avatar = ? WHERE id = ?", [avatar, userId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, avatar });
  });
});

app.get('/api/friends/:currentUserId', (req, res) => {
  const query = `
    SELECT u.id, u.username, u.name, u.avatar, u.lastSeen 
    FROM users u
    JOIN friend_requests fr ON (fr.senderId = u.id OR fr.receiverId = u.id)
    WHERE (fr.senderId = ? OR fr.receiverId = ?) AND u.id != ? AND fr.status = 'accepted'
  `;
  db.all(query, [req.params.currentUserId, req.params.currentUserId, req.params.currentUserId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/discover/:currentUserId', (req, res) => {
  const query = `
    SELECT u.id, u.username, u.name, u.avatar 
    FROM users u
    WHERE u.id != ? AND u.id NOT IN (
      SELECT senderId FROM friend_requests WHERE receiverId = ?
      UNION
      SELECT receiverId FROM friend_requests WHERE senderId = ?
    )
  `;
  db.all(query, [req.params.currentUserId, req.params.currentUserId, req.params.currentUserId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/requests/:currentUserId', (req, res) => {
  const query = `
    SELECT fr.id as requestId, u.id as userId, u.username, u.name, u.avatar 
    FROM friend_requests fr
    JOIN users u ON fr.senderId = u.id
    WHERE fr.receiverId = ? AND fr.status = 'pending'
  `;
  db.all(query, [req.params.currentUserId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/requests/send', (req, res) => {
  const { senderId, receiverId } = req.body;
  db.run("INSERT INTO friend_requests (senderId, receiverId, status) VALUES (?, ?, 'pending')", 
    [senderId, receiverId], 
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, requestId: this.lastID });
    }
  );
});

app.post('/api/requests/accept', (req, res) => {
  const { requestId } = req.body;
  db.run("UPDATE friend_requests SET status = 'accepted' WHERE id = ?", 
    [requestId], 
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.post('/api/requests/decline', (req, res) => {
  const { requestId } = req.body;
  db.run("DELETE FROM friend_requests WHERE id = ?", 
    [requestId], 
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.get('/api/messages/:user1/:user2', (req, res) => {
  const { user1, user2 } = req.params;
  db.all(
    "SELECT id, senderId, receiverId, text, time, COALESCE(status, 'sent') as status FROM messages WHERE (senderId = ? AND receiverId = ?) OR (senderId = ? AND receiverId = ?) ORDER BY timestamp ASC",
    [user1, user2, user2, user1],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Instants REST APIs
app.post('/api/instants/send', (req, res) => {
  const { senderId, receiverId, imageUrl, caption } = req.body;
  if (!senderId || !receiverId || !imageUrl) return res.status(400).json({ error: 'Missing fields' });
  db.run("INSERT INTO instants (senderId, receiverId, imageUrl, caption, status) VALUES (?, ?, ?, ?, 'unread')",
    [senderId, receiverId, imageUrl, caption || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, senderId, receiverId, imageUrl, caption, status: 'unread' });
    }
  );
});

app.get('/api/instants/active/:userId', (req, res) => {
  const { userId } = req.params;
  const query = `
    SELECT i.id, i.senderId, i.receiverId, i.imageUrl, i.caption, i.status, i.timestamp, u.name as senderName, u.avatar as senderAvatar
    FROM instants i
    JOIN users u ON i.senderId = u.id
    WHERE i.receiverId = ? AND i.status = 'unread'
    ORDER BY i.timestamp ASC
  `;
  db.all(query, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/instants/open', (req, res) => {
  const { instantId } = req.body;
  db.run("UPDATE instants SET status = 'opened' WHERE id = ?", [instantId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.get('/api/instants/archive/:userId', (req, res) => {
  const { userId } = req.params;
  const query = `
    SELECT i.id, i.senderId, i.receiverId, i.imageUrl, i.caption, i.status, i.timestamp, u.name as receiverName, u.avatar as receiverAvatar
    FROM instants i
    JOIN users u ON i.receiverId = u.id
    WHERE i.senderId = ?
    ORDER BY i.timestamp DESC
  `;
  db.all(query, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Socket.io Real-time Logic
const connectedUsers = new Map(); // userId -> socketId

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('register_user', (userId) => {
    connectedUsers.set(userId.toString(), socket.id);
    db.run("UPDATE users SET lastSeen = NULL WHERE id = ?", [userId], (err) => {
      if (err) console.error("Error setting user online:", err.message);
    });
    io.emit('user_status_change', { userId: parseInt(userId), status: 'online', lastSeen: null });
  });

  socket.on('send_message', (data) => {
    const { senderId, receiverId, text, time } = data;
    
    // Check if receiver is online to determine initial status
    const receiverSocketId = connectedUsers.get(receiverId.toString());
    const initialStatus = receiverSocketId ? 'delivered' : 'sent';

    db.run("INSERT INTO messages (senderId, receiverId, text, time, status) VALUES (?, ?, ?, ?, ?)",
      [senderId, receiverId, text, time, initialStatus],
      function(err) {
        if (err) return console.error("Error saving message:", err.message);
        
        const fullMessage = { id: this.lastID, senderId, receiverId, text, time, status: initialStatus };
        
        // Notify sender it was sent
        socket.emit('message_sent', fullMessage);
        
        if (receiverSocketId) {
          // Send to receiver
          io.to(receiverSocketId).emit('receive_message', fullMessage);
        }
      }
    );
  });

  // Typing indicators
  socket.on('typing', (data) => {
    const receiverSocketId = connectedUsers.get(data.receiverId.toString());
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('typing', { senderId: data.senderId });
    }
  });

  socket.on('stop_typing', (data) => {
    const receiverSocketId = connectedUsers.get(data.receiverId.toString());
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('stop_typing', { senderId: data.senderId });
    }
  });

  // Message status updates
  socket.on('mark_seen', (data) => {
    // data = { senderId, receiverId } where receiverId is the one who just read the messages
    const query = "UPDATE messages SET status = 'seen' WHERE senderId = ? AND receiverId = ? AND status != 'seen'";
    db.run(query, [data.senderId, data.receiverId], function(err) {
      if (err) return console.error("Error marking seen:", err.message);
      
      const senderSocketId = connectedUsers.get(data.senderId.toString());
      if (senderSocketId) {
        io.to(senderSocketId).emit('messages_seen', { 
          readerId: data.receiverId 
        });
      }
    });
  });

  socket.on('update_message', (data) => {
    // data = { id, text, senderId, receiverId }
    const { id, text, senderId, receiverId } = data;
    db.run("UPDATE messages SET text = ? WHERE id = ?", [text, id], function(err) {
      if (err) return console.error("Error updating message:", err.message);
      
      const receiverSocketId = connectedUsers.get(receiverId.toString());
      const senderSocketId = connectedUsers.get(senderId.toString());
      
      const updatePayload = { id, text };
      if (receiverSocketId) io.to(receiverSocketId).emit('message_updated', updatePayload);
      if (senderSocketId) io.to(senderSocketId).emit('message_updated', updatePayload);
    });
  });

  socket.on('mark_delivered', (data) => {
    // When a user comes online, mark messages sent to them as delivered
    const query = "UPDATE messages SET status = 'delivered' WHERE receiverId = ? AND status = 'sent'";
    db.run(query, [data.userId], function(err) {
      if (err) return console.error("Error marking delivered:", err.message);
      // We could broadcast to all their friends that messages are delivered,
      // but to keep it simple, we'll let the clients pull or just update newly sent ones.
    });
  });

  socket.on('send_friend_request', (data) => {
    const receiverSocketId = connectedUsers.get(data.receiverId.toString());
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('receive_friend_request', data);
    }
  });

  socket.on('accept_friend_request', (data) => {
    const senderSocketId = connectedUsers.get(data.senderId.toString());
    if (senderSocketId) {
      io.to(senderSocketId).emit('friend_request_accepted', data);
    }
  });

  socket.on('check_online', (userIds, callback) => {
    const ids = userIds.map(id => parseInt(id)).filter(id => !isNaN(id));
    if (ids.length === 0) return callback({});
    
    const placeholders = ids.map(() => '?').join(',');
    const query = `SELECT id, lastSeen FROM users WHERE id IN (${placeholders})`;
    db.all(query, ids, (err, rows) => {
      const statuses = {};
      const lastSeenMap = {};
      if (rows) {
        rows.forEach(row => {
          lastSeenMap[row.id] = row.lastSeen;
        });
      }
      userIds.forEach(id => {
        statuses[id] = {
          online: connectedUsers.has(id.toString()),
          lastSeen: lastSeenMap[id] || null
        };
      });
      callback(statuses);
    });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    for (let [userId, socketId] of connectedUsers.entries()) {
      if (socketId === socket.id) {
        connectedUsers.delete(userId);
        const now = new Date().toISOString();
        db.run("UPDATE users SET lastSeen = ? WHERE id = ?", [now, userId], (err) => {
          if (err) console.error("Error setting lastSeen on disconnect:", err.message);
        });
        io.emit('user_status_change', { userId: parseInt(userId), status: 'offline', lastSeen: now });
        break;
      }
    }
  });

  // Instants Socket Signaling
  socket.on('send_instant', (data) => {
    const receiverSocketId = connectedUsers.get(data.receiverId.toString());
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('receive_instant', data);
    }
  });

  socket.on('instant_opened', (data) => {
    const senderSocketId = connectedUsers.get(data.senderId.toString());
    if (senderSocketId) {
      io.to(senderSocketId).emit('instant_opened', data);
    }
  });
});

const path = require('path');
app.use(express.static(path.join(__dirname, 'dist')));

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Production chat server running on port ${PORT}`);
});
