export type Point = { x: number; y: number };
export type BladeSample = Point & { t: number };

export function bladeSpeed(previous: BladeSample, current: BladeSample): number {
  const elapsed = current.t - previous.t;
  if (elapsed <= 0 || elapsed >= 120) return 0;
  return Math.hypot(current.x - previous.x, current.y - previous.y) * 1000 / elapsed;
}

// First contact along the stroke, including strokes that start inside the circle.
export function hitTime(start: Point, end: Point, center: Point, radius: number): number | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const x = start.x - center.x;
  const y = start.y - center.y;
  const outside = x * x + y * y - radius * radius;
  if (outside <= 0) return 0;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return null;
  const projection = x * dx + y * dy;
  const discriminant = projection * projection - lengthSquared * outside;
  if (discriminant < 0) return null;
  const entry = (-projection - Math.sqrt(discriminant)) / lengthSquared;
  return entry >= 0 && entry <= 1 ? entry : null;
}

export function intersects(start: Point, end: Point, center: Point, radius: number): boolean {
  return hitTime(start, end, center, radius) !== null;
}

export function swingBonus(hits: number): number {
  return 5 * Math.max(0, hits - 2);
}
