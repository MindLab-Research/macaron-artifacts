import { expect, test } from 'bun:test';
import { stepTailSpring } from './tail-spring';

function simulate(hz: number, seconds: number) {
  let state = { position: 0, velocity: 0 };
  for (let frame = 0; frame < hz * seconds; frame++) state = stepTailSpring(state.position, state.velocity, 1000, 1000 / hz);
  return state;
}

test('30, 60 and 120 Hz produce the same position at the same elapsed time', () => {
  const reference = simulate(120, 0.5);
  for (const hz of [30, 60]) {
    const actual = simulate(hz, 0.5);
    expect(actual.position).toBeCloseTo(reference.position, 8);
    expect(actual.velocity).toBeCloseTo(reference.velocity, 8);
  }
});

test('a background-frame delay stays bounded instead of destabilizing the spring', () => {
  expect(stepTailSpring(100, 40, 1000, 10000)).toEqual(stepTailSpring(100, 40, 1000, 64));
  const result = stepTailSpring(100, 40, 1000, 10000);
  expect(result.position).toBeGreaterThan(100);
  expect(result.position).toBeLessThan(1000);
});

test('retargeting retains existing velocity instead of resetting motion', () => {
  const result = stepTailSpring(40, 200, 20, 1000 / 120);
  expect(result.position).toBeGreaterThan(40);
  expect(result.velocity).toBeGreaterThan(0);
  expect(result.velocity).toBeLessThan(200);
});

test('the existing damped spring settles without overshooting', () => {
  let state = { position: 0, velocity: 0 };
  for (let frame = 0; frame < 360; frame++) {
    const next = stepTailSpring(state.position, state.velocity, 1000, 1000 / 120);
    expect(next.position).toBeGreaterThanOrEqual(state.position);
    expect(next.position).toBeLessThanOrEqual(1000);
    state = next;
  }
  expect(state.position).toBeCloseTo(1000, 5);
  expect(state.velocity).toBeCloseTo(0, 5);
});

test('non-positive frame intervals cannot move the spring', () => {
  for (const elapsed of [0, -10]) expect(stepTailSpring(40, 200, 1000, elapsed)).toEqual({ position: 40, velocity: 200 });
});
