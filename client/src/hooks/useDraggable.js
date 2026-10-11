import { useEffect, useRef, useState } from "react";

/**
 * Makes an element draggable with mouse or touch.
 *
 * How it works:
 * 1. On pointer down, remember where the drag started and turn on "dragging".
 * 2. While dragging, listen on the whole document (so a fast mouse can't escape
 *    the element) and move by however far the pointer has travelled.
 * 3. On pointer up, turn "dragging" off; the effect cleanup removes the listeners.
 *
 * Usage: const { position, dragHandlers } = useDraggable();
 *        <div style={{ transform: `translate(${position.x}px, ${position.y}px)` }} {...dragHandlers}>
 */
export default function useDraggable() {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ pointerX: 0, pointerY: 0, x: 0, y: 0 });

  const startDrag = (pointerX, pointerY) => {
    dragStart.current = { pointerX, pointerY, x: position.x, y: position.y };
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;

    const moveTo = (pointerX, pointerY) => {
      const start = dragStart.current;
      setPosition({
        x: start.x + (pointerX - start.pointerX),
        y: start.y + (pointerY - start.pointerY),
      });
    };
    const onMouseMove = (e) => moveTo(e.clientX, e.clientY);
    const onTouchMove = (e) => {
      if (e.cancelable) e.preventDefault(); // stop the page scrolling while dragging
      moveTo(e.touches[0].clientX, e.touches[0].clientY);
    };
    const stopDrag = () => setIsDragging(false);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", stopDrag);
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", stopDrag);
    document.body.style.cursor = "grabbing";

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", stopDrag);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", stopDrag);
      document.body.style.cursor = "default";
    };
  }, [isDragging]);

  const dragHandlers = {
    // Clicks on buttons inside the panel (mute, camera) should not start a drag
    onMouseDown: (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      startDrag(e.clientX, e.clientY);
    },
    onTouchStart: (e) => {
      if (e.target.closest("button")) return;
      startDrag(e.touches[0].clientX, e.touches[0].clientY);
    },
  };

  return { position, dragHandlers };
}
