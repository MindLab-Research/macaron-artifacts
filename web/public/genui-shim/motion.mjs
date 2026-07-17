// motion/react shim — re-exports the real vendored npm package via window
// so user TSX, source.tsx components, and partial-react all share one React.
const M = globalThis.__macaron_Motion;
if (!M) throw new Error('[genui-shim/motion] window.__macaron_Motion not set');

// Core
export const { motion, AnimatePresence, MotionConfig, LayoutGroup, LazyMotion } = M;

// Hooks
export const {
  useAnimate, useAnimation, useAnimationControls, useAnimationFrame,
  useCycle, useDragControls, useElementScroll, useInView,
  useMotionTemplate, useMotionValue, useMotionValueEvent,
  useReducedMotion, useReducedMotionConfig, useScroll, useSpring,
  useTime, useTransform, useVelocity, useViewportScroll,
  useWillChange,
} = M;

// Stateful
export const {
  Reorder, domAnimation, domMax, m, animate, animateMini,
  scroll, inView, transform,
  stagger, sync,
} = M;

export default M;
