// Pure game rules: no sockets, no I/O.
// Keeping these separate from index.js makes every rule unit-testable.

import { WIN_LINES } from "./winLines.js";

export const BOARD_SIZE = 27;

export function createRoom() {
  return {
    board: Array(BOARD_SIZE).fill(null),
    playerTurn: "X",
    // Fixed seats: index 0 = X, index 1 = O, null = empty seat.
    // Seats are never shifted, so a player keeps their symbol if the other leaves.
    players: [null, null],
    spectators: [],
    winner: null,
    scores: { X: 0, O: 0, draws: 0 },
  };
}

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

export function getRole(room, socketId) {
  const seat = room.players.indexOf(socketId);
  if (seat === 0) return "X";
  if (seat === 1) return "O";
  return "spectator";
}

// Seats a socket as a player or spectator.
// Returns { role } on success, or { full: true } when both seats are taken.
export function joinRoom(room, socketId, asSpectator = false) {
  const alreadyIn =
    room.players.includes(socketId) || room.spectators.includes(socketId);

  if (!alreadyIn) {
    const freeSeat = room.players.indexOf(null);
    if (asSpectator) {
      room.spectators.push(socketId);
    } else if (freeSeat !== -1) {
      room.players[freeSeat] = socketId;
    } else {
      return { full: true };
    }
  }

  return { role: getRole(room, socketId) };
}

// Validates and applies a move. Returns { ok: true } or { ok: false, reason }.
export function applyMove(room, socketId, index) {
  if (!Number.isInteger(index) || index < 0 || index >= BOARD_SIZE) {
    return { ok: false, reason: "invalid-index" };
  }

  const symbol = getRole(room, socketId);
  if (symbol === "spectator") return { ok: false, reason: "not-a-player" };
  if (room.winner) return { ok: false, reason: "game-over" };
  if (room.playerTurn !== symbol) return { ok: false, reason: "not-your-turn" };
  if (room.board[index]) return { ok: false, reason: "cell-taken" };

  room.board[index] = symbol;

  const result = checkWinner(room.board);
  if (result) {
    room.winner = result;
    room.scores[result.winner] += 1;
  } else if (room.board.every((cell) => cell !== null)) {
    // Unreachable on a 3×3×3 board (a full board always contains a line),
    // kept so the engine stays correct if the board size ever changes.
    room.winner = { winner: "Draw", line: [] };
    room.scores.draws += 1;
  } else {
    room.playerTurn = symbol === "X" ? "O" : "X";
  }

  return { ok: true };
}

// Clears the board but keeps the series score. Players only.
export function resetGame(room, socketId) {
  if (!room.players.includes(socketId)) {
    return { ok: false, reason: "not-a-player" };
  }

  room.board = Array(BOARD_SIZE).fill(null);
  room.playerTurn = "X";
  room.winner = null;
  return { ok: true };
}

// Frees the socket's seat (or spectator slot). Returns true if it was in the room.
export function leaveRoom(room, socketId) {
  const wasMember =
    room.players.includes(socketId) || room.spectators.includes(socketId);

  room.players = room.players.map((id) => (id === socketId ? null : id));
  room.spectators = room.spectators.filter((id) => id !== socketId);

  return wasMember;
}

export function isEmpty(room) {
  return room.players.every((id) => id === null) && room.spectators.length === 0;
}
