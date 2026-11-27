import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  nextResetStopIndex,
  resolveStopIndex,
  selectStopAtX,
  type LaneStop,
  type StopKey,
} from './combinedLanesModel';

const stopKey = (stop: LaneStop): StopKey => ({ atMs: stop.atMs, projected: stop.projected });

interface DragState {
  pointerId: number;
  pointerType: string;
  x: number;
  y: number;
  active: boolean;
  verticalScroll: boolean;
}

/**
 * Pointer, touch, and keyboard scrubbing for the combined lanes chart.
 * - Mouse captures the primary pointer on press so dragging outside the SVG keeps scrubbing.
 * - Touch/pen waits for tap completion or a horizontal drag so vertical page scroll never pins.
 * - Selection is keyed by `{ atMs, projected }` and clears automatically if it rolls out of view.
 */
export function useChartScrub({
  stops,
  latestIdx,
  fromMs,
  toMs,
  layoutWidth,
  x,
}: {
  stops: readonly LaneStop[];
  latestIdx: number;
  fromMs: number;
  toMs: number;
  layoutWidth: number;
  x: (atMs: number) => number;
}) {
  const [pinned, setPinned] = useState<StopKey | null>(null);
  const [hovered, setHovered] = useState<StopKey | null>(null);
  const dragOrigin = useRef<DragState | null>(null);

  const pinnedIndex = resolveStopIndex(stops, pinned, fromMs, toMs);
  const hoveredIndex = resolveStopIndex(stops, hovered, fromMs, toMs);

  // Clear stale state once a pinned/hovered moment rolls outside the visible window (e.g. 5-hour poll).
  useEffect(() => {
    if (pinned !== null && pinnedIndex === null) setPinned(null);
  }, [pinned, pinnedIndex]);

  useEffect(() => {
    if (hovered !== null && hoveredIndex === null) setHovered(null);
  }, [hovered, hoveredIndex]);

  const activeIndex = hoveredIndex ?? pinnedIndex ?? latestIdx;
  const committedIndex = pinnedIndex ?? latestIdx;
  const isInspecting = (hoveredIndex ?? pinnedIndex) !== null && activeIndex !== latestIdx;
  const showNowButton = pinnedIndex !== null && pinnedIndex !== latestIdx;

  const commitPinIndex = (idx: number) => {
    const stop = stops[idx];
    if (!stop) return;
    // Selecting the latest reading returns to live rest state so polling never turns it into a stale pin.
    setPinned(idx === latestIdx ? null : stopKey(stop));
    setHovered(null);
  };

  const stopIndexFromEvent = (event: PointerEvent<SVGSVGElement>): number | null => {
    if (!stops.length) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return null;
    const cursorX = ((event.clientX - bounds.left) / bounds.width) * layoutWidth;
    return selectStopAtX(stops, cursorX, x, 12);
  };

  const capturePointer = (event: PointerEvent<SVGSVGElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or detached pointer events may not support capture.
    }
  };

  const releaseDrag = (event: PointerEvent<SVGSVGElement>) => {
    const origin = dragOrigin.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    if (origin.active) {
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Ignore capture release errors.
      }
    }
    dragOrigin.current = null;
  };

  const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    const isMouse = event.pointerType === 'mouse';
    if (isMouse && event.button !== 0) return;
    if (dragOrigin.current) return;
    dragOrigin.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      x: event.clientX,
      y: event.clientY,
      active: isMouse,
      verticalScroll: false,
    };
    if (isMouse) {
      capturePointer(event);
      const idx = stopIndexFromEvent(event);
      if (idx !== null) commitPinIndex(idx);
    }
  };

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      if (dragOrigin.current?.pointerType === 'mouse') dragOrigin.current = null;
      const idx = stopIndexFromEvent(event);
      if (idx !== null && stops[idx]) setHovered(stopKey(stops[idx]));
      return;
    }
    const origin = dragOrigin.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    const dx = Math.abs(event.clientX - origin.x);
    const dy = Math.abs(event.clientY - origin.y);
    if (!origin.active && !origin.verticalScroll && dy > 6 && dy >= dx) {
      origin.verticalScroll = true;
      return;
    }
    if (!origin.active && !origin.verticalScroll && dx > 6 && dx > dy) {
      origin.active = true;
      capturePointer(event);
    }
    if (origin.active) {
      const idx = stopIndexFromEvent(event);
      if (idx !== null) commitPinIndex(idx);
    }
  };

  const handlePointerUp = (event: PointerEvent<SVGSVGElement>) => {
    const origin = dragOrigin.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    if (event.pointerType !== 'mouse' && !origin.active && !origin.verticalScroll) {
      const idx = stopIndexFromEvent(event);
      if (idx !== null) commitPinIndex(idx);
    }
    releaseDrag(event);
  };

  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === 'Escape') {
      if (pinned !== null || hovered !== null) {
        event.preventDefault();
        setPinned(null);
        setHovered(null);
      }
      return;
    }
    const last = stops.length - 1;
    if (last < 1) return;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') {
      next = event.shiftKey
        ? nextResetStopIndex(stops, committedIndex, -1)
        : Math.max(0, committedIndex - 1);
    } else if (event.key === 'ArrowRight') {
      next = event.shiftKey
        ? nextResetStopIndex(stops, committedIndex, 1)
        : Math.min(last, committedIndex + 1);
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = last;
    }
    if (next === null) return;
    event.preventDefault();
    commitPinIndex(next);
  };

  const clearSelection = () => {
    setPinned(null);
    setHovered(null);
  };

  const handleLostPointerCapture = (event: PointerEvent<SVGSVGElement>) => {
    // Only end the drag when the SVG itself loses capture; transferring implicit touch capture
    // from a child SVG element to the SVG emits a bubbling lostpointercapture.
    if (event.target !== event.currentTarget) return;
    releaseDrag(event);
  };

  return {
    activeIndex,
    committedIndex,
    isInspecting,
    isAtLatestCommit: pinnedIndex === null || pinnedIndex === latestIdx,
    showNowButton,
    clearSelection,
    clearHover: () => setHovered(null),
    svgHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: releaseDrag,
      onLostPointerCapture: handleLostPointerCapture,
      onPointerLeave: () => setHovered(null),
      onKeyDown: handleKeyDown,
    },
  };
}
