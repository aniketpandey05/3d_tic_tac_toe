import { createGameServer } from "./app.js";

// Comma-separated list of allowed frontend origins, e.g.
// CLIENT_ORIGIN=https://my-game.vercel.app,http://localhost:5173
// Unset means any origin (handy for local development).
const corsOrigin = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(",").map((o) => o.trim())
  : "*";

const { httpServer } = createGameServer({
  corsOrigin,
  meteredApiKey: process.env.METERED_API_KEY || "",
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
