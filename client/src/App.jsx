import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import Game from "./components/Game";
import CubeGrid from "./components/CubeGrid";

export default function App() {
  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <Game>
        {({ board, handleMove, winnerInfo, activeLayer, playerSymbol, currentTurn }) => (
<Canvas
  camera={{ position: [5, 5, 5], fov: 50 }}
  style={{ position: "absolute", inset: 0 }}
>            <ambientLight intensity={0.6} />
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
