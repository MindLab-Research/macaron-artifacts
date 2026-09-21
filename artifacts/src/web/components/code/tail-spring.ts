const RESPONSE = 8;

/** Exact critically damped motion, with velocity bounded by remaining distance so a shortened target cannot overshoot. */
export function stepTailSpring(position: number, velocity: number, target: number, elapsedMs: number) {
  const seconds = Math.min(64, Math.max(0, elapsedMs)) / 1000;
  if (!seconds) return { position, velocity };
  const distance = target - position, direction = Math.sign(distance);
  if (!direction) return { position: target, velocity: 0 };
  // Critical damping alone only prevents overshoot from rest. Streaming layout can shorten a target
  // while the old velocity is still large; v <= response * distance preserves monotonic convergence.
  velocity = direction * Math.min(Math.max(0, direction * velocity), RESPONSE * Math.abs(distance));
  const coefficient = velocity - RESPONSE * distance, decay = Math.exp(-RESPONSE * seconds);
  return { position: target + (-distance + coefficient * seconds) * decay, velocity: (velocity - RESPONSE * coefficient * seconds) * decay };
}
