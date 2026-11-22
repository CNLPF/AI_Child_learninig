import { listCameras, cameraError } from './camera';
import { GameAudio, type FruitSound } from './audio';
import {
  createHands,
  drawHand,
  fromScreen,
  syntheticHand,
  SYNTHETIC_POSES as P,
  toScreen,
  type GestureFrame,
} from '../kit';
import { intersects, type Point } from './rules';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('game');
const ctx = canvas.getContext('2d')!;
const video = $<HTMLVideoElement>('video');
const skeleton = $<HTMLCanvasElement>('skeleton');
const skeletonCtx = skeleton.getContext('2d')!;
const GESTURE_REGION = { x0: 0.26, x1: 0.74, y0: 0.1, y1: 0.76 };

type Mode = 'none' | 'camera' | 'mouse' | 'bot';
type FruitKind = 'apple' | 'orange' | 'lime' | 'watermelon';
type TargetKind = FruitKind | 'bomb';
type TargetState = 'whole' | 'half';

type Target = Point & {
  id: number;
  kind: TargetKind;
  vx: number;
  vy: number;
  r: number;
  angle: number;
  spin: number;
  state: TargetState;
  side: number;
  cutAngle: number;
  life: number;
};

type Particle = Point & {
  vx: number;
  vy: number;
  size: number;
  color: string;
  life: number;
  maxLife: number;
  kind: 'juice' | 'spark';
};

type EffectText = Point & {
  text: string;
  color: string;
  life: number;
  maxLife: number;
};

type SlashFx = Point & {
  angle: number;
  life: number;
};

type AmbientLeaf = Point & {
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  size: number;
  hue: string;
  life: number;
};

const FRUIT_STYLES: Record<FruitKind, { rind: string; rindDark: string; flesh: string; glow: string; seed: string }> = {
  apple: { rind: '#ef5a4c', rindDark: '#9d292d', flesh: '#fff0be', glow: '#ffb08c', seed: '#663a24' },
  orange: { rind: '#ffad2f', rindDark: '#c66b16', flesh: '#ffdf7d', glow: '#ffd56e', seed: '#9c5f24' },
  lime: { rind: '#91ce55', rindDark: '#4e8c38', flesh: '#e4f69c', glow: '#c7ed7f', seed: '#3d6b32' },
  watermelon: { rind: '#438b50', rindDark: '#204d36', flesh: '#ff6c67', glow: '#ff9b7e', seed: '#391d1e' },
};
const FRUIT_KINDS: FruitKind[] = ['apple', 'orange', 'lime', 'watermelon'];
const FLOW_DURATION = 7000;
const FLOW_MAX = 100;
const audio = new GameAudio();

let mode: Mode = 'none';
let active = false;
let score = 0;
let lives = 3;
let combo = 0;
let comboUntil = 0;
let fruits: Target[] = [];
let particles: Particle[] = [];
let effectTexts: EffectText[] = [];
let trail: (Point & { t: number })[] = [];
let previous: (Point & { t: number }) | null = null;
let cursor: Point | null = null;
let slashFx: SlashFx | null = null;
let last = 0;
let spawnAt = 0;
let nextTargetId = 1;
let runId = 0;
let pressed = false;
let width = 1;
let height = 1;
let skeletonWidth = 0;
let skeletonHeight = 0;
let statusText = '';
let statusHoldUntil = 0;
let trauma = 0;
let hitStopUntil = 0;
let impactZoom = 0;
let shakeEnabled = true;
let soundEnabled = true;
let flowCharge = 0;
let flowUntil = 0;
let flowWasActive = false;
let lastFlowPct = -1;
let lastFlowRunning = false;
let ambientLeaves: AmbientLeaf[] = [];
let nextLeafAt = 0;

const keys = new Set<string>();
const bot = new URLSearchParams(location.search).has('bot');
const mobileDevice = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && window.matchMedia('(pointer: coarse)').matches)
  || window.innerWidth <= 760;

function setStatus(text: string): void {
  if (text === statusText) return;
  statusText = text;
  $('status').textContent = text;
}

function syncModeButtons(): void {
  const gesture = mode === 'camera' || mode === 'bot';
  $('mode-camera').classList.toggle('active', gesture);
  $('mode-mouse').classList.toggle('active', mode === 'mouse');
  $('mode-camera').setAttribute('aria-pressed', String(gesture));
  $('mode-mouse').setAttribute('aria-pressed', String(mode === 'mouse'));
}

function holdStatus(text: string, holdMs = 800): void {
  statusHoldUntil = performance.now() + holdMs;
  setStatus(text);
}

function updateHud(): void {
  $('score').textContent = String(score);
  $('lives').textContent = String(lives);
}

function isFlowActive(now = performance.now()): boolean {
  return now < flowUntil;
}

function updateFlowHud(now = performance.now()): void {
  const running = isFlowActive(now);
  const percent = Math.round(running ? Math.max(0, Math.min(FLOW_MAX, ((flowUntil - now) / FLOW_DURATION) * FLOW_MAX)) : flowCharge);
  if (percent !== lastFlowPct) {
    lastFlowPct = percent;
    $<HTMLElement>('flow-fill').style.transform = `scaleX(${percent / FLOW_MAX})`;
    $('flow-value').textContent = running ? '×2' : `${percent}%`;
  }
  if (running !== lastFlowRunning) {
    lastFlowRunning = running;
    $('flow-label').textContent = running ? '流光时刻' : '流光蓄能';
    $('flow-meter').classList.toggle('active', running);
    $('stage').classList.toggle('flow-active', running);
  }
}

function activateFlow(now: number): void {
  flowUntil = now + FLOW_DURATION;
  flowCharge = FLOW_MAX;
  flowWasActive = true;
  addEffectText({ x: width / 2, y: height * 0.3, r: 0 } as Target, 'FLOW ×2', '#fff3b0');
  if (shakeEnabled) {
    trauma = Math.min(1, trauma + 0.24);
    impactZoom = Math.max(impactZoom, 0.012);
  }
  audio.playFlow();
  holdStatus('流光时刻 · 7 秒双倍切片', 1500);
  updateFlowHud(now);
}

function clearBlade(): void {
  previous = null;
  trail = [];
  cursor = null;
}

function fruitStyle(kind: FruitKind) {
  return FRUIT_STYLES[kind];
}

function traceFruitShape(kind: FruitKind, radius: number): void {
  ctx.beginPath();
  if (kind === 'apple') {
    ctx.moveTo(0, -radius * 0.62);
    ctx.bezierCurveTo(-radius * 0.18, -radius * 0.9, -radius * 0.82, -radius * 0.92, -radius * 0.9, -radius * 0.28);
    ctx.bezierCurveTo(-radius * 1.02, radius * 0.28, -radius * 0.5, radius * 0.86, 0, radius);
    ctx.bezierCurveTo(radius * 0.5, radius * 0.86, radius * 1.02, radius * 0.28, radius * 0.9, -radius * 0.28);
    ctx.bezierCurveTo(radius * 0.82, -radius * 0.92, radius * 0.18, -radius * 0.9, 0, -radius * 0.62);
  } else if (kind === 'watermelon') {
    ctx.ellipse(0, radius * 0.04, radius * 1.16, radius * 0.82, -0.08, 0, Math.PI * 2);
  } else if (kind === 'lime') {
    ctx.ellipse(0, 0, radius * 0.9, radius, 0.18, 0, Math.PI * 2);
  } else {
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
  }
  ctx.closePath();
}

function drawLeaf(radius: number, vertical = -0.96): void {
  ctx.save();
  ctx.translate(radius * 0.34, radius * vertical);
  ctx.rotate(-0.38);
  const leaf = ctx.createLinearGradient(-radius * 0.2, 0, radius * 0.34, 0);
  leaf.addColorStop(0, '#7ddf86');
  leaf.addColorStop(1, '#2f9d60');
  ctx.fillStyle = leaf;
  ctx.beginPath();
  ctx.ellipse(radius * 0.13, 0, radius * 0.36, radius * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(233,255,186,.65)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-radius * 0.1, radius * 0.03);
  ctx.lineTo(radius * 0.4, -radius * 0.03);
  ctx.stroke();
  ctx.restore();
}

function drawFruitBody(kind: FruitKind, radius: number): void {
  const style = fruitStyle(kind);
  traceFruitShape(kind, radius);
  const gradient = ctx.createRadialGradient(-radius * 0.36, -radius * 0.44, 2, 0, 0, radius * 1.15);
  gradient.addColorStop(0, '#fffbe2');
  gradient.addColorStop(0.18, style.glow);
  gradient.addColorStop(0.68, style.rind);
  gradient.addColorStop(1, style.rindDark);
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.save();
  traceFruitShape(kind, radius);
  ctx.clip();
  if (kind === 'orange') {
    ctx.fillStyle = 'rgba(133,73,15,.25)';
    for (let i = 0; i < 22; i++) {
      const angle = i * 2.399;
      const distance = radius * (0.18 + ((i * 37) % 60) / 100);
      ctx.beginPath();
      ctx.arc(Math.cos(angle) * distance, Math.sin(angle) * distance, Math.max(0.7, radius * 0.026), 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind === 'watermelon') {
    ctx.strokeStyle = 'rgba(20,68,42,.58)';
    ctx.lineWidth = Math.max(2, radius * 0.1);
    for (let x = -1.1; x <= 1.1; x += 0.38) {
      ctx.beginPath();
      ctx.moveTo(radius * x - radius * 0.18, -radius);
      ctx.quadraticCurveTo(radius * x + radius * 0.2, 0, radius * x - radius * 0.18, radius);
      ctx.stroke();
    }
  } else if (kind === 'lime') {
    ctx.fillStyle = 'rgba(244,255,173,.3)';
    for (let i = 0; i < 12; i++) {
      const angle = i * 2.15;
      ctx.beginPath();
      ctx.arc(Math.cos(angle) * radius * 0.55, Math.sin(angle) * radius * 0.5, radius * 0.035, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    const blush = ctx.createLinearGradient(-radius, 0, radius, 0);
    blush.addColorStop(0, 'rgba(126,24,47,.2)');
    blush.addColorStop(0.5, 'rgba(255,255,255,.05)');
    blush.addColorStop(1, 'rgba(255,180,82,.14)');
    ctx.fillStyle = blush;
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
  }
  ctx.restore();

  traceFruitShape(kind, radius);
  ctx.strokeStyle = 'rgba(255,242,204,.48)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,.62)';
  ctx.beginPath();
  ctx.ellipse(-radius * 0.32, -radius * 0.4, radius * 0.18, radius * 0.09, -0.65, 0, Math.PI * 2);
  ctx.fill();
}

function drawCutInterior(kind: FruitKind, radius: number): void {
  const style = fruitStyle(kind);
  ctx.fillStyle = style.flesh;
  ctx.beginPath();
  ctx.ellipse(0, 0, radius * 0.84, radius * 0.88, 0, 0, Math.PI * 2);
  ctx.fill();

  if (kind === 'orange' || kind === 'lime') {
    ctx.strokeStyle = kind === 'orange' ? 'rgba(201,119,30,.55)' : 'rgba(77,132,48,.48)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(angle) * radius * 0.72, Math.sin(angle) * radius * 0.72);
      ctx.stroke();
    }
    ctx.fillStyle = style.flesh;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.11, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'watermelon') {
    ctx.fillStyle = '#ffe9c1';
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * 0.9, radius * 0.84, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff5f61';
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * 0.84, radius * 0.77, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = style.seed;
    for (const [x, y, angle] of [[-0.42, -0.18, -0.35], [0, -0.32, 0], [0.42, -0.18, 0.35], [-0.22, 0.2, -0.2], [0.25, 0.22, 0.2]] as const) {
      ctx.beginPath();
      ctx.ellipse(radius * x, radius * y, radius * 0.055, radius * 0.09, angle, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.fillStyle = style.seed;
    for (const x of [-0.15, 0.15]) {
      ctx.beginPath();
      ctx.ellipse(radius * x, 0, radius * 0.055, radius * 0.09, x * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawBomb(radius: number, now: number): void {
  const body = ctx.createRadialGradient(-radius * 0.35, -radius * 0.4, 1, 0, 0, radius);
  body.addColorStop(0, '#70808a');
  body.addColorStop(0.18, '#29343a');
  body.addColorStop(0.75, '#11191e');
  body.addColorStop(1, '#05090c');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ff704c';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.strokeStyle = '#a88256';
  ctx.lineWidth = Math.max(3, radius * 0.09);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(radius * 0.12, -radius * 0.94);
  ctx.quadraticCurveTo(radius * 0.66, -radius * 1.45, radius * 0.42, -radius * 1.74);
  ctx.stroke();

  const flicker = 0.72 + Math.sin(now * 0.035) * 0.2 + Math.sin(now * 0.071) * 0.08;
  const spark = ctx.createRadialGradient(radius * 0.42, -radius * 1.75, 1, radius * 0.42, -radius * 1.75, radius * 0.45);
  spark.addColorStop(0, '#fffbd2');
  spark.addColorStop(0.3, '#ffd35a');
  spark.addColorStop(1, 'rgba(255,86,42,0)');
  ctx.globalAlpha = flicker;
  ctx.fillStyle = spark;
  ctx.beginPath();
  ctx.arc(radius * 0.42, -radius * 1.75, radius * 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = '#ff7755';
  ctx.font = `900 ${Math.max(8, radius * 0.3)}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('!', 0, radius * 0.06);
}

function drawTarget(target: Target, now: number): void {
  ctx.save();
  ctx.translate(target.x, target.y);
  ctx.rotate(target.state === 'half' ? target.cutAngle : target.angle);
  ctx.globalAlpha = target.state === 'half' ? Math.min(1, target.life * 2.3) : Math.min(1, target.life);

  if (target.state === 'whole' && target.kind !== 'bomb' && isFlowActive(now)) {
    ctx.save();
    ctx.strokeStyle = `rgba(255,235,151,${0.3 + Math.sin(now * 0.012) * 0.12})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 7]);
    ctx.beginPath();
    ctx.arc(0, 0, target.r + 8 + Math.sin(now * 0.008) * 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  if (target.kind === 'bomb') {
    drawBomb(target.r, now);
    ctx.restore();
    return;
  }

  if (target.state === 'whole') {
    drawFruitBody(target.kind, target.r);
    ctx.strokeStyle = '#9f7443';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -target.r * 0.72);
    ctx.lineTo(target.r * 0.08, -target.r * 1.08);
    ctx.stroke();
    if (target.kind !== 'watermelon') drawLeaf(target.r, target.kind === 'orange' ? -1.02 : -0.82);
    else {
      ctx.strokeStyle = '#4f8b4c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(target.r * 0.2, -target.r * 0.78, target.r * 0.28, Math.PI * 1.08, Math.PI * 1.75);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(-target.r - 8, target.side > 0 ? -target.r - 8 : 0, target.r * 2 + 16, target.r + 8);
  ctx.clip();
  drawFruitBody(target.kind, target.r);
  drawCutInterior(target.kind, target.r);
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,244,205,.92)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-target.r * 0.92, 0);
  ctx.lineTo(target.r * 0.92, 0);
  ctx.stroke();
  ctx.restore();
}

function drawTrail(): void {
  trail = trail.filter((point) => performance.now() - point.t < 190);
  if (trail.length < 2) return;
  const flowing = isFlowActive();
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(trail[0].x, trail[0].y);
  for (let i = 1; i < trail.length; i++) ctx.lineTo(trail[i].x, trail[i].y);
  ctx.strokeStyle = flowing ? 'rgba(119,244,204,.24)' : 'rgba(255,185,87,.18)';
  ctx.lineWidth = 18;
  ctx.stroke();
  ctx.strokeStyle = flowing ? 'rgba(226,255,196,.96)' : 'rgba(255,240,184,.9)';
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.98)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawParticles(): void {
  for (const particle of particles) {
    const alpha = Math.max(0, particle.life / particle.maxLife);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = particle.color;
    ctx.translate(particle.x, particle.y);
    ctx.rotate(Math.atan2(particle.vy, particle.vx));
    if (particle.kind === 'juice') {
      ctx.beginPath();
      ctx.ellipse(0, 0, particle.size * 1.8, particle.size, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(-particle.size, -particle.size * 0.35, particle.size * 2.8, particle.size * 0.7);
    }
    ctx.restore();
  }
}

function updateAmbient(dt: number, now: number): void {
  if (ambientLeaves.length < 12 && now > nextLeafAt) {
    ambientLeaves.push({
      x: width * (0.08 + Math.random() * 0.84),
      y: -14,
      vx: -8 + Math.random() * 16,
      vy: 13 + Math.random() * 16,
      angle: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.8,
      size: 3 + Math.random() * 5,
      hue: Math.random() > 0.55 ? '#f1bd6c' : '#9fc47b',
      life: 8,
    });
    nextLeafAt = now + 520 + Math.random() * 620;
  }
  for (const leaf of ambientLeaves) {
    leaf.life -= dt;
    leaf.x += (leaf.vx + Math.sin(now * 0.0013 + leaf.y * 0.01) * 12) * dt;
    leaf.y += leaf.vy * dt;
    leaf.angle += leaf.spin * dt;
  }
  ambientLeaves = ambientLeaves.filter((leaf) => leaf.life > 0 && leaf.y < height + 20);
}

function drawAmbient(): void {
  ctx.save();
  for (const leaf of ambientLeaves) {
    ctx.save();
    ctx.translate(leaf.x, leaf.y);
    ctx.rotate(leaf.angle);
    ctx.globalAlpha = Math.min(0.24, leaf.life * 0.08);
    ctx.fillStyle = leaf.hue;
    ctx.beginPath();
    ctx.ellipse(0, 0, leaf.size * 1.8, leaf.size * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function addParticle(particle: Particle): void {
  if (particles.length < 150) particles.push(particle);
}

function burstFruit(target: Target, cutAngle: number): void {
  const style = fruitStyle(target.kind as FruitKind);
  for (let i = 0; i < 22; i++) {
    const angle = cutAngle + Math.PI / 2 * (i % 2 ? 1 : -1) + (Math.random() - 0.5) * 0.72;
    const speed = 80 + Math.random() * 210;
    addParticle({
      x: target.x,
      y: target.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 45,
      size: 2 + Math.random() * 4.2,
      color: i % 3 ? style.flesh : style.rind,
      life: 0.45 + Math.random() * 0.38,
      maxLife: 0.83,
      kind: 'juice',
    });
  }
}

function burstBomb(target: Target): void {
  const colors = ['#fff2a2', '#ffbe4f', '#ff7549', '#ff3b37', '#d9e2e4'];
  for (let i = 0; i < 38; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 90 + Math.random() * 390;
    addParticle({
      x: target.x,
      y: target.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 1.5 + Math.random() * 3.5,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: 0.32 + Math.random() * 0.52,
      maxLife: 0.84,
      kind: i % 4 === 0 ? 'juice' : 'spark',
    });
  }
}

function addEffectText(target: Target, text: string, color: string): void {
  effectTexts.push({
    x: target.x,
    y: target.y - target.r,
    text,
    color,
    life: 0.72,
    maxLife: 0.72,
  });
}

function onFruitCut(target: Target, cutAngle: number): void {
  const now = performance.now();
  const flowActive = isFlowActive(now);
  const gained = flowActive ? 2 : 1;
  score += gained;
  combo = now < comboUntil ? combo + 1 : 1;
  comboUntil = now + 520;
  if (!flowActive) {
    flowCharge = Math.min(FLOW_MAX, flowCharge + 12 + Math.min(4, combo) * 2);
    if (flowCharge >= FLOW_MAX) activateFlow(now);
  }
  updateHud();

  for (const side of [-1, 1]) {
    const normal = cutAngle + Math.PI / 2;
    fruits.push({
      ...target,
      state: 'half',
      side,
      cutAngle,
      vx: target.vx + Math.cos(normal) * side * 145,
      vy: target.vy + Math.sin(normal) * side * 115 - 32,
      spin: side * 1.4,
      life: 0.88,
    });
  }

  burstFruit(target, cutAngle);
  addEffectText(target, combo >= 2 ? `×${combo}` : `+${gained}`, combo >= 2 ? '#efff9b' : '#fff3c8');
  slashFx = { x: target.x, y: target.y, angle: cutAngle, life: 0.16 };
  if (shakeEnabled) trauma = Math.min(1, trauma + 0.42);
  impactZoom = Math.max(impactZoom, shakeEnabled ? 0.018 : 0);
  hitStopUntil = Math.max(hitStopUntil, now + 52);
  audio.playSlice(target.kind as FruitSound);
}

function onBombHit(target: Target, cutAngle: number): void {
  lives = Math.max(0, lives - 1);
  combo = 0;
  flowCharge = 0;
  flowUntil = 0;
  flowWasActive = false;
  updateFlowHud();
  updateHud();
  burstBomb(target);
  addEffectText(target, lives > 0 ? '生命 -1' : '本局结束', '#ffb08f');
  slashFx = { x: target.x, y: target.y, angle: cutAngle, life: 0.22 };
  if (shakeEnabled) trauma = 1;
  impactZoom = Math.max(impactZoom, shakeEnabled ? 0.042 : 0);
  hitStopUntil = Math.max(hitStopUntil, performance.now() + 125);
  audio.playBomb();
  holdStatus(lives > 0 ? `炸弹！还剩 ${lives} 条生命` : '炸弹引爆了本局', 1100);

  if (lives === 0) {
    active = false;
    const finishedRun = runId;
    window.setTimeout(() => {
      if (runId === finishedRun && lives === 0) finishGame();
    }, 170);
  }
}

function slice(point: Point, enabled: boolean, at: number): void {
  cursor = point;
  if (!enabled) {
    previous = null;
    trail = [];
    return;
  }

  if (previous && at - previous.t < 150) {
    const speed = Math.hypot(point.x - previous.x, point.y - previous.y) / Math.max(0.001, (at - previous.t) / 1000);
    if (speed > 90) {
      const cutAngle = Math.atan2(point.y - previous.y, point.x - previous.x);
      const hits = fruits.filter((target) => target.state === 'whole' && intersects(previous!, point, target, target.r + 8));
      for (const target of hits) {
        const index = fruits.indexOf(target);
        if (index < 0) continue;
        fruits.splice(index, 1);
        if (target.kind === 'bomb') onBombHit(target, cutAngle);
        else onFruitCut(target, cutAngle);
      }
    }
  }

  previous = { ...point, t: at };
  trail.push({ ...point, t: at });
}

function updateSkeleton(frame: GestureFrame): void {
  const nextWidth = video.videoWidth || 320;
  const nextHeight = video.videoHeight || 240;
  if (skeleton.width !== nextWidth || skeleton.height !== nextHeight) {
    skeleton.width = skeletonWidth = nextWidth;
    skeleton.height = skeletonHeight = nextHeight;
  }
  skeletonCtx.clearRect(0, 0, skeletonWidth, skeletonHeight);
  skeletonCtx.save();
  skeletonCtx.setLineDash([4, 4]);
  skeletonCtx.strokeStyle = 'rgba(213,243,156,.5)';
  skeletonCtx.lineWidth = 1;
  skeletonCtx.strokeRect(
    GESTURE_REGION.x0 * skeletonWidth,
    GESTURE_REGION.y0 * skeletonHeight,
    (GESTURE_REGION.x1 - GESTURE_REGION.x0) * skeletonWidth,
    (GESTURE_REGION.y1 - GESTURE_REGION.y0) * skeletonHeight,
  );
  skeletonCtx.restore();
  for (const hand of frame.hands) {
    drawHand(skeletonCtx, hand.landmarks, skeletonWidth, skeletonHeight, {
      color: '#d5f39c',
      lineWidth: 2,
      jointRadius: 2,
    });
  }
}

const handOptions = {
  video,
  numHands: 1,
  camera: { audio: false, video: true } as MediaStreamConstraints,
  config: { pose: { experimental: false } },
  onFrame(frame: GestureFrame) {
    updateSkeleton(frame);
    if (!active || (mode !== 'camera' && mode !== 'bot')) return;
    const hand = frame.hands[0];
    if (!hand) {
      clearBlade();
      if (performance.now() >= statusHoldUntil) setStatus('未检测到手 · 请将手掌朝向镜头');
      return;
    }
    const point = toScreen(hand.landmarks[8], GESTURE_REGION);
    const cutting = hand.features.curl[1] < 0.55 && hand.pose !== 'fist';
    slice({ x: point.x * width, y: point.y * height }, cutting, performance.now());
    if (performance.now() >= statusHoldUntil) {
      setStatus(cutting ? '食指刀光已就绪 · 挥动切割' : '伸直食指开刀 · 握拳收刀');
    }
  },
};

let hands = createHands(handOptions);

function resetHands(): void {
  hands.stop();
  hands = createHands(handOptions);
}

function spawnTarget(forceBomb = false): void {
  if (fruits.filter((target) => target.state === 'whole').length >= 5) return;
  const bomb = forceBomb || (score >= 3 && Math.random() < 0.14);
  const kind: TargetKind = bomb ? 'bomb' : FRUIT_KINDS[Math.floor(Math.random() * FRUIT_KINDS.length)];
  fruits.push({
    id: nextTargetId++,
    kind,
    x: width * (bomb ? 0.32 + Math.random() * 0.36 : 0.22 + Math.random() * 0.56),
    y: height + 54,
    vx: (Math.random() - 0.5) * 120,
    vy: -Math.sqrt(2 * 520 * height * (0.7 + Math.random() * 0.12)),
    r: bomb ? Math.min(34, width * 0.045) : Math.min(38, width * 0.055),
    angle: Math.random() * Math.PI * 2,
    spin: Math.random() * 2 - 1,
    state: 'whole',
    side: 0,
    cutAngle: 0,
    life: 10,
  });
}

function begin(next: Mode): void {
  runId += 1;
  mode = next;
  active = true;
  score = 0;
  lives = 3;
  combo = 0;
  comboUntil = 0;
  fruits = [];
  particles = [];
  effectTexts = [];
  trauma = 0;
  impactZoom = 0;
  hitStopUntil = 0;
  flowCharge = 0;
  flowUntil = 0;
  flowWasActive = false;
  lastFlowPct = -1;
  lastFlowRunning = false;
  ambientLeaves = [];
  nextLeafAt = 0;
  spawnAt = performance.now() + 250;
  clearBlade();
  updateHud();
  updateFlowHud();
  $('welcome').style.display = 'none';
  $('gameover').hidden = true;
  syncModeButtons();
  setStatus(next === 'mouse'
    ? (mobileDevice ? '触屏控制 · 按住拖动切割' : '鼠标控制 · 按住划动切割')
    : '手势控制 · 小幅度移动即可覆盖全场');
}

function finishGame(): void {
  active = false;
  clearBlade();
  $('final-score').textContent = `切开 ${score} 个水果`;
  $('final-note').textContent = score >= 12 ? '刀光很利落，再来挑战更高的连击。' : '炸弹耗尽了你的生命。';
  $('gameover').hidden = false;
}

async function refreshDevices(): Promise<void> {
  try {
    const devices = await listCameras();
    const device = $<HTMLSelectElement>('device');
    const selected = device.value;
    device.replaceChildren(new Option('系统默认摄像头', ''));
    devices.forEach((item, index) => device.add(new Option(item.label || `摄像头 ${index + 1}`, item.deviceId)));
    if ([...device.options].some((option) => option.value === selected)) device.value = selected;
  } catch (error) {
    $('error').textContent = cameraError(error);
  }
}

$('refresh').onclick = () => void refreshDevices();
void refreshDevices();

let startingCamera = false;
$<HTMLButtonElement>('camera').onclick = async () => {
  if (startingCamera) return;
  startingCamera = true;
  void audio.unlock();
  const button = $<HTMLButtonElement>('camera');
  const mouseButton = $<HTMLButtonElement>('mouse');
  const device = $<HTMLSelectElement>('device');
  button.disabled = mouseButton.disabled = device.disabled = true;
  button.textContent = '正在打开摄像头…';
  $('error').textContent = '';
  const preview = document.querySelector('.preview') as HTMLElement;
  preview.style.display = 'block';
  preview.style.visibility = 'hidden';

  try {
    const selected = device.value;
    handOptions.camera = {
      audio: false,
      video: {
        ...(selected ? { deviceId: { exact: selected } } : {}),
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
      },
    };
    resetHands();
    try {
      await hands.startCamera();
    } catch (first) {
      if (!['NotReadableError', 'OverconstrainedError', 'TrackStartError'].includes((first as Error).name)) throw first;
      resetHands();
      handOptions.camera = { audio: false, video: selected ? { deviceId: { exact: selected } } : true };
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      await hands.startCamera();
    }
    hands.inject(null);
    begin('camera');
    preview.style.visibility = 'visible';
    preview.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    hands.tracker.onEnded = () => {
      clearBlade();
      $('stop').click();
      $('error').textContent = '摄像头连接已断开，请检查设备后重试。';
    };
    await refreshDevices();
  } catch (error) {
    resetHands();
    preview.style.display = 'none';
    $('error').textContent = cameraError(error);
    if (mode === 'mouse') holdStatus('无法开启摄像头 · 保持鼠标控制', 1800);
    else setStatus('摄像头启动失败');
    await refreshDevices();
  } finally {
    startingCamera = false;
    button.disabled = mouseButton.disabled = device.disabled = false;
    button.textContent = '开启摄像头';
  }
};

$('mouse').onclick = () => {
  void audio.unlock();
  resetHands();
  begin('mouse');
};

$('mode-mouse').onclick = () => {
  if (mode === 'mouse') return;
  if (mode === 'camera' || mode === 'bot') {
    resetHands();
    (document.querySelector('.preview') as HTMLElement).style.display = 'none';
  }
  begin('mouse');
};

$('mode-camera').onclick = () => {
  if (mode === 'camera' || mode === 'bot') return;
  $<HTMLButtonElement>('camera').click();
};

$('stop').onclick = () => {
  resetHands();
  active = false;
  mode = 'none';
  clearBlade();
  (document.querySelector('.preview') as HTMLElement).style.display = 'none';
  $('welcome').style.display = 'flex';
  $('gameover').hidden = true;
  syncModeButtons();
  setStatus('摄像头已停止');
};

$('reset').onclick = () => begin(mode === 'none' ? 'mouse' : mode);
$('again').onclick = () => begin(mode === 'none' ? 'mouse' : mode);

function toggleEffect(id: 'sound-toggle' | 'shake-toggle', enabled: boolean): void {
  const button = $<HTMLButtonElement>(id);
  button.classList.toggle('active', enabled);
  button.setAttribute('aria-pressed', String(enabled));
}

$('sound-toggle').onclick = () => {
  soundEnabled = !soundEnabled;
  audio.setMuted(!soundEnabled);
  if (soundEnabled) void audio.unlock();
  toggleEffect('sound-toggle', soundEnabled);
};
$('shake-toggle').onclick = () => {
  shakeEnabled = !shakeEnabled;
  if (!shakeEnabled) trauma = 0;
  toggleEffect('shake-toggle', shakeEnabled);
};
function pointer(event: PointerEvent): void {
  if (mode !== 'mouse' || !active) return;
  const rect = canvas.getBoundingClientRect();
  slice({ x: event.clientX - rect.left, y: event.clientY - rect.top }, pressed, performance.now());
}

canvas.onpointerdown = (event) => {
  pressed = true;
  canvas.setPointerCapture(event.pointerId);
  void audio.unlock();
  pointer(event);
};
canvas.onpointermove = pointer;
canvas.onpointerup = canvas.onpointercancel = () => {
  pressed = false;
  previous = null;
};

window.addEventListener('keydown', (event) => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(event.code)) {
    event.preventDefault();
    keys.add(event.code);
  }
});
window.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('blur', () => {
  keys.clear();
  pressed = false;
  clearBlade();
});
document.addEventListener('visibilitychange', () => {
  clearBlade();
  keys.clear();
  pressed = false;
  last = performance.now();
});
window.addEventListener('pagehide', () => hands.stop());

function render(now: number): void {
  requestAnimationFrame(render);
  const realDt = Math.min(0.04, Math.max(0, (now - last) / 1000));
  const gameDt = now < hitStopUntil ? 0 : realDt;
  last = now;

  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio, 2);
  width = rect.width;
  height = rect.height;
  if (width < 2 || height < 2) return;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    clearBlade();
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (active && !document.hidden && gameDt > 0) {
    if (now > spawnAt) {
      spawnTarget();
      spawnAt = now + Math.max(660, 930 - score * 7);
    }
    if (mode === 'mouse' && keys.size) {
      const point = cursor ?? { x: width / 2, y: height / 2 };
      slice({
        x: Math.max(0, Math.min(width, point.x + (
          (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0)
        ) * 520 * gameDt)),
        y: Math.max(0, Math.min(height, point.y + (
          (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0)
        ) * 520 * gameDt)),
      }, keys.has('Space'), now);
    }
    if (mode === 'bot') {
      const fruit = fruits.find((target) => target.state === 'whole' && target.kind !== 'bomb' && target.y < height * 0.78);
      const point = fruit
        ? fromScreen({
            x: Math.max(0, Math.min(1, (fruit.x + Math.sin(now / 65) * 58) / width)),
            y: Math.max(0, Math.min(1, fruit.y / height + 0.08)),
          })
        : { x: 0.5, y: 0.95 };
      hands.inject([syntheticHand(point.x, point.y, P.point)]);
    }

    for (const fruit of fruits) {
      fruit.vy += 520 * gameDt;
      fruit.x += fruit.vx * gameDt;
      fruit.y += fruit.vy * gameDt;
      fruit.angle += fruit.spin * gameDt;
      fruit.life -= gameDt;
    }
    fruits = fruits.filter((fruit) => fruit.y < height + 120 && fruit.life > 0);

    for (const particle of particles) {
      particle.life -= gameDt;
      particle.x += particle.vx * gameDt;
      particle.y += particle.vy * gameDt;
      particle.vy += 330 * gameDt;
      particle.vx *= 1 - Math.min(0.9, gameDt * 1.6);
    }
    particles = particles.filter((particle) => particle.life > 0);
    updateAmbient(gameDt, now);
  }

  trauma = Math.max(0, trauma - realDt * 1.55);
  impactZoom = Math.max(0, impactZoom - realDt * 0.16);
  if (combo && now > comboUntil) combo = 0;
  if (flowWasActive && !isFlowActive(now)) {
    flowWasActive = false;
    flowCharge = 0;
    if (active) holdStatus('流光耗尽 · 继续连击重新蓄能', 1200);
  }
  updateFlowHud(now);

  const shake = shakeEnabled ? trauma * trauma : 0;
  const shakeX = shake * (Math.sin(now * 0.052) * 10 + Math.sin(now * 0.097 + 1.7) * 4);
  const shakeY = shake * (Math.sin(now * 0.061 + 0.6) * 8 + Math.sin(now * 0.113) * 3);
  const zoom = 1 + (shakeEnabled ? impactZoom : 0);

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(shake * Math.sin(now * 0.043) * 0.008);
  ctx.scale(zoom, zoom);
  ctx.translate(-width / 2 + shakeX, -height / 2 + shakeY);

  drawAmbient();

  if (slashFx) {
    slashFx.life -= realDt;
    if (slashFx.life > 0) {
      ctx.save();
      ctx.translate(slashFx.x, slashFx.y);
      ctx.rotate(slashFx.angle);
      ctx.globalAlpha = Math.max(0, slashFx.life / 0.16);
      ctx.strokeStyle = isFlowActive(now) ? 'rgba(112,255,204,.5)' : 'rgba(255,146,77,.45)';
      ctx.lineWidth = 20;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-74, 0);
      ctx.lineTo(74, 0);
      ctx.stroke();
      ctx.strokeStyle = '#fffbd5';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(-58, 0);
      ctx.lineTo(58, 0);
      ctx.stroke();
      ctx.restore();
    }
  }

  for (const fruit of fruits) drawTarget(fruit, now);
  drawParticles();

  for (const effect of effectTexts) {
    effect.life -= realDt;
    if (effect.life <= 0) continue;
    const progress = 1 - effect.life / effect.maxLife;
    const enter = Math.min(1, progress / 0.2);
    const scale = 1 + 2.70158 * (enter - 1) ** 3 + 1.70158 * (enter - 1) ** 2;
    ctx.save();
    ctx.globalAlpha = Math.min(1, effect.life * 3);
    ctx.fillStyle = effect.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 22px Georgia, "Microsoft YaHei", sans-serif';
    ctx.translate(effect.x, effect.y - progress * 42);
    ctx.scale(scale, scale);
    ctx.fillText(effect.text, 0, 0);
    ctx.restore();
  }
  effectTexts = effectTexts.filter((effect) => effect.life > 0);

  drawTrail();
  if (cursor) {
    ctx.strokeStyle = '#efffd0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, 8, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

requestAnimationFrame(render);
if (bot) begin('bot');
else if (mobileDevice) {
  $('mode-mouse').textContent = '触屏控制';
  $('mouse').textContent = '进入触屏游戏';
  begin('mouse');
}

Object.assign(window, {
  __fruit: {
    get hands() { return hands; },
    get score() { return score; },
    get lives() { return lives; },
    get fruits() { return fruits; },
    get active() { return active; },
    get mode() { return mode; },
    get trauma() { return trauma; },
    get flowCharge() { return flowCharge; },
    get flowActive() { return isFlowActive(); },
    get hitStopping() { return performance.now() < hitStopUntil; },
    audio,
    slice,
    begin,
    activateFlow: () => activateFlow(performance.now()),
    spawnBomb: () => spawnTarget(true),
  },
});
