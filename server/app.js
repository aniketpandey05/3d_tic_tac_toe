import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import {
  createRoom,
  joinRoom,
  applyMove,
  resetGame,
  leaveRoom,
  isEmpty,
} from "./game.js";

const STUN_FALLBACK = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
];

// ─── TURN credential fetching from Metered.ca ─────────────────────
// The API key stays on the server; clients only ever see short-lived credentials.
async function fetchTurnCredentials(apiKey, log) {
  if (!apiKey) {
    log.warn("[TURN] No METERED_API_KEY set — falling back to STUN-only");
    return STUN_FALLBACK;
  }

  try {
    const resp = await fetch(
      `https://tic-tac-toe.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`
    );
    if (!resp.ok) throw new Error(`Metered API returned ${resp.status}`);
    const iceServers = await resp.json();
    log.log("[TURN] Fetched", iceServers.length, "ICE servers from Metered");
    return iceServers;
  } catch (err) {
    log.error("[TURN] Failed to fetch from Metered:", err.message);
    return STUN_FALLBACK.slice(0, 2);
  }
}

const silentLogger = { log() {}, warn() {}, error() {} };

/**
 * Builds the HTTP + Socket.IO server without starting it.
 * index.js calls listen(); tests start it on a random port.
 */
export function createGameServer({
  corsOrigin = "*",
  meteredApiKey = "",
  logger = console,
  quiet = false,
} = {}) {
  const log = quiet ? silentLogger : logger;

  const rooms = {}; // roomId -> game state

  const app = express();
  app.use(cors({ origin: corsOrigin }));

  // Cheap endpoint for uptime pings / health checks (keeps free-tier hosts warm)
  app.get("/health", (req, res) => {
    res.json({ ok: true, rooms: Object.keys(rooms).length });
  });

  // REST endpoint for fetching TURN credentials
  app.get("/api/turn-credentials", async (req, res) => {
    const iceServers = await fetchTurnCredentials(meteredApiKey, log);
    res.json({ iceServers });
  });

  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: corsOrigin } });

  io.on("connection", (socket) => {
    log.log("User connected:", socket.id);

    // ── Provide fresh TURN credentials to the client ──
    socket.on("get-turn-credentials", async (callback) => {
      if (typeof callback !== "function") return;
      const iceServers = await fetchTurnCredentials(meteredApiKey, log);
      callback({ iceServers });
    });

    // ── WebRTC signaling: relay to exactly one peer, stamped with the sender ──
    socket.on("webrtc-offer", ({ targetId, offer } = {}) => {
      io.to(targetId).emit("webrtc-offer", { senderId: socket.id, offer });
    });

    socket.on("webrtc-answer", ({ targetId, answer } = {}) => {
      io.to(targetId).emit("webrtc-answer", { senderId: socket.id, answer });
    });

    socket.on("webrtc-ice-candidate", ({ targetId, candidate } = {}) => {
      io.to(targetId).emit("webrtc-ice-candidate", { senderId: socket.id, candidate });
    });

    socket.on("join-room", ({ roomId, asSpectator } = {}) => {
      if (typeof roomId !== "string" || !roomId) return;

      socket.join(roomId);
      if (!rooms[roomId]) rooms[roomId] = createRoom();
      const room = rooms[roomId];

      const result = joinRoom(room, socket.id, asSpectator);
      if (result.full) {
        socket.emit("room-full"); // client asks: spectate or new room?
        return;
      }

      log.log(`[ROOM ${roomId}] ${socket.id} joined as ${result.role}`);

      socket.emit("player-assigned", result.role);
      io.to(roomId).emit("state-update", room);

      // The new joiner offers to everyone already here; they wait for the offer.
      const otherUsers = [...room.players, ...room.spectators].filter(
        (id) => id && id !== socket.id
      );
      socket.emit("all-users", otherUsers);
      socket.to(roomId).emit("user-joined", socket.id);
    });

    socket.on("make-move", ({ roomId, index } = {}) => {
      const room = rooms[roomId];
      if (!room) return;

      const result = applyMove(room, socket.id, index);
      if (!result.ok) {
        if (result.reason === "not-a-player" || result.reason === "invalid-index") {
          log.warn(`[SECURITY] ${socket.id} rejected move (${result.reason})`);
        }
        return;
      }

      io.to(roomId).emit("state-update", room);
    });

    socket.on("reset-game", ({ roomId } = {}) => {
      const room = rooms[roomId];
      if (!room) return;

      const result = resetGame(room, socket.id);
      if (!result.ok) {
        log.warn(`[SECURITY] ${socket.id} attempted to reset without being a player`);
        return;
      }

      io.to(roomId).emit("state-update", room);
    });

    socket.on("disconnect", () => {
      log.log("User disconnected:", socket.id);

      for (const roomId in rooms) {
        const room = rooms[roomId];
        if (!leaveRoom(room, socket.id)) continue;

        socket.to(roomId).emit("user-disconnected", socket.id);

        if (isEmpty(room)) {
          delete rooms[roomId]; // prevents a memory leak from abandoned rooms
        } else {
          io.to(roomId).emit("state-update", room);
        }
      }
    });
  });

  return { app, httpServer, io, rooms };
}
