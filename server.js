const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

const authRoutes = require("./routes/auth");
const GroupMessage = require("./models/GroupMessage");
const PrivateMessage = require("./models/PrivateMessage");

const app = express();
const server = http.createServer(app);

// Socket.io (add cors to avoid issues)
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ===== Middleware =====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// ===== Routes =====
app.use("/api/auth", authRoutes);

// Serve views
app.get("/signup", (req, res) => {
  res.sendFile(path.join(__dirname, "view", "signup.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "view", "login.html"));
});

app.get("/chat", (req, res) => {
  res.sendFile(path.join(__dirname, "view", "chat.html"));
});

// Home test route
app.get("/", (req, res) => {
  res.send("Chat App Server is running");
});

// ===== MongoDB Connection =====
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected");
    console.log("MONGO_URI =", process.env.MONGO_URI);
    console.log("DB name  =", mongoose.connection.name);
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
  });

// ===== Socket.io =====
io.on("connection", (socket) => {
  console.log("🟢 User connected:", socket.id);

  // register username to this socket (for private message)
  socket.on("registerUser", (username) => {
    socket.data.username = username;
  });

  // join room + send room history
  socket.on("joinRoom", async ({ username, room }) => {
    try {
      if (!room || !username) return;

      socket.join(room);
      socket.data.room = room;
      socket.data.username = username;

      console.log(`➡️ ${username} joined room: ${room}`);
      socket.to(room).emit("system", `${username} joined the room`);

      // load last 50 messages from MongoDB
      const history = await GroupMessage.find({ room })
        .sort({ date_sent: 1 })
        .limit(50);

      // send history only to this user
      socket.emit("roomHistory", history);
    } catch (err) {
      console.error(err);
      socket.emit("system", "Failed to load history");
    }
  });

  // leave room
  socket.on("leaveRoom", () => {
    const room = socket.data.room;
    const username = socket.data.username;

    if (room) {
      // stop typing indicator for others
      socket.to(room).emit("stopTyping");

      socket.leave(room);
      socket.to(room).emit("system", `${username} left the room`);
      console.log(`⬅️ ${username} left room: ${room}`);
      socket.data.room = null;
    }
  });

  // ===== Step 8: Typing indicator (room-based) =====
  socket.on("typing", () => {
    const room = socket.data.room;
    const username = socket.data.username;
    if (room && username) {
      socket.to(room).emit("typing", `${username} is typing...`);
    }
  });

  socket.on("stopTyping", () => {
    const room = socket.data.room;
    const username = socket.data.username;
    if (room && username) {
      socket.to(room).emit("stopTyping");
    }
  });

  // group chat message (room-based) + save to MongoDB
  socket.on("groupMessage", async ({ message }) => {
    try {
      const room = socket.data.room;
      const username = socket.data.username;

      if (!room || !username) return;
      if (!message || !message.trim()) return;

      const doc = await GroupMessage.create({
        from_user: username,
        room,
        message: message.trim(),
        date_sent: new Date()
      });

      // send to everyone in this room (including sender)
      io.to(room).emit("newGroupMessage", doc);

      // stop typing when message sent
      socket.to(room).emit("stopTyping");
    } catch (err) {
      console.error(err);
      socket.emit("system", "Failed to send message");
    }
  });

  // private message + save to MongoDB (only if receiver is online)
  socket.on("privateMessage", async ({ to_user, message }) => {
    try {
      const from_user = socket.data.username;
      if (!from_user) return;

      if (!to_user || !to_user.trim()) return;
      if (!message || !message.trim()) return;

      const doc = await PrivateMessage.create({
        from_user,
        to_user: to_user.trim(),
        message: message.trim(),
        date_sent: new Date()
      });

      // send to sender
      socket.emit("newPrivateMessage", doc);

      // find receiver socket by scanning connected sockets (simple way)
      const sockets = await io.fetchSockets();
      const receiver = sockets.find((s) => s.data.username === to_user.trim());

      if (receiver) {
        receiver.emit("newPrivateMessage", doc);
      } else {
        socket.emit("system", `${to_user} is not online (saved to DB).`);
      }
    } catch (err) {
      console.error(err);
      socket.emit("system", "Failed to send private message");
    }
  });

  socket.on("disconnect", () => {
    const room = socket.data.room;
    const username = socket.data.username;

    if (room && username) {
      socket.to(room).emit("stopTyping");
      socket.to(room).emit("system", `${username} disconnected`);
    }

    console.log("🔴 User disconnected:", socket.id);
  });
});

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
