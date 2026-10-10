console.log("INDEX.JS EXECUTED");

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { WIN_LINES } from "./winLines.js";

export function checkWinner(board) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (
      board[a] &&
      board[a] === board[b] &&
      board[a] === board[c]
    ) {
      return { winner: board[a], line };
    }
  }
  return null;
}


const app = express();
app.use(cors());

// ─── TURN credential fetching from Metered.ca ─────────────────────
const METERED_API_KEY = process.env.METERED_API_KEY || "";

async function fetchTurnCredentials() {
  if (!METERED_API_KEY) {
    console.warn("[TURN] No METERED_API_KEY set — falling back to STUN-only");
    return [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
    ];
  }

  try {
    const resp = await fetch(
      `https://tic-tac-toe.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`
    );
    if (!resp.ok) throw new Error(`Metered API returned ${resp.status}`);
    const iceServers = await resp.json();
    console.log("[TURN] Fetched", iceServers.length, "ICE servers from Metered");
    return iceServers;
  } catch (err) {
    console.error("[TURN] Failed to fetch from Metered:", err.message);
    // Fallback to STUN-only
    return [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ];
  }
}

// REST endpoint for fetching TURN credentials
app.get("/api/turn-credentials", async (req, res) => {
  const iceServers = await fetchTurnCredentials();
  res.json({ iceServers });
});

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

const rooms = {}; // roomId -> game state

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // ── Provide fresh TURN credentials to the client ──
  socket.on("get-turn-credentials", async (callback) => {
    const iceServers = await fetchTurnCredentials();
    callback({ iceServers });
  });
  socket.on("webrtc-offer", ({ targetId, offer }) => {
    io.to(targetId).emit("webrtc-offer", { senderId: socket.id, offer });
  });

  socket.on("webrtc-answer", ({ targetId, answer }) => {
    io.to(targetId).emit("webrtc-answer", { senderId: socket.id, answer });
  });

  socket.on("webrtc-ice-candidate", ({ targetId, candidate }) => {
    io.to(targetId).emit("webrtc-ice-candidate", { senderId: socket.id, candidate });
  });


  socket.on("join-room", ({ roomId, asSpectator }) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        board: Array(27).fill(null),
        playerTurn: "X",
        // Fixed seats: index 0 = X, index 1 = O, null = empty seat.
        // Seats are never shifted, so a player keeps their symbol if the other leaves.
        players: [null, null],
        spectators: [],
        winner: null,
        scores: { X: 0, O: 0, draws: 0 }
      };
    }

    const room = rooms[roomId];

    if (!room.players.includes(socket.id) && (!room.spectators || !room.spectators.includes(socket.id))) {
      room.spectators = room.spectators || [];
      const freeSeat = room.players.indexOf(null);
      if (!asSpectator && freeSeat !== -1) {
        room.players[freeSeat] = socket.id;
      } else if (asSpectator) {
        room.spectators.push(socket.id);
      } else {
        socket.emit("room-full");
        return; // Room is full, prompt client
      }
    }

    console.log("ROOM PLAYERS:", room.players, "SPECTATORS:", room.spectators || []);

    const playerIndex = room.players.indexOf(socket.id);
    let role = "spectator";
    if (playerIndex === 0) role = "X";
    if (playerIndex === 1) role = "O";

    console.log("Assigning", role, "to", socket.id);

    socket.emit("player-assigned", role);
    io.to(roomId).emit("state-update", room);

    const otherUsers = [...room.players, ...(room.spectators || [])].filter((id) => id && id !== socket.id);

    // Send list of existing users to the new user
    socket.emit("all-users", otherUsers);

    // Notify other users that someone new joined
    socket.to(roomId).emit("user-joined", socket.id);
  });

  socket.on("make-move", ({ roomId, index }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Reject anything that isn't a real cell index (0–26)
    if (!Number.isInteger(index) || index < 0 || index >= room.board.length) return;

    const playerIndex = room.players.indexOf(socket.id);
    if (playerIndex === -1) {
      console.warn(`[SECURITY] Spectator ${socket.id} attempted to make a move.`);
      return;
    }

    const symbol = playerIndex === 0 ? "X" : "O";

    if (room.winner) return;
    if (room.playerTurn !== symbol) return;
    if (room.board[index]) return;

    room.board[index] = symbol;

    const result = checkWinner(room.board);

    if (result) {
      room.winner = result;
      room.scores = room.scores || { X: 0, O: 0, draws: 0 };
      if (result.winner === "X" || result.winner === "O") {
        room.scores[result.winner] = (room.scores[result.winner] || 0) + 1;
      }
    } else {
      const isDraw = room.board.every(cell => cell !== null);
      if (isDraw) {
        room.winner = { winner: "Draw", line: [] };
        room.scores = room.scores || { X: 0, O: 0, draws: 0 };
        room.scores.draws = (room.scores.draws || 0) + 1;
      } else {
        room.playerTurn = symbol === "X" ? "O" : "X";
      }
    }

    io.to(roomId).emit("state-update", room);
  });

  socket.on("reset-game", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Reject if the user requesting a reset isn't a documented player
    if (!room.players.includes(socket.id)) {
      console.warn(`[SECURITY] Spectator ${socket.id} attempted to reset the game.`);
      return;
    }

    room.board = Array(27).fill(null);
    room.playerTurn = "X";
    room.winner = null;

    io.to(roomId).emit("state-update", room);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    for (const roomId in rooms) {
      const room = rooms[roomId];
      const hasPlayers = room.players.includes(socket.id);
      const hasSpectators = room.spectators && room.spectators.includes(socket.id);

      if (hasPlayers || hasSpectators) {
        // Free the seat instead of removing it, so the remaining player keeps their symbol
        room.players = room.players.map(id => (id === socket.id ? null : id));
        if (room.spectators) {
          room.spectators = room.spectators.filter(id => id !== socket.id);
        }
        socket.to(roomId).emit("user-disconnected", socket.id);

        if (room.players.every(id => id === null) && (!room.spectators || room.spectators.length === 0)) {
          delete rooms[roomId];
        } else {
          io.to(roomId).emit("state-update", room);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log("Server running on port", PORT);
});