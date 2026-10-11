import { io } from "socket.io-client";

// Set VITE_SERVER_URL in client/.env (see .env.example) to point at a local server.
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL || "https://threed-tic-tac-toe-rnxj.onrender.com";

// One shared connection per tab: the game and the video chat use the same socket id,
// which is how the server links "player X" to "this video peer".
const socket = io(SERVER_URL, {
  transports: ["websocket"],
  withCredentials: false,
});

export default socket;
