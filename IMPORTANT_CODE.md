# Important and Difficult Code in This Project

This document explains the parts of the codebase that are most worth understanding deeply.

It is not just a list of files. The goal is to explain:

- what each important block of code is doing
- why it was written that way
- what bug or system problem it solves
- how you can explain it in an interview

The highest-value files are:

- `server/game.js` (the rules)
- `server/app.js` (the socket server)
- `client/src/components/Game.jsx`
- `client/src/components/CubeGrid.jsx`
- `client/src/components/VideoChat.jsx`
- `client/src/game/winLines.js`

## 1. The Main Design Idea

The project looks like a game, but technically it is a small real-time system.

There are three big parts working together:

- the **game model**
- the **multiplayer synchronization**
- the **video connection**

The most important design choice is this:

> The client renders the game, but the server owns the truth.

That means the browser is allowed to:

- show the board
- let the user click
- display the score
- preview whose turn it is

But the browser is **not** trusted to decide:

- whether a move is valid
- who the real players are
- whether a spectator can act
- whether someone has won

That trust boundary is one of the strongest parts of the project.

## 2. The Server: The Real Brain of the Game

The server is split into three small files, each with one job:

| File | Job |
|---|---|
| `server/game.js` | The **rules**. Plain functions with no networking: `createRoom`, `joinRoom`, `applyMove`, `resetGame`, `leaveRoom`. |
| `server/app.js` | The **messenger**. Listens for socket events, calls the rules, and broadcasts the result. |
| `server/index.js` | The **on switch**. Reads environment variables and starts listening on a port. |

Keeping the rules separate means they can be tested without starting a server (see `server/test/`).

Together, these files are responsible for:

- creating rooms
- storing live match state
- assigning `X`, `O`, and spectators
- validating moves
- deciding wins and draws
- keeping match scores
- cleaning up disconnects
- forwarding WebRTC signaling messages

So even though the frontend looks visually complex, this file is the actual game authority.

### The room state (`createRoom` in `server/game.js`)

```js
export function createRoom() {
  return {
    board: Array(BOARD_SIZE).fill(null),
    playerTurn: "X",
    players: [null, null], // fixed seats: [X, O], null = empty seat
    spectators: [],
    winner: null,
    scores: { X: 0, O: 0, draws: 0 },
  };
}
```

### What this means

Each room is stored as one in-memory object.

That object contains everything needed to resume and broadcast the current game:

- `board`: the 27-cell cube
- `playerTurn`: whose move is next
- `players`: two fixed seats, `[X's socket id, O's socket id]`, with `null` for an empty seat
- `spectators`: extra users who can watch but not act
- `winner`: final result once the game ends
- `scores`: running totals across resets

This is important because the server is not saving isolated values in random places. It keeps one clear state object per room.

That makes the code easier to reason about and easier to broadcast.

## 3. How Moves Are Actually Stored

One common question is: where do the `X` and `O` values really live?

They are stored on the server inside the room's `board` array.

```js
room.board[index] = symbol;
```

Here:

- `symbol` is either `"X"` or `"O"`
- `index` is the clicked cell number from `0` to `26`

An empty cell is just:

```js
null
```

So a board might look like:

```js
[
  "X", null, null,
  "O", "X", null,
  null, null, "O",
  ...
]
```

### Why this is a good design

This is simple and efficient:

- arrays are easy to update
- arrays are easy to send through sockets
- arrays are easy to check for wins
- arrays are easy to render in React

The frontend also keeps a copy in React state, but that copy is only for display. The real version is the server one.

## 4. The Most Important Security and Correctness Block

`applyMove` in `server/game.js` is one of the best examples of good multiplayer logic:

```js
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
  // ...then check for a win or draw, or pass the turn
```

### What this code is doing

Before writing a move, the server checks (the room's existence is checked in `app.js` first):

1. is `index` a real cell number from 0 to 26?
2. is this socket one of the actual players?
3. has the game already ended?
4. is it really this player's turn?
5. is the target cell empty?

Each rejection returns a **reason**, which makes the rules easy to test: the tests check that a spectator's move returns `"not-a-player"`, and so on.

Only after all of those checks does it write the move.

### Why this code matters

Without this block, users could cheat by:

- playing as spectators
- playing twice in a row
- overwriting existing marks
- sending fake moves from the browser console
- sending a made-up cell number like `99` to break the board

This is why server-authoritative logic is such a strong design choice. The frontend helps the user, but the backend enforces the rules.

## 5. Room Roles: Why `X`, `O`, and `spectator` Matter

This code looks small, but it affects the whole app:

```js
export function getRole(room, socketId) {
  const seat = room.players.indexOf(socketId);
  if (seat === 0) return "X";
  if (seat === 1) return "O";
  return "spectator";
}
```

### What this code is doing

The server checks which **seat** the socket sits in:

- seat 0 is `X`
- seat 1 is `O`
- everyone else is a `spectator`

The seats are **fixed**. When a player leaves, their seat becomes `null` instead of being removed. An earlier version removed them from the array, which shifted O into X's seat mid-game and broke the game. Fixed seats mean a player's symbol can never change under them.

### Why this is important

That one decision affects:

- who is allowed to move
- who can reset the game
- what label the UI shows
- how video streams are grouped

So the role assignment is not just cosmetic. It drives permissions and behavior across the whole project.

## 6. `Game.jsx`: The Frontend State Bridge

`Game.jsx` is the file that connects the socket layer to the UI layer.

It does not render the 3D board itself, and it does not decide official game results. Its job is to keep the frontend synchronized with the backend.

### The state update listener

```js
socket.on("state-update", (state) => {
  setBoard(state.board);
  setPlayer(state.playerTurn);
  setWinnerInfo(state.winner || null);
  setScores(state.scores || { X: 0, O: 0, draws: 0 });
  setSpectatorCount(state.spectators ? state.spectators.length : 0);
  setPlayersList(state.players || []);
});
```

### What this code is doing

Whenever the server broadcasts the latest room state, `Game.jsx` copies that data into React state.

That causes the rest of the app to update:

- the board rerenders
- the turn label changes
- the score panel updates
- the spectator count changes
- the video component knows who the players are

### Why this file is important

This file acts like the translator between two worlds:

- socket events from the server
- component props for the frontend

That makes it one of the most important architectural files in the client.

## 7. Why the Listener Is Attached Before `join-room`

This sequence in `Game.jsx` is subtle but important:

```js
socket.on("player-assigned", ...)
socket.on("state-update", ...)
socket.on("room-full", ...)

socket.emit("join-room", { roomId });
```

### Why this matters

If the client emitted `join-room` first and only attached listeners afterward, there is a chance the server could respond before the client is ready.

That would create timing bugs like:

- missing the assigned role
- missing the first board state
- not reacting to a full room correctly

So the order here is intentional:

1. get ready to hear the answer
2. then send the request

This is a good example of defensive real-time programming.

## 8. Frontend Validation vs Backend Validation

In `Game.jsx`, the move handler does some early checks:

```js
const handleMove = (index) => {
  if (!playerSymbol) return;
  if (board[index] || winnerInfo) return;
  if (player !== playerSymbol) return;

  socket.emit("make-move", {
    roomId,
    index,
  }, []);
};
```

### What this code is doing

The client blocks obviously bad clicks before sending them:

- if you do not yet have a role
- if the cell is already occupied
- if the game is already over
- if it is not your turn

### Why this is useful

This improves the user experience because it avoids unnecessary socket calls.

But this is not the real protection layer.

The **server still repeats the checks**, because frontend checks are only convenience. Backend checks are security and correctness.

That distinction is worth explaining in interviews.

## 9. `winLines.js`: Turning a 3D Problem Into Simple Data

This file is one of the smartest pieces of the project because it takes a complicated geometry problem and turns it into plain arrays.

The 3D board has 27 cells, and a win can happen in many directions:

- along one row
- along one column
- through depth
- across diagonals on a plane
- across diagonals through the whole cube

### The key helper

```js
const idx = (x, y, z) => x * 9 + y * 3 + z;
```

### What this means

The cube is visually 3D, but the code stores it in a flat array.

This helper converts:

- `x`, `y`, `z` coordinates

into:

- one array index from `0` to `26`

### Why this is important

This is what makes the entire architecture practical.

Instead of storing a deeply nested 3D structure, the project can:

- keep the data simple
- reuse the same indexes everywhere
- send the board over sockets easily
- match rendering and logic consistently

## 10. How Winning Lines Are Generated

A win line is just three indexes that form a straight valid line in the cube.

Example:

```js
[0, 1, 2]
```

That means:

- if `board[0]`, `board[1]`, and `board[2]` are all the same non-null symbol
- that is a win

### Example generator

```js
for (let x = 0; x < 3; x++) {
  for (let y = 0; y < 3; y++) {
    WIN_LINES.push([
      idx(x, y, 0),
      idx(x, y, 1),
      idx(x, y, 2),
    ]);
  }
}
```

### What this code is doing

For every fixed `x` and `y`, it creates one line that moves across `z`.

In other words, it generates all straight lines in one cube direction.

The rest of the file does the same for:

- other axes
- plane diagonals
- space diagonals

### Why this design is strong

Instead of recalculating geometry after every move, the project calculates all valid wins once up front.

Then winner checking becomes simple.

## 11. Winner Checking Becomes Very Small Because of `WIN_LINES`

Once the winning lines are already prepared, the actual winner check is short:

```js
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
```

### Why this is elegant

This code is readable because the hard part was already solved earlier.

The file does not need to "understand 3D" at runtime anymore. It just loops through known valid lines.

That is a strong example of moving complexity out of the hot path and into setup data.

## 12. `CubeGrid.jsx`: Connecting Data to 3D Space

This file is where the board becomes visible.

It takes flat array data and maps it into a 3D arrangement of cube cells.

### The key mapping line

```js
const index = x * 9 + y * 3 + z;
```

### Why this matters

This must match the same indexing logic used in `winLines.js`.

If these formulas were different, the whole game would break:

- clicks would target the wrong cell
- winner highlighting would be wrong
- the rendered board would not match the server data

So this line is small, but it is foundational.

## 13. Why `CubeGrid.jsx` Is Harder Than It Looks

Each cell is not just "draw a box."

The component also handles:

- hover behavior
- click behavior
- layer dimming
- winner highlighting
- ghost previews
- smooth color animation
- slight scaling animation

### Example click handler

```js
onPointerDown={(e) => {
  e.stopPropagation();
  onCellClick(index);
}}
```

### What this code is doing

The cell itself does not talk to the socket.

It only reports:

- which cell was clicked

Then `Game.jsx` decides whether to send the move request.

### Why this separation is good

It keeps responsibilities clean:

- `CubeGrid.jsx` handles 3D interaction
- `Game.jsx` handles networking and game state flow

That separation keeps the code easier to maintain.

## 14. `VideoChat.jsx`: The Hardest Frontend File

This is probably the most difficult file in the client because WebRTC is inherently more fragile than normal UI code.

This file handles:

- camera/microphone access
- peer connection creation
- offer/answer exchange
- ICE candidate handling
- retry behavior
- connection status
- remote stream tracking
- spectator and player stream grouping

### Why this is difficult

WebRTC is hard because many asynchronous systems are happening together:

- browser media permissions
- socket signaling
- ICE negotiation
- remote peer timing
- disconnect cleanup

The difficult part is not any one API call. The difficult part is managing the order of events safely.

## 15. The Signaling Layer

WebRTC peers cannot connect by magic. They first need to exchange setup data.

This project uses Socket.IO to carry that setup data.

### Client-side examples

```js
socket.emit("webrtc-offer", { targetId, offer });
socket.emit("webrtc-answer", { targetId: senderId, answer });
socket.emit("webrtc-ice-candidate", { targetId, candidate: event.candidate });
```

### Server-side forwarding (`server/app.js`)

```js
socket.on("webrtc-offer", ({ targetId, offer }) => {
  io.to(targetId).emit("webrtc-offer", { senderId: socket.id, offer });
});
```

### Why this is important

The server is not streaming the video itself.

Its job is only to forward the negotiation messages so the browsers can establish a direct connection.

That is a very useful architectural detail to explain:

- Socket.IO is the signaling path
- WebRTC is the media path

## 16. The Pending Signal Queue

One of the best pieces of defensive code in `VideoChat.jsx` is this:

```js
if (isReadyRef.current) {
  processSignal(type, data);
} else {
  pendingSignalsRef.current.push({ type, data });
}
```

Later:

```js
isReadyRef.current = true;
while (pendingSignalsRef.current.length > 0) {
  const { type, data } = pendingSignalsRef.current.shift();
  processSignal(type, data);
}
```

### What problem this solves

Sometimes socket events arrive before:

- local camera/mic setup finishes
- peer objects are created
- WebRTC initialization is ready

If the app processed those events immediately, some connections could fail randomly.

So the component temporarily stores the signals and replays them later once setup is complete.

### Why this is a strong piece of code

This is not just API usage. It is solving a timing race in a real-time system.

That is exactly the kind of detail interviewers like to hear.

## 17. The ICE Candidate Queue

Another subtle WebRTC problem is that ICE candidates may arrive before the remote description has been set.

This code handles that:

```js
if (peerObj.remoteDescSet) {
  await peerObj.peer.addIceCandidate(new RTCIceCandidate(candidate));
} else {
  peerObj.iceQueue.push(candidate);
}
```

Then later:

```js
while (peerObj.iceQueue.length > 0) {
  const candidate = peerObj.iceQueue.shift();
  await peerObj.peer.addIceCandidate(new RTCIceCandidate(candidate));
}
```

### Why this matters

If you try to add ICE candidates too early, WebRTC can throw errors or fail to connect properly.

So the code delays them until the peer is ready.

This is one of the most technically difficult pieces in the project because it handles out-of-order network events correctly.

## 18. Retry Logic

Real-time connections do not always succeed on the first try, especially across different networks.

This retry block is important:

```js
if (currentRetries < MAX_RETRIES) {
  retriesRef.current.set(targetId, currentRetries + 1);
  setPeerStatuses(prev => ({ ...prev, [targetId]: "retrying" }));

  removePeer(targetId);
  setTimeout(() => {
    if (socket.id > targetId) {
      createOfferRef.current(targetId);
    }
  }, 1000 + Math.random() * 500);
}
```

### What this code is doing

When a connection fails:

- the retry count increases
- UI status changes to retrying
- the old peer is removed
- a new offer is attempted after a short delay

### Why this is a good idea

This makes the video feature more robust in real-world usage.

Without this, the feature would work only in ideal conditions.

## 19. TURN and STUN Fallbacks

WebRTC often needs ICE servers to help peers discover workable network paths.

This project handles that carefully.

### Server-side fallback

```js
// server/app.js
if (!apiKey) {
  log.warn("[TURN] No METERED_API_KEY set — falling back to STUN-only");
  return STUN_FALLBACK; // public Google STUN servers
}
```

### Client-side fallback

```js
const FALLBACK_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
];
```

### Why this matters

This gives the app graceful degradation:

- with TURN credentials, connectivity is better across networks
- without them, the app can still try to connect using public STUN servers

That is a practical production-minded choice.

## 20. The Best Way to Explain the Hard Parts

If someone asks what code in this project was genuinely difficult, the best answer is:

1. The server-side move validation, because it had to enforce turn order, permissions, and board correctness.
2. The 3D win-line system, because the board is visually a cube but logically stored as a flat array.
3. The WebRTC timing logic, because offers, answers, ICE candidates, and media setup can happen out of order.
4. The room and spectator model, because real-time apps need permission boundaries and disconnect cleanup.

## 21. Short Interview Version

You can explain the important code like this:

> "The most important code is in the server-authoritative game loop and the WebRTC connection flow. On the game side, the server owns room state, validates every move, prevents spectators from acting, and checks wins using precomputed 3D win lines. On the frontend, the tricky parts are mapping the cube into a flat 27-cell array and handling WebRTC timing issues with queued signals, ICE buffering, and retry logic."
