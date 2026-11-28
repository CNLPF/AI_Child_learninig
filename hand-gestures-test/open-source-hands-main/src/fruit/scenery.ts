// The arena backdrop is painted once per resize, behind the interactive canvas.
export function paintOrchard(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): void {
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const context = canvas.getContext('2d')!;
  context.setTransform(canvas.width / 960, 0, 0, canvas.height / 540, 0, 0);

  const horizon = context.createRadialGradient(610, 205, 15, 610, 205, 390);
  horizon.addColorStop(0, 'rgba(251,195,113,.22)');
  horizon.addColorStop(0.5, 'rgba(198,198,129,.08)');
  horizon.addColorStop(1, 'rgba(82,135,106,0)');
  context.fillStyle = horizon;
  context.fillRect(0, 0, 960, 480);

  // Distant orchard canopies leave the middle of the playfield clear.
  for (const layer of [
    { y: 328, amplitude: 26, color: 'rgba(11,52,53,.31)' },
    { y: 366, amplitude: 31, color: 'rgba(10,48,47,.44)' },
    { y: 405, amplitude: 23, color: 'rgba(8,42,40,.69)' },
  ]) {
    context.beginPath();
    context.moveTo(0, layer.y);
    for (let x = 0; x < 960; x += 32) {
      const peak = layer.y + Math.sin(x * 0.014 + layer.y) * layer.amplitude;
      context.quadraticCurveTo(x + 16, peak - 17, x + 32, peak);
    }
    context.lineTo(960, 510);
    context.lineTo(0, 510);
    context.closePath();
    context.fillStyle = layer.color;
    context.fill();
  }

  function palm(x: number, y: number, size: number, direction: number, color: string): void {
    context.save();
    context.translate(x, y);
    context.scale(size * direction, size);
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(-87, 332);
    context.quadraticCurveTo(-72, 154, -6, -2);
    context.lineTo(4, 5);
    context.quadraticCurveTo(-51, 166, -65, 332);
    context.closePath();
    context.fill();

    const fronds = [
      { x: -129, y: -56, bend: -42 }, { x: -142, y: 47, bend: -52 },
      { x: -87, y: 96, bend: -35 }, { x: 133, y: 36, bend: -68 },
      { x: 110, y: 82, bend: -30 }, { x: 70, y: -84, bend: -35 },
    ];
    for (const { x: tipX, y: tipY, bend } of fronds) {
      context.beginPath();
      context.moveTo(0, 0);
      context.quadraticCurveTo(tipX * 0.55, tipY * 0.32 + bend, tipX, tipY);
      context.bezierCurveTo(tipX * 0.75, tipY * 0.72, tipX * 0.38, tipY * 0.43 + bend * 0.43, 0, 8);
      context.fill();
    }
    context.restore();
  }

  palm(104, 211, 0.62, 1, 'rgba(8,43,39,.46)');
  palm(864, 205, 0.58, -1, 'rgba(8,43,39,.46)');
  palm(42, 165, 0.9, 1, 'rgba(5,34,32,.70)');
  palm(925, 164, 0.92, -1, 'rgba(5,34,32,.70)');
}
