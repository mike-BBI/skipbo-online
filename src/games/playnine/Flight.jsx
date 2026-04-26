import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Card } from './Card.jsx';

export const FLIGHT_MS = 520;

// A single ghost card animating from `fromSelector` to `toSelector`.
// Position is manipulated imperatively on the DOM element (via ref)
// rather than through React state so we can reliably force a layout
// flush between "at source" and "at destination" renders — necessary
// for the CSS transition to actually interpolate.
function Flight({ fromSelector, toSelector, card, faceDown, onDone, delay = 0 }) {
  const elRef = useRef(null);
  const doneRef = useRef(false);

  useLayoutEffect(() => {
    const el = elRef.current;
    const fromEl = document.querySelector(fromSelector);
    const toEl = document.querySelector(toSelector);
    if (!el || !fromEl || !toEl) {
      if (!doneRef.current) { doneRef.current = true; onDone?.(); }
      return;
    }
    const fromR = fromEl.getBoundingClientRect();
    const toR = toEl.getBoundingClientRect();

    // Render the ghost at the DESTINATION's card dimensions so it
    // matches what lands perfectly (same font-size, border-radius,
    // and box-shadow as the real destination card). Translate
    // between source-center and destination-center; no scale, so
    // fixed-pixel properties like the 10px border-radius don't
    // visually morph.
    const w = toR.width;
    const h = toR.height;
    const srcX = fromR.left + fromR.width / 2 - w / 2;
    const srcY = fromR.top + fromR.height / 2 - h / 2;
    const dstX = toR.left;
    const dstY = toR.top;

    // Match the destination's context: opponent cards have their own
    // fixed font-size override in CSS that we need to mirror on the
    // ghost (which is portal-rendered to body and otherwise wouldn't
    // inherit that override).
    const isOppDest = !!toEl.closest?.('.p9-opponent');
    el.className = isOppDest ? 'p9-flight p9-flight-opp' : 'p9-flight';

    // 1) Pin the element at the source center, no transition, sized
    //    like the destination.
    el.style.setProperty('--p9-card-w', `${w}px`);
    el.style.setProperty('--p9-card-h', `${h}px`);
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.transform = `translate(${srcX}px, ${srcY}px)`;
    el.style.transition = 'none';
    el.style.opacity = '1';

    // 2) Force layout flush so the browser commits the source frame
    //    before we retarget the transform.
    // eslint-disable-next-line no-unused-expressions
    el.offsetWidth;

    // 3) Next task: enable the transition and retarget; browser
    //    interpolates the translate between source and destination.
    const kickTimer = setTimeout(() => {
      if (!elRef.current) return;
      elRef.current.style.transition = `transform ${FLIGHT_MS}ms cubic-bezier(0.3, 0.8, 0.3, 1.02)`;
      elRef.current.style.transform = `translate(${dstX}px, ${dstY}px)`;
    }, Math.max(0, delay) + 16);

    const endTimer = setTimeout(() => {
      if (!doneRef.current) { doneRef.current = true; onDone?.(); }
    }, Math.max(0, delay) + FLIGHT_MS + 40);

    return () => {
      clearTimeout(kickTimer);
      clearTimeout(endTimer);
    };
  }, []);

  return createPortal(
    <div
      ref={elRef}
      className="p9-flight"
      aria-hidden="true"
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        transformOrigin: 'top left',
        pointerEvents: 'none',
        zIndex: 200,
        willChange: 'transform',
      }}
    >
      <Card card={card} faceDown={faceDown} />
    </div>,
    document.body,
  );
}

export function FlightLayer({ flights, onComplete }) {
  return (
    <>
      {flights.map((f) => (
        <Flight
          key={f.id}
          fromSelector={f.fromSelector}
          toSelector={f.toSelector}
          card={f.card}
          faceDown={f.faceDown}
          delay={f.delay || 0}
          onDone={() => onComplete(f.id, f.destKey, f.sourceKey)}
        />
      ))}
    </>
  );
}
