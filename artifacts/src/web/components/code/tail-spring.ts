const STIFFNESS = 180;
const DAMPING = 28;

/** Use elapsed time, with bounded substeps so high-refresh displays and delayed frames share the same spring. */
export function stepTailSpring(position: number, velocity: number, target: number, elapsedMs: number) {
  const seconds = Math.min(64, Math.max(0, elapsedMs)) / 1000;
  const steps = Math.max(1, Math.ceil(seconds * 120)), dt = seconds / steps;
  for (let index = 0; index < steps; index++) {
    velocity += (STIFFNESS * (target - position) - DAMPING * velocity) * dt;
    position += velocity * dt;
  }
  return { position, velocity };
}
