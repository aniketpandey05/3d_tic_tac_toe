import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import socket from "../network/socket";
import useDraggable from "../hooks/useDraggable";
import "./VideoChat.css";

// ─── Fallback ICE config (STUN only) ─
const FALLBACK_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
];

const MAX_RETRIES = 2;
const ICE_TIMEOUT_MS = 15000;

export default function VideoChat({ playersList = [], playerSymbol }) {
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [localStream, setLocalStream] = useState(null);

  const { position, dragHandlers } = useDraggable();

  // Mesh Network State
  const localStreamRef = useRef(null);
  const iceServersRef = useRef(FALLBACK_ICE_SERVERS);
  const peersRef = useRef(new Map());
  const timeoutsRef = useRef(new Map());
  const retriesRef = useRef(new Map());
  const isReadyRef = useRef(false);
  const pendingSignalsRef = useRef([]);

  const [remoteStreams, setRemoteStreams] = useState([]);
  const [peerStatuses, setPeerStatuses] = useState({});

  // --- UI STATUS ---
  const statusConfig = {
    waiting: { label: "Waiting for opponent…", color: "var(--text-muted)", dotColor: "#888", animated: false },
    connecting: { label: "Connecting…", color: "var(--warning)", dotColor: "#f5a623", animated: true },
    retrying: { label: "Retrying…", color: "var(--warning)", dotColor: "#f5a623", animated: true },
    connected: { label: "Connected", color: "var(--success)", dotColor: "#4caf50", animated: false },
    failed: { label: "Failed", color: "var(--danger)", dotColor: "#e53935", animated: false },
  };

  const overallStatus = useMemo(() => {
    const statuses = Object.values(peerStatuses);
    if (statuses.length === 0) return "waiting";
    if (statuses.includes("failed")) return "failed";
    if (statuses.includes("retrying")) return "retrying";
    if (statuses.includes("connecting")) return "connecting";
    return "connected";
  }, [peerStatuses]);

  const { label: statusLabel, color: statusColor, dotColor, animated: dotAnimated } = statusConfig[overallStatus];

  const toggleMute = () => {
    const audioTrack = localStreamRef.current?.getTracks().find(t => t.kind === "audio");
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setIsMuted(!audioTrack.enabled);
    }
  };

  const toggleCamera = () => {
    const videoTrack = localStreamRef.current?.getTracks().find(t => t.kind === "video");
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      setIsCameraOff(!videoTrack.enabled);
    }
  };

  const clearIceTimeout = useCallback((targetId) => {
    const timeoutId = timeoutsRef.current.get(targetId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutsRef.current.delete(targetId);
    }
  }, []);

  const removePeer = useCallback((id) => {
    console.log(`[MESH] Removing peer ${id}`);
    clearIceTimeout(id);
    const peerObj = peersRef.current.get(id);
    if (peerObj) {
      peerObj.peer.close();
      peersRef.current.delete(id);
    }
    setRemoteStreams(prev => prev.filter(s => s.id !== id));
    setPeerStatuses(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, [clearIceTimeout]);

  const createOfferRef = useRef(null);

  const getPeerObj = useCallback((targetId) => {
    if (!peersRef.current.has(targetId)) {
      console.log(`[MESH] Creating new peer for target: ${targetId}`);

      const peer = new RTCPeerConnection({
        iceServers: iceServersRef.current,
        iceCandidatePoolSize: 10,
      });
      const peerObj = { peer, iceQueue: [], remoteDescSet: false };
      peersRef.current.set(targetId, peerObj);

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => {
          peer.addTrack(track, localStreamRef.current);
        });
      }

      peer.ontrack = (event) => {
        console.log(`[MESH] Track received from ${targetId}, kind:`, event.track.kind);
        setRemoteStreams(prev => {
          if (prev.find(s => s.id === targetId)) {
            return prev;
          }
          return [...prev, { id: targetId, stream: event.streams[0] }];
        });
      };

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("webrtc-ice-candidate", { targetId, candidate: event.candidate });
        }
      };

      const handleRetry = () => {
        const currentRetries = retriesRef.current.get(targetId) || 0;
        if (currentRetries < MAX_RETRIES) {
          console.warn(`[MESH] Retrying connection to ${targetId} (Attempt ${currentRetries + 1})`);
          retriesRef.current.set(targetId, currentRetries + 1);
          setPeerStatuses(prev => ({ ...prev, [targetId]: "retrying" }));

          removePeer(targetId);
          setTimeout(() => {
            if (socket.id > targetId) {
              createOfferRef.current(targetId);
            }
          }, 1000 + Math.random() * 500);
        } else {
          console.error(`[MESH] ❌ All retries exhausted for ${targetId}`);
          setPeerStatuses(prev => ({ ...prev, [targetId]: "failed" }));
          clearIceTimeout(targetId);
        }
      };

      const startIceTimeout = () => {
        clearIceTimeout(targetId);
        const timeoutId = setTimeout(() => {
          if (peer.iceConnectionState !== "connected" && peer.iceConnectionState !== "completed") {
            console.warn(`[MESH] ⏰ ICE timeout after ${ICE_TIMEOUT_MS}ms for ${targetId}`);
            handleRetry();
          }
        }, ICE_TIMEOUT_MS);
        timeoutsRef.current.set(targetId, timeoutId);
      };

      peer.oniceconnectionstatechange = () => {
        const state = peer.iceConnectionState;
        console.log(`[MESH] Peer ${targetId} ICE state:`, state);

        switch (state) {
          case "checking":
            setPeerStatuses(prev => ({ ...prev, [targetId]: "connecting" }));
            startIceTimeout();
            break;
          case "connected":
          case "completed":
            setPeerStatuses(prev => ({ ...prev, [targetId]: "connected" }));
            clearIceTimeout(targetId);
            retriesRef.current.set(targetId, 0);
            break;
          case "failed":
            handleRetry();
            break;
          case "disconnected":
            setPeerStatuses(prev => ({ ...prev, [targetId]: "connecting" }));
            startIceTimeout();
            break;
          case "closed":
            clearIceTimeout(targetId);
            break;
          default:
            break;
        }
      };
    }
    return peersRef.current.get(targetId);
  }, [clearIceTimeout, removePeer]);

  const createOffer = useCallback(async (targetId) => {
    const { peer } = getPeerObj(targetId);
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      console.log(`[MESH] Emitting offer to ${targetId}`);
      socket.emit("webrtc-offer", { targetId, offer });
    } catch (err) {
      console.error("[MESH] createOffer error:", err);
    }
  }, [getPeerObj]);

  // The retry code inside getPeerObj needs createOffer, but createOffer is defined after it.
  // Keeping the latest createOffer in a ref lets the retry call it later without a circular dependency.
  useEffect(() => {
    createOfferRef.current = createOffer;
  }, [createOffer]);

  useEffect(() => {
    async function drainIceCandidateQueue(targetId) {
      const peerObj = peersRef.current.get(targetId);
      if (!peerObj) return;
      while (peerObj.iceQueue.length > 0) {
        const candidate = peerObj.iceQueue.shift();
        try {
          await peerObj.peer.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error("[MESH] queued ICE error:", err);
        }
      }
    }

    const processSignal = async (type, data) => {
      try {
        if (type === "all-users") {
          const users = data;
          users.forEach(userId => createOffer(userId));
        } else if (type === "user-joined") {
          const userId = data;
          getPeerObj(userId);
        } else if (type === "webrtc-offer") {
          const { senderId, offer } = data;
          const peerObj = getPeerObj(senderId);
          await peerObj.peer.setRemoteDescription(new RTCSessionDescription(offer));
          peerObj.remoteDescSet = true;
          await drainIceCandidateQueue(senderId);

          const answer = await peerObj.peer.createAnswer();
          await peerObj.peer.setLocalDescription(answer);
          console.log(`[MESH] Emitting answer to ${senderId}`);
          socket.emit("webrtc-answer", { targetId: senderId, answer });
        } else if (type === "webrtc-answer") {
          const { senderId, answer } = data;
          const peerObj = getPeerObj(senderId);
          await peerObj.peer.setRemoteDescription(new RTCSessionDescription(answer));
          peerObj.remoteDescSet = true;
          await drainIceCandidateQueue(senderId);
        } else if (type === "webrtc-ice-candidate") {
          const { senderId, candidate } = data;
          const peerObj = getPeerObj(senderId);
          if (peerObj.remoteDescSet) {
            await peerObj.peer.addIceCandidate(new RTCIceCandidate(candidate));
          } else {
            peerObj.iceQueue.push(candidate);
          }
        } else if (type === "user-disconnected") {
          removePeer(data);
        }
      } catch (err) {
        console.error(`[MESH] Error processing signal ${type}:`, err);
      }
    };

    const handleSignal = (type, data) => {
      if (isReadyRef.current) {
        processSignal(type, data);
      } else {
        console.log(`[MESH] Queuing signal ${type} (waiting for local media)`);
        pendingSignalsRef.current.push({ type, data });
      }
    };

    const listeners = {
      "all-users": (users) => handleSignal("all-users", users),
      "user-joined": (userId) => handleSignal("user-joined", userId),
      "webrtc-offer": (data) => handleSignal("webrtc-offer", data),
      "webrtc-answer": (data) => handleSignal("webrtc-answer", data),
      "webrtc-ice-candidate": (data) => handleSignal("webrtc-ice-candidate", data),
      "user-disconnected": (userId) => handleSignal("user-disconnected", userId),
    };

    Object.entries(listeners).forEach(([event, handler]) => {
      socket.on(event, handler);
    });

    async function init() {
      console.log("[MESH] Initialization started");

      let stream = null;
      // Progressive fallback logic for getUserMedia
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
      } catch (err) {
        console.warn("[MESH] getUserMedia video+audio failed, trying audio-only:", err);
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: true,
          });
        } catch (err2) {
          console.warn("[MESH] getUserMedia audio-only failed, trying video-only:", err2);
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
          } catch (err3) {
            console.error("[MESH] All getUserMedia fallbacks FAILED:", err3);
          }
        }
      }

      if (stream) {
        localStreamRef.current = stream;
        setLocalStream(stream);
        
        // Sync control states with actual tracks obtained
        const hasAudio = stream.getAudioTracks().length > 0;
        const hasVideo = stream.getVideoTracks().length > 0;
        setIsMuted(!hasAudio);
        setIsCameraOff(!hasVideo);
      }

      try {
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("timeout")), 5000);
          socket.emit("get-turn-credentials", (data) => {
            clearTimeout(timeout);
            resolve(data);
          });
        });
        if (result?.iceServers?.length) {
          iceServersRef.current = result.iceServers;
          console.log("[MESH] Got TURN credentials");
        }
      } catch (err) {
        console.warn("[MESH] TURN fetch failed, using STUN:", err.message);
      }

      console.log(`[MESH] Initialization complete. Processing ${pendingSignalsRef.current.length} queued signals.`);
      isReadyRef.current = true;
      while (pendingSignalsRef.current.length > 0) {
        const { type, data } = pendingSignalsRef.current.shift();
        processSignal(type, data);
      }
    }

    init();

    const peers = peersRef.current;

    return () => {
      Object.keys(listeners).forEach(event => socket.off(event));
      peers.forEach(obj => obj.peer.close());
      peers.clear();
      localStreamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [getPeerObj, createOffer, removePeer]);

  const { mainStreams, spectatorStreams } = useMemo(() => {
    const main = [];
    const spec = [];

    // 1. Categorize local stream
    if (localStream) {
      if (playerSymbol === "X" || playerSymbol === "O") {
        main.push({ id: "local", stream: localStream, isLocal: true, label: "You" });
      } else {
        spec.push({ id: "local", stream: localStream, isLocal: true, label: "You (Spectator)" });
      }
    }

    // 2. Categorize remote streams
    remoteStreams.forEach((rs) => {
      const isPlayer = playersList.includes(rs.id);
      if (isPlayer) {
        let label = "Opponent";
        if (playerSymbol === "spectator" || !playerSymbol) {
          const idx = playersList.indexOf(rs.id);
          label = idx === 0 ? "Player X" : "Player O";
        }
        main.push({ id: rs.id, stream: rs.stream, isLocal: false, label });
      } else {
        // Find index among spectators
        const specList = remoteStreams.filter(r => !playersList.includes(r.id));
        const idx = specList.findIndex(r => r.id === rs.id);
        spec.push({ id: rs.id, stream: rs.stream, isLocal: false, label: `Spectator ${idx + 1}` });
      }
    });

    return { mainStreams: main, spectatorStreams: spec };
  }, [localStream, remoteStreams, playersList, playerSymbol]);

  return (
    <>
      <div
        className={`video-chat__panel count-${mainStreams.length}`}
        style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
        {...dragHandlers}
      >
        {/* Video Container (Dynamic Player Grid) */}
        <div className={`video-chat__video-container count-${mainStreams.length}`}>
          {mainStreams.map((p) => (
            <div key={p.id} className="video-chat__video-wrapper">
              <video
                ref={(el) => {
                  if (el && el.srcObject !== p.stream) {
                    el.srcObject = p.stream;
                  }
                }}
                autoPlay
                playsInline
                muted={p.isLocal}
                className="video-chat__video-element"
              />
              <span className="video-chat__label">{p.label}</span>
            </div>
          ))}

          {/* Status Overlay */}
          <div className="video-chat__status-overlay" style={{ color: statusColor }}>
            <span
              className={`video-chat__status-dot${dotAnimated ? " video-chat__status-dot--animated" : ""}`}
              style={{ backgroundColor: dotColor }}
            />
            <span>{statusLabel}</span>
          </div>

          {/* Controls Overlay */}
          <div className="video-chat__controls-overlay">
            <button
              onClick={toggleMute}
              className={`video-chat__ctrl-btn ${isMuted ? "video-chat__ctrl-btn--off" : "video-chat__ctrl-btn--on"}`}
              data-tooltip={isMuted ? "Unmute" : "Mute"}
              id="toggle-mute-btn"
            >
              {isMuted ? (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="1" x2="23" y1="1" y2="23" />
                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                  <path d="M17 11a7 7 0 0 1-14 0v-1M21 10v1a7 7 0 0 1-2.39 5.2" />
                  <line x1="12" x2="12" y1="19" y2="22" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
                  <line x1="12" x2="12" y1="19" y2="22" />
                </svg>
              )}
            </button>
            <button
              onClick={toggleCamera}
              className={`video-chat__ctrl-btn ${isCameraOff ? "video-chat__ctrl-btn--off" : "video-chat__ctrl-btn--on"}`}
              data-tooltip={isCameraOff ? "Enable Camera" : "Disable Camera"}
              id="toggle-camera-btn"
            >
              {isCameraOff ? (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m22 8-6 4 6 4V8Z" />
                  <rect x="2" y="6" width="14" height="12" rx="2" ry="2" />
                  <line x1="2" x2="22" y1="2" y2="22" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m22 8-6 4 6 4V8Z" />
                  <rect x="2" y="6" width="14" height="12" rx="2" ry="2" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Spectator Gallery (Top Right of screen, absolute positioned) */}
      {spectatorStreams.length > 0 && (
        <div className="video-chat__spectators-gallery">
          {spectatorStreams.map((ss) => (
            <div key={ss.id} className="video-chat__spectator-card">
              <video
                ref={(el) => {
                  if (el && el.srcObject !== ss.stream) {
                    el.srcObject = ss.stream;
                  }
                }}
                autoPlay
                playsInline
                muted={ss.isLocal}
                className="video-chat__spectator-video"
              />
              <span className="video-chat__spectator-label">{ss.label}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}