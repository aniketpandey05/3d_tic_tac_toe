import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import Game from "./components/Game";
import CubeGrid from "./components/CubeGrid";
import LandingPage from "./components/LandingPage";

export default function App() {
  // The URL is the room: /?room=abc123 opens the game, a bare / shows the landing page
  const roomId = new URLSearchParams(window.location.search).get("room")?.trim();

  if (!roomId) return <LandingPage />;

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <Game roomId={roomId}>
        {({ board, handleMove, winnerInfo, activeLayer, playerSymbol, currentTurn }) => (
          <Canvas
            camera={{ position: [5, 5, 5], fov: 50 }}
            style={{ position: "absolute", inset: 0 }}
          >
            <ambientLight intensity={0.6} />
            <directionalLight position={[5, 5, 5]} />

            <CubeGrid
              board={board}
              onCellClick={handleMove}
              winnerInfo={winnerInfo}
              activeLayer={activeLayer}
              playerSymbol={playerSymbol}
              currentTurn={currentTurn}
            />

            <OrbitControls enablePan={false} enableDamping />
          </Canvas>
        )}
      </Game>
    </div>
  );
}
