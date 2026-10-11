import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { WIN_LINES } from "../winLines.js";
import { WIN_LINES as CLIENT_WIN_LINES } from "../../client/src/game/winLines.js";
import {
  createRoom,
  checkWinner,
  joinRoom,
  applyMove,
  resetGame,
  leaveRoom,
  isEmpty,
} from "../game.js";

const idx = (x, y, z) => x * 9 + y * 3 + z;

// Seats X and O and returns the room
function twoPlayerRoom() {
  const room = createRoom();
  joinRoom(room, "x");
  joinRoom(room, "o");
  return room;
}

// Plays alternating X/O moves from a list of cell indexes
function play(room, cells) {
  cells.forEach((cell, i) => {
    const result = applyMove(room, i % 2 === 0 ? "x" : "o", cell);
    assert.equal(result.ok, true, `move ${i} at ${cell} should be legal`);
  });
}

describe("win lines", () => {
  test("there are exactly 49 lines", () => {
    assert.equal(WIN_LINES.length, 49);
  });

  test("every line has 3 distinct in-range cells", () => {
    for (const line of WIN_LINES) {
      assert.equal(new Set(line).size, 3);
      for (const cell of line) assert.ok(cell >= 0 && cell < 27);
    }
  });

  test("no line is listed twice", () => {
    const keys = WIN_LINES.map((l) => [...l].sort((a, b) => a - b).join(","));
    assert.equal(new Set(keys).size, 49);
  });

  test("the centre cell is on 13 lines", () => {
    const centre = idx(1, 1, 1);
    assert.equal(WIN_LINES.filter((l) => l.includes(centre)).length, 13);
  });

  test("client and server copies are identical", () => {
    assert.deepEqual(CLIENT_WIN_LINES, WIN_LINES);
  });
});

describe("checkWinner", () => {
  test("empty board has no winner", () => {
    assert.equal(checkWinner(Array(27).fill(null)), null);
  });

  test("detects every one of the 49 lines for both symbols", () => {
    for (const symbol of ["X", "O"]) {
      for (const line of WIN_LINES) {
        const board = Array(27).fill(null);
        line.forEach((c) => (board[c] = symbol));
        assert.deepEqual(checkWinner(board), { winner: symbol, line });
      }
    }
  });

  test("mixed symbols on a line are not a win", () => {
    const board = Array(27).fill(null);
    board[idx(0, 0, 0)] = "X";
    board[idx(0, 0, 1)] = "O";
    board[idx(0, 0, 2)] = "X";
    assert.equal(checkWinner(board), null);
  });

  test("space diagonal through the centre wins", () => {
    const board = Array(27).fill(null);
    [idx(0, 0, 0), idx(1, 1, 1), idx(2, 2, 2)].forEach((c) => (board[c] = "O"));
    assert.equal(checkWinner(board).winner, "O");
  });
});

describe("seats and roles", () => {
  test("first joiner is X, second is O, third is told the room is full", () => {
    const room = createRoom();
    assert.deepEqual(joinRoom(room, "a"), { role: "X" });
    assert.deepEqual(joinRoom(room, "b"), { role: "O" });
    assert.deepEqual(joinRoom(room, "c"), { full: true });
  });

  test("asking to spectate always succeeds", () => {
    const room = twoPlayerRoom();
    assert.deepEqual(joinRoom(room, "s", true), { role: "spectator" });
    assert.deepEqual(room.spectators, ["s"]);
  });

  test("rejoining does not take a second seat", () => {
    const room = createRoom();
    joinRoom(room, "a");
    assert.deepEqual(joinRoom(room, "a"), { role: "X" });
    assert.deepEqual(room.players, ["a", null]);
  });

  test("when X leaves, O keeps its symbol and the next joiner becomes X", () => {
    const room = twoPlayerRoom();
    leaveRoom(room, "x");
    assert.deepEqual(room.players, [null, "o"]);
    assert.deepEqual(joinRoom(room, "new"), { role: "X" });
    assert.deepEqual(room.players, ["new", "o"]);
  });

  test("room is empty only when no players and no spectators remain", () => {
    const room = twoPlayerRoom();
    joinRoom(room, "s", true);
    leaveRoom(room, "x");
    leaveRoom(room, "o");
    assert.equal(isEmpty(room), false);
    leaveRoom(room, "s");
    assert.equal(isEmpty(room), true);
  });

  test("leaveRoom reports whether the socket was in the room", () => {
    const room = twoPlayerRoom();
    assert.equal(leaveRoom(room, "stranger"), false);
    assert.equal(leaveRoom(room, "x"), true);
  });
});

describe("applyMove validation", () => {
  test("a legal move places the symbol and passes the turn", () => {
    const room = twoPlayerRoom();
    assert.deepEqual(applyMove(room, "x", 13), { ok: true });
    assert.equal(room.board[13], "X");
    assert.equal(room.playerTurn, "O");
  });

  for (const bad of [-1, 27, 99, 1.5, "4", null, undefined, NaN]) {
    test(`rejects invalid index ${String(bad)}`, () => {
      const room = twoPlayerRoom();
      assert.deepEqual(applyMove(room, "x", bad), { ok: false, reason: "invalid-index" });
      assert.equal(room.board.length, 27);
      assert.ok(room.board.every((c) => c === null));
    });
  }

  test("rejects a move out of turn", () => {
    const room = twoPlayerRoom();
    assert.equal(applyMove(room, "o", 0).reason, "not-your-turn");
  });

  test("rejects a move on an occupied cell", () => {
    const room = twoPlayerRoom();
    applyMove(room, "x", 0);
    assert.equal(applyMove(room, "o", 0).reason, "cell-taken");
  });

  test("rejects moves from spectators and strangers", () => {
    const room = twoPlayerRoom();
    joinRoom(room, "s", true);
    assert.equal(applyMove(room, "s", 0).reason, "not-a-player");
    assert.equal(applyMove(room, "stranger", 0).reason, "not-a-player");
  });

  test("a win ends the game, records the line and updates the score", () => {
    const room = twoPlayerRoom();
    // X: 0, 1, 2 (a row along z)   O: 9, 10
    play(room, [0, 9, 1, 10, 2]);
    assert.deepEqual(room.winner, { winner: "X", line: [0, 1, 2] });
    assert.deepEqual(room.scores, { X: 1, O: 0, draws: 0 });
    assert.equal(applyMove(room, "o", 20).reason, "game-over");
  });
});

describe("resetGame", () => {
  test("clears the board but keeps the series score", () => {
    const room = twoPlayerRoom();
    play(room, [0, 9, 1, 10, 2]);
    assert.deepEqual(resetGame(room, "o"), { ok: true });
    assert.ok(room.board.every((c) => c === null));
    assert.equal(room.playerTurn, "X");
    assert.equal(room.winner, null);
    assert.equal(room.scores.X, 1);
  });

  test("spectators cannot reset", () => {
    const room = twoPlayerRoom();
    joinRoom(room, "s", true);
    applyMove(room, "x", 0);
    assert.equal(resetGame(room, "s").reason, "not-a-player");
    assert.equal(room.board[0], "X");
  });
});
