// End-to-end tests over real Socket.IO connections against a server on a random port.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { io as connect } from "socket.io-client";

import { createGameServer } from "../app.js";

let server;
let url;
const clients = [];

before(async () => {
  server = createGameServer({ quiet: true });
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  url = `http://127.0.0.1:${server.httpServer.address().port}`;
});

after(async () => {
  clients.forEach((c) => c.disconnect());
  server.io.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
});

// Resolves with the next payload of `event`, or rejects after `ms`
function next(socket, event, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// Resolves true if `event` does NOT arrive within `ms`
function silent(socket, event, ms = 300) {
  return new Promise((resolve) => {
    const handler = () => resolve(false);
    socket.once(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve(true);
    }, ms);
  });
}

async function client() {
  const socket = connect(url, { transports: ["websocket"], forceNew: true });
  clients.push(socket);
  await next(socket, "connect");
  return socket;
}

// Connects a client, joins the room, and returns { socket, role }
async function join(roomId, asSpectator = false) {
  const socket = await client();
  const assigned = next(socket, "player-assigned");
  socket.emit("join-room", { roomId, asSpectator });
  return { socket, role: await assigned };
}

let roomCounter = 0;
const newRoomId = () => `room-${process.pid}-${++roomCounter}`;

describe("socket server", () => {
  test("assigns X then O, and the room appears in state", async () => {
    const roomId = newRoomId();
    const x = await join(roomId);
    const o = await join(roomId);
    assert.equal(x.role, "X");
    assert.equal(o.role, "O");
    assert.deepEqual(server.rooms[roomId].players, [x.socket.id, o.socket.id]);
  });

  test("a third player gets room-full and can then spectate", async () => {
    const roomId = newRoomId();
    await join(roomId);
    await join(roomId);

    const third = await client();
    const full = next(third, "room-full");
    third.emit("join-room", { roomId });
    await full;

    const assigned = next(third, "player-assigned");
    third.emit("join-room", { roomId, asSpectator: true });
    assert.equal(await assigned, "spectator");
  });

  test("a valid move is broadcast to everyone in the room", async () => {
    const roomId = newRoomId();
    const x = await join(roomId);
    const o = await join(roomId);

    const update = next(o.socket, "state-update");
    x.socket.emit("make-move", { roomId, index: 13 });
    const state = await update;

    assert.equal(state.board[13], "X");
    assert.equal(state.playerTurn, "O");
  });

  test("out-of-turn, invalid and spectator moves are ignored", async () => {
    const roomId = newRoomId();
    const x = await join(roomId);
    const o = await join(roomId);
    const s = await join(roomId, true);
    await new Promise((r) => setTimeout(r, 100)); // let the spectator's join broadcast settle

    o.socket.emit("make-move", { roomId, index: 0 });       // not O's turn
    x.socket.emit("make-move", { roomId, index: 99 });      // out of range
    x.socket.emit("make-move", { roomId, index: "foo" });   // wrong type
    s.socket.emit("make-move", { roomId, index: 0 });       // spectator
    s.socket.emit("reset-game", { roomId });                // spectator reset

    assert.equal(await silent(x.socket, "state-update"), true);
    assert.ok(server.rooms[roomId].board.every((c) => c === null));
    assert.equal(server.rooms[roomId].board.length, 27);
  });

  test("when X disconnects, O keeps its seat and a newcomer becomes X", async () => {
    const roomId = newRoomId();
    const x = await join(roomId);
    const o = await join(roomId);

    const xId = x.socket.id; // socket.id is cleared on disconnect
    const gone = next(o.socket, "user-disconnected");
    x.socket.disconnect();
    assert.equal(await gone, xId);
    assert.deepEqual(server.rooms[roomId].players, [null, o.socket.id]);

    const newcomer = await join(roomId);
    assert.equal(newcomer.role, "X");
  });

  test("the room is deleted once everyone leaves", async () => {
    const roomId = newRoomId();
    const x = await join(roomId);
    const o = await join(roomId);

    x.socket.disconnect();
    const gone = next(o.socket, "disconnect");
    o.socket.disconnect();
    await gone;
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(server.rooms[roomId], undefined);
  });

  test("the new joiner receives existing users; others get user-joined", async () => {
    const roomId = newRoomId();
    const x = await join(roomId);

    const o = await client();
    const allUsers = next(o, "all-users");
    const joined = next(x.socket, "user-joined");
    o.emit("join-room", { roomId });

    assert.deepEqual(await allUsers, [x.socket.id]);
    assert.equal(await joined, o.id);
  });

  test("WebRTC signals are relayed only to the target, stamped with the sender", async () => {
    const roomId = newRoomId();
    const x = await join(roomId);
    const o = await join(roomId);
    const s = await join(roomId, true);

    const received = next(o.socket, "webrtc-offer");
    const notForSpectator = silent(s.socket, "webrtc-offer");
    x.socket.emit("webrtc-offer", { targetId: o.socket.id, offer: { type: "offer", sdp: "test" } });

    assert.deepEqual(await received, {
      senderId: x.socket.id,
      offer: { type: "offer", sdp: "test" },
    });
    assert.equal(await notForSpectator, true);
  });

  test("get-turn-credentials replies through the acknowledgement", async () => {
    const socket = await client();
    const data = await new Promise((resolve) => socket.emit("get-turn-credentials", resolve));
    assert.ok(Array.isArray(data.iceServers));
    assert.ok(data.iceServers.length > 0);
  });

  test("GET /health responds", async () => {
    const res = await fetch(`${url}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });
});
