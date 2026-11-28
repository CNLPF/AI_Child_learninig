import {expect,it} from 'vitest';
import { bladeSpeed, hitTime, intersects, swingBonus } from '../src/fruit/rules';
it('detects a fast swipe crossing a fruit even when both endpoints miss',()=>{expect(intersects({x:0,y:50},{x:200,y:50},{x:100,y:50},20)).toBe(true);});
it('rejects misses and handles a stationary fingertip',()=>{expect(intersects({x:0,y:0},{x:200,y:0},{x:100,y:50},20)).toBe(false);expect(intersects({x:0,y:0},{x:0,y:0},{x:100,y:50},20)).toBe(false);});

it('orders targets by first contact rather than centre or spawn order', () => {
  const start = { x: 0, y: 0 };
  const end = { x: 100, y: 0 };
  expect(hitTime(start, end, { x: 48, y: 0 }, 16)).toBeCloseTo(0.32);
  expect(hitTime(start, end, { x: 45, y: 0 }, 3)).toBeCloseTo(0.42);
  expect(hitTime(end, start, { x: 48, y: 0 }, 16)).toBeCloseTo(0.36);
});

it('handles diagonal tangency, starts inside, and rejects intersections behind the blade', () => {
  const start = { x: 0, y: 0 };
  expect(hitTime(start, { x: 10, y: 10 }, { x: 8, y: 2 }, Math.sqrt(18))).toBeCloseTo(0.5);
  expect(hitTime(start, { x: 10, y: 10 }, start, 3)).toBe(0);
  expect(hitTime(start, { x: 10, y: 10 }, { x: -8, y: -8 }, 2)).toBeNull();
});

it('invalidates discontinuous or stationary samples and measures quick swipes', () => {
  const start = { x: 1, y: 1, t: 0 };
  expect(bladeSpeed(start, { ...start, t: 20 })).toBe(0);
  expect(bladeSpeed(start, { x: 301, y: 1, t: 120 })).toBe(0);
  expect(bladeSpeed(start, { x: 301, y: 1, t: 0 })).toBe(0);
  expect(bladeSpeed(start, { x: 31, y: 41, t: 50 })).toBe(1000);
});

it('awards swing bonuses starting with the third distinct fruit', () => {
  expect([0, 1, 2, 3, 4].map(swingBonus)).toEqual([0, 0, 0, 5, 10]);
});
