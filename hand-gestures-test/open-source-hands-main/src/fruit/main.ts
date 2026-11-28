import { listCameras, cameraError } from './camera';
import { paintOrchard } from './scenery';
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
import { bladeSpeed, hitTime, swingBonus, type BladeSample, type Point } from './rules';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('game');
const ctx = canvas.getContext('2d')!;
const scenery = $<HTMLCanvasElement>('scenery');
const video = $<HTMLVideoElement>('video');
const skeleton = $<HTMLCanvasElement>('skeleton');
const skeletonCtx = skeleton.getContext('2d')!;
const GESTURE_REGION = { x0: 0.26, x1: 0.74, y0: 0.1, y1: 0.76 };

type Mode = 'none' | 'camera' | 'mouse' | 'bot';
type FruitKind = FruitSound;
type TargetKind = FruitKind | 'bomb';
type TargetState = 'whole' | 'half';
type RoundMode = 'classic' | 'arcade';
const ARCADE_DURATION = 60_000;
const SPAWN_INTERVAL_SCALE = 0.75;
const MAX_WHOLE_TARGETS = 10;

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
  rarity?: 'gold' | 'ice';
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
  strawberry: { rind: '#ee365d', rindDark: '#8b1644', flesh: '#ffd3ca', glow: '#ff896f', seed: '#ffdc8e' },
  kiwi: { rind: '#906740', rindDark: '#553b28', flesh: '#a7df5b', glow: '#d6a467', seed: '#29251c' },
};
const FRUIT_KINDS = Object.keys(FRUIT_STYLES) as FruitKind[];
const FLOW_DURATION = 7000;
const FLOW_MAX = 100;
const audio = new GameAudio();

let mode: Mode = 'none';
let active = false;
let roundMode: RoundMode = 'classic';
let roundTime = 0;
let iceUntil = 0;
let calibrating = false;
let handSeenAt = 0;
let lastTimer = -1;
let best = 0;
let cutCount = 0;
let maxStreak = 0;
let swingHits = 0;
let maxSwing = 0;
let lastFastSample = -Infinity;
let activePointer: number | null = null;
let gestureId: number | null = null;

const pauseMenu = $<HTMLDialogElement>('pause-menu');
const preview = document.querySelector<HTMLElement>('.preview')!;
let score = 0;
let lives = 3;
let combo = 0;
let comboUntil = 0;
let fruits: Target[] = [];
let particles: Particle[] = [];
let effectTexts: EffectText[] = [];
let trail: (Point & { t: number })[] = [];
let previous: BladeSample | null = null;
let cursor: Point | null = null;
let slashFx: SlashFx | null = null;
let last = 0;
let spawnAt = 0;
let nextTargetId = 1;
let runId = 0;
let width = 1;
let height = 1;
let pixelRatio = 1;
let skeletonWidth = 0;
let skeletonHeight = 0;
let statusText = '';
let statusHoldUntil = 0;
let trauma = 0;
let hitStopUntil = 0;
let impactZoom = 0;
const motionPreference = readPreference('motion');
let shakeEnabled = motionPreference ? motionPreference === 'on' : !matchMedia('(prefers-reduced-motion: reduce)').matches;
let soundEnabled = readPreference('sound') !== 'off';
let previewEnabled = true;
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

function readPreference(key: string): string | null {
  try { return localStorage.getItem('slice-arena:' + key); } catch { return null; }
}

function savePreference(key: string, value: string): void {
  try { localStorage.setItem('slice-arena:' + key, value); } catch { /* Storage can be unavailable. */ }
}

function updateHud(): void {
  $('score').textContent = String(score);
  $('best').textContent = String(best);
  $('lives').textContent = String(lives);
}

function updateTimer(): void {
  if (roundMode !== 'arcade') return;
  const seconds = Math.max(0, Math.ceil((ARCADE_DURATION - roundTime) / 1000));
  if (seconds === lastTimer) return;
  lastTimer = seconds;
  $('timer').textContent = String(seconds);
  $('timer-stat').classList.toggle('urgent', seconds <= 10);
  if (active && seconds > 0 && seconds <= 5) audio.playCue('countdown');
}

function selectRound(next: RoundMode): void {
  roundMode = next;
  best = Number(readPreference('best:' + next)) || 0;
  $('arcade').setAttribute('aria-pressed', String(next === 'arcade'));
  $('classic').setAttribute('aria-pressed', String(next === 'classic'));
  $('timer-stat').hidden = next !== 'arcade';
  $('lives-stat').hidden = next !== 'classic';
  $('round-rules').textContent = next === 'arcade'
    ? '切水果得分，炸弹扣 30 分。60 秒内挑战最高分。'
    : '避开炸弹，护盾用完时结算。';
  lastTimer = -1;
  updateTimer();
  updateHud();
}

function isFlowActive(now = roundTime): boolean {
  return now < flowUntil;
}

function updateFlowHud(now = roundTime): void {
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
  swingHits = 0;
  lastFastSample = -Infinity;
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
  } else if (kind === 'strawberry') {
    ctx.moveTo(0, -radius * 0.66);
    ctx.bezierCurveTo(-radius * 1.42, -radius * 1.12, -radius * 1.03, radius * 0.4, 0, radius);
    ctx.bezierCurveTo(radius * 1.03, radius * 0.4, radius * 1.42, -radius * 1.12, 0, -radius * 0.66);
  } else if (kind === 'kiwi') {
    ctx.ellipse(0, 0, radius, radius * 0.8, 0, 0, Math.PI * 2);
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
  if (kind === 'orange' || kind === 'strawberry' || kind === 'kiwi') {
    ctx.fillStyle = kind === 'strawberry' ? style.seed : 'rgba(83,48,20,.3)';
    for (let i = 0; i < 22; i++) {
      const angle = i * 2.399;
      const distance = radius * (0.18 + ((i * 37) % 60) / 100);
      ctx.beginPath();
      ctx.ellipse(
        Math.cos(angle) * distance, Math.sin(angle) * distance,
        radius * (kind === 'strawberry' ? 0.055 : 0.028), radius * 0.022, angle, 0, Math.PI * 2,
      );
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
  const flesh = ctx.createRadialGradient(-radius * 0.18, -radius * 0.2, 1, 0, 0, radius);
  flesh.addColorStop(0, '#fff2bf');
  flesh.addColorStop(0.63, style.flesh);
  flesh.addColorStop(1, style.rind);
  ctx.fillStyle = flesh;
  ctx.beginPath();
  ctx.ellipse(0, 0, radius * 0.84, radius * (kind === 'kiwi' ? 0.68 : 0.84), 0, 0, Math.PI * 2);
  ctx.fill();

  if (kind === 'kiwi' || kind === 'strawberry') {
    ctx.fillStyle = kind === 'kiwi' ? '#28301d' : '#f8ddb3';
    for (let i = 0; i < 15; i++) {
      const angle = i * Math.PI * 2 / 15;
      ctx.beginPath();
      ctx.ellipse(Math.cos(angle) * radius * 0.51, Math.sin(angle) * radius * 0.45, radius * 0.045, radius * 0.023, angle, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind === 'orange' || kind === 'lime') {
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
  ctx.rotate(target.state === 'half' ? target.cutAngle + target.angle : target.angle);
  ctx.globalAlpha = target.state === 'half' ? Math.min(1, target.life * 2.3) : Math.min(1, target.life);

  if (target.state === 'whole' && target.kind !== 'bomb' && (target.rarity || isFlowActive())) {
    ctx.save();
    ctx.strokeStyle = target.rarity === 'ice' ? '#a8ecff' : target.rarity === 'gold' ? '#ffe897' : 'rgba(255,235,151,.42)';
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
    if (target.rarity) {
      ctx.fillStyle = target.rarity === 'ice' ? '#a8ecff' : '#ffe897';
      ctx.font = `700 ${target.r * 0.6}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText(target.rarity === 'ice' ? '❄' : '✦', 0, -target.r * 1.38);
    }
    drawFruitBody(target.kind, target.r);
    ctx.strokeStyle = '#9f7443';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -target.r * 0.72);
    ctx.lineTo(target.r * 0.08, -target.r * 1.08);
    ctx.stroke();
    if (target.kind === 'strawberry') {
      for (let i = 0; i < 3; i++) {
        ctx.save();
        ctx.rotate((i - 1) * 0.38);
        drawLeaf(target.r * 0.78, -0.9);
        ctx.restore();
      }
    } else if (target.kind !== 'watermelon') drawLeaf(target.r, target.kind === 'orange' ? -1.02 : -0.82);
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
  ctx.rect(-target.r - 8, target.side < 0 ? -target.r - 8 : 0, target.r * 2 + 16, target.r + 8);
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
  trail = trail.filter((point) => performance.now() - point.t < 160);
  if (trail.length < 2) return;
  const flowing = isFlowActive();
  const now = performance.now();
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 1; i < trail.length; i++) {
    const end = trail[i];
    const strength = Math.max(0, 1 - (now - end.t) / 160);
    ctx.beginPath();
    ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
    ctx.lineTo(end.x, end.y);
    if (shakeEnabled) {
      ctx.globalAlpha = strength * 0.34;
      ctx.strokeStyle = flowing ? '#ffe480' : '#4fe8ef';
      ctx.lineWidth = 14 * strength + 2;
      ctx.stroke();
    }
    ctx.globalAlpha = strength * 0.88;
    ctx.strokeStyle = flowing ? '#fff6b1' : '#e7ffff';
    ctx.lineWidth = 4 * strength + 1;
    ctx.stroke();
  }
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
  if (particles.length < (shakeEnabled ? 150 : 65)) particles.push(particle);
}

function burstFruit(target: Target, cutAngle: number, special: boolean): void {
  const style = fruitStyle(target.kind as FruitKind);
  for (let i = 0; i < (shakeEnabled ? (special ? 22 : 14) : 6); i++) {
    const angle = cutAngle + Math.PI / 2 * (i % 2 ? 1 : -1) + (Math.random() - 0.5) * 0.72;
    const speed = 80 + Math.random() * 210;
    addParticle({
      x: target.x,
      y: target.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 45,
      size: 2 + Math.random() * 4.2,
      color: special && i % 3 === 0 ? '#ffda72' : i % 3 ? style.flesh : style.rind,
      life: 0.45 + Math.random() * 0.38,
      maxLife: 0.83,
      kind: 'juice',
    });
  }
}

function burstBomb(target: Target): void {
  const colors = ['#fff2a2', '#ffbe4f', '#ff7549', '#ff3b37', '#d9e2e4'];
  for (let i = 0; i < (shakeEnabled ? 32 : 10); i++) {
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
    y: target.y - target.r - 12,
    text,
    color,
    life: 0.72,
    maxLife: 0.72,
  });
}

function onFruitCut(target: Target, cutAngle: number): void {
  const flowActive = isFlowActive();
  const critical = roundMode === 'arcade' && !target.rarity && Math.random() < 0.05;
  const special = critical || !!target.rarity;
  const base = roundMode === 'classic' ? 1 : target.rarity === 'gold' ? 40 : critical ? 15 : 10;
  if (target.rarity === 'ice' && roundTime >= iceUntil) {
    iceUntil = roundTime + 5000;
    holdStatus('冰冻果 · 减速 5 秒', 2000);
  }
  const gained = base * (flowActive ? 2 : 1);
  swingHits += 1;
  maxSwing = Math.max(maxSwing, swingHits);
  const bonus = roundMode === 'arcade' ? swingBonus(swingHits) - swingBonus(swingHits - 1) : 0;
  score += gained + bonus;
  cutCount += 1;
  combo = roundTime < comboUntil ? combo + 1 : 1;
  comboUntil = roundTime + 900;
  maxStreak = Math.max(maxStreak, combo);
  if (!flowActive) {
    flowCharge = Math.min(FLOW_MAX, flowCharge + 12 + Math.min(4, combo) * 2);
    if (flowCharge >= FLOW_MAX) activateFlow(roundTime);
  }
  updateHud();

  for (const side of [-1, 1]) {
    const normal = cutAngle + Math.PI / 2;
    fruits.push({
      ...target,
      state: 'half',
      side,
      cutAngle,
      x: target.x + Math.cos(normal) * side * 2.5,
      y: target.y + Math.sin(normal) * side * 2.5,
      vx: target.vx + Math.cos(normal) * side * 145,
      vy: target.vy + Math.sin(normal) * side * 115 - 32,
      angle: 0,
      spin: target.spin * 0.45 - side * 1.85,
      life: 0.88,
    });
  }

  burstFruit(target, cutAngle, special);
  const label = target.rarity === 'gold' ? '金果 ' : target.rarity === 'ice' ? '冰冻 ' : critical ? '暴击 ' : '';
  const color = target.rarity === 'ice' ? '#a8ecff' : special ? '#ffe489' : '#fff3c8';
  addEffectText(target, `${label}+${gained + bonus}`, color);
  if (swingHits === 3) {
    addEffectText({ ...target, x: width / 2, y: height * 0.28 }, '三果连切', '#a8ffff');
    audio.playCue('combo');
  } else if (combo === 5 || combo === 10 || combo === 20) {
    holdStatus(`连续命中 ${combo} 次`);
  }
  slashFx = { x: target.x, y: target.y, angle: cutAngle, life: 0.16 };
  if (shakeEnabled && special) {
    trauma = Math.min(0.6, trauma + 0.26);
    impactZoom = Math.max(impactZoom, 0.014);
    hitStopUntil = Math.max(hitStopUntil, performance.now() + 30);
  }
  audio.playSlice(target.kind as FruitSound);
  if (special) audio.playCue('special');
}

function onBombHit(target: Target, cutAngle: number): void {
  const arcade = roundMode === 'arcade';
  if (arcade) score = Math.max(0, score - 30);
  else lives = Math.max(0, lives - 1);
  combo = 0;
  comboUntil = 0;
  swingHits = 0;
  flowCharge = 0;
  flowUntil = 0;
  flowWasActive = false;
  updateFlowHud();
  updateHud();
  burstBomb(target);
  addEffectText(target, arcade ? '−30 分' : lives > 0 ? '护盾 −1' : '本局结束', '#ffb08f');
  slashFx = { x: target.x, y: target.y, angle: cutAngle, life: 0.22 };
  if (shakeEnabled) {
    trauma = 0.78;
    impactZoom = Math.max(impactZoom, 0.025);
    hitStopUntil = Math.max(hitStopUntil, performance.now() + 85);
  }
  audio.playBomb();
  holdStatus(arcade ? '炸弹命中 · 扣 30 分' : `炸弹命中 · 剩余 ${lives} 个护盾`, 1100);

  if (lives === 0) {
    active = false;
    $<HTMLButtonElement>('pause').disabled = true;
    clearBlade();
    const finishedRun = runId;
    window.setTimeout(() => {
      if (runId === finishedRun && lives === 0) finishGame('护盾耗尽');
    }, 170);
  }
}

function slice(point: Point, enabled: boolean, at: number): void {
  if (!active || pauseMenu.open || document.hidden) return;
  cursor = point;
  if (!enabled) {
    previous = null;
    swingHits = 0;
    return;
  }

  const sample = { ...point, t: at };
  const start = previous;
  previous = sample;
  if (!start) return;
  const elapsed = at - start.t;
  const gesture = mode === 'camera' || mode === 'bot';
  const jumped = gesture && Math.hypot(point.x - start.x, point.y - start.y) > Math.hypot(width, height) * 0.34;
  if (elapsed >= 120 || jumped) {
    trail = [];
    swingHits = 0;
    return;
  }

  const minSpeed = gesture ? Math.max(125, width * 0.27) : 90;
  if (bladeSpeed(start, sample) <= minSpeed) return;
  if (at - lastFastSample >= 150) swingHits = 0;
  if (at - lastFastSample > 48) trail = [start];
  trail.push(sample);
  lastFastSample = at;

  if (calibrating) {
    calibrating = false;
    handSeenAt = performance.now();
    holdStatus('校准完成 · 开始切水果');
    clearBlade();
    return;
  }
  const cutAngle = Math.atan2(point.y - start.y, point.x - start.x);
  const hits = fruits.flatMap((target) => {
    if (target.state !== 'whole') return [];
    const time = hitTime(start, point, target, target.r + 8);
    return time === null ? [] : [{ target, time }];
  }).sort((a, b) => a.time - b.time || a.target.id - b.target.id);
  for (const { target } of hits) {
    if (!active) break;
    fruits.splice(fruits.indexOf(target), 1);
    if (target.kind === 'bomb') onBombHit(target, cutAngle);
    else onFruitCut(target, cutAngle);
  }
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
    if (!active || pauseMenu.open || (mode !== 'camera' && mode !== 'bot')) return;
    if (mode === 'camera' && previewEnabled) updateSkeleton(frame);
    const hand = frame.hands[0];
    if (!hand) {
      gestureId = null;
      clearBlade();
      if (performance.now() >= statusHoldUntil) setStatus(calibrating ? '校准 · 请将手掌朝向镜头' : '未检测到手 · 请将手掌朝向镜头');
      return;
    }
    handSeenAt = performance.now();
    if (gestureId !== hand.id) clearBlade();
    gestureId = hand.id;
    const point = toScreen(hand.landmarks[8], GESTURE_REGION);
    const cutting = hand.features.curl[1] < 0.55 && hand.pose !== 'fist';
    slice({ x: point.x * width, y: point.y * height }, cutting, performance.now());
    if (performance.now() >= statusHoldUntil) {
      setStatus(calibrating ? '校准 · 伸直食指试挥一次' : cutting ? '食指刀光已就绪 · 挥动切割' : '伸直食指开刀 · 握拳收刀');
    }
  },
};

let hands = createHands(handOptions);

function resetHands(): void {
  hands.stop();
  video.srcObject = null;
  hands = createHands(handOptions);
}

function spawnTarget(forceBomb = false, lane?: number, fruitOnly = false): void {
  if (!forceBomb && fruits.filter((target) => target.state === 'whole').length >= MAX_WHOLE_TARGETS) return;
  const arcade = roundMode === 'arcade';
  const bombEligible = !fruitOnly && (arcade ? roundTime >= 8000 : score >= 3);
  // More waves per second, with a lower bomb chance per eligible wave.
  const bomb = forceBomb || (bombEligible && Math.random() < 0.15 * SPAWN_INTERVAL_SCALE);
  const kind: TargetKind = bomb ? 'bomb' : FRUIT_KINDS[Math.floor(Math.random() * FRUIT_KINDS.length)];
  const rareRoll = arcade && !bomb && roundTime >= 12_000 ? Math.random() : 1;
  fruits.push({
    id: nextTargetId++,
    kind,
    x: width * (lane ?? (bomb ? 0.32 + Math.random() * 0.36 : 0.22 + Math.random() * 0.56)),
    rarity: rareRoll < 0.055 ? 'gold' : rareRoll < 0.095 && roundTime >= iceUntil ? 'ice' : undefined,
    y: height + 54,
    vx: (Math.random() - 0.5) * Math.min(width * (lane === undefined ? 0.22 : 0.04), 120),
    vy: -Math.sqrt(2 * 520 * height * (0.7 + Math.random() * (lane === undefined ? 0.12 : 0.025))),
    r: bomb ? Math.min(34, width * 0.045) : Math.min(38, width * 0.055),
    angle: Math.random() * Math.PI * 2,
    spin: Math.random() * 2 - 1,
    state: 'whole',
    side: 0,
    cutAngle: 0,
    life: 10,
  });
}

function setMode(next: Mode): void {
  mode = next;
  calibrating = next === 'camera' && roundTime === 0;
  handSeenAt = performance.now();
  gestureId = null;
  activePointer = null;
  keys.clear();
  clearBlade();
  syncModeButtons();
  $('preview-toggle').hidden = next !== 'camera';
  preview.style.display = next === 'camera' && previewEnabled ? 'block' : 'none';
  $<HTMLButtonElement>('stop').hidden = next !== 'camera';
  setStatus(next === 'mouse'
    ? (mobileDevice ? '触屏控制 · 按住拖动切割' : '鼠标控制 · 按住划动切割')
    : calibrating ? '校准 · 伸直食指试挥一次' : '手势控制 · 伸直食指挥动');
}

function setMenuOpen(open: boolean): void {
  $('stage').classList.toggle('menu-open', open);
  canvas.inert = open;
  for (const overlay of document.querySelectorAll<HTMLElement>('.topline, .bottomline')) overlay.inert = open;
}

function begin(next: Mode): void {
  runId += 1;
  active = true;
  if (pauseMenu.open) pauseMenu.close();
  $<HTMLButtonElement>('pause').disabled = false;
  roundTime = 0;
  lastTimer = -1;
  iceUntil = 0;
  last = performance.now();
  cutCount = maxStreak = maxSwing = 0;
  activePointer = null;
  keys.clear();
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
  spawnAt = 250;
  slashFx = null;
  statusHoldUntil = 0;
  setMode(next);
  updateTimer();
  updateHud();
  updateFlowHud();
  $('welcome').style.display = 'none';
  $('gameover').hidden = true;
  setMenuOpen(false);
  canvas.focus({ preventScroll: true });
}

function finishGame(reason: string): void {
  active = false;
  clearBlade();
  $<HTMLButtonElement>('pause').disabled = true;
  const record = score > best && mode !== 'bot';
  if (record) {
    best = score;
    savePreference('best:' + roundMode, String(best));
    updateHud();
  }
  $('final-score').textContent = `${score} 分${record ? ' · 新纪录' : ''}`;
  $('final-note').textContent = `${reason} · 切开 ${cutCount} 个 · 最长连续命中 ${maxStreak} · 单刀最多 ${maxSwing} 个`;
  $('gameover').hidden = false;
  setMenuOpen(true);
  $('again').focus();
}

function showMenu(): void {
  runId += 1;
  if (!startingCamera) resetHands();
  active = false;
  if (pauseMenu.open) pauseMenu.close();
  activePointer = null;
  keys.clear();
  setMode('none');
  roundTime = 0;
  updateTimer();
  setStatus('等待开始');
  $<HTMLButtonElement>('pause').disabled = true;
  $('welcome').style.display = 'flex';
  $('gameover').hidden = true;
  $('error').textContent = '';
  setMenuOpen(true);
  $(roundMode).focus();
}

function pauseGame(reason = '游戏暂停'): void {
  if (!active || pauseMenu.open) return;
  clearBlade();
  keys.clear();
  activePointer = null;
  $('pause-title').textContent = reason;
  pauseMenu.showModal();
}

pauseMenu.addEventListener('close', () => {
  last = performance.now();
  handSeenAt = last;
  if (active) canvas.focus({ preventScroll: true });
});
$('pause').onclick = () => pauseGame();
$('resume').onclick = () => pauseMenu.close();
$('pause-exit').onclick = $('result-menu').onclick = showMenu;
$('arcade').onclick = () => selectRound('arcade');
$('classic').onclick = () => selectRound('classic');

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
  const device = $<HTMLSelectElement>('device');
  button.disabled = device.disabled = true;
  button.textContent = '正在打开摄像头…';
  $('error').textContent = '';
  const cameraRun = runId;

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
      if (cameraRun !== runId) throw first;
      if (!['NotReadableError', 'OverconstrainedError', 'TrackStartError'].includes((first as Error).name)) throw first;
      resetHands();
      handOptions.camera = { audio: false, video: selected ? { deviceId: { exact: selected } } : true };
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      if (cameraRun === runId) await hands.startCamera();
    }
    if (cameraRun !== runId) {
      resetHands();
      return;
    }
    const stream = video.srcObject;
    if (!(stream instanceof MediaStream) || !stream.getVideoTracks().some((track) => track.readyState === 'live')) {
      throw new DOMException('Camera stream is unavailable', 'NotReadableError');
    }
    hands.inject(null);
    if (active) {
      setMode('camera');
      if (!pauseMenu.open) canvas.focus({ preventScroll: true });
    } else begin('camera');
    preview.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    hands.tracker.onEnded = () => {
      resetHands();
      setMode('mouse');
      holdStatus('摄像头已断开 · 已切换备用控制', 2500);
    };
    void refreshDevices();
  } catch (error) {
    resetHands();
    if (cameraRun !== runId) return;
    preview.style.display = 'none';
    $('error').textContent = cameraError(error);
    if (mode === 'mouse') holdStatus('无法开启摄像头 · 保持鼠标控制', 1800);
    else setStatus('摄像头启动失败');
    await refreshDevices();
  } finally {
    startingCamera = false;
    button.disabled = device.disabled = false;
    button.textContent = '开启摄像头';
  }
};

$('mouse').onclick = () => {
  void audio.unlock();
  if (!startingCamera) resetHands();
  begin('mouse');
};

$('mode-mouse').onclick = () => {
  if (mode === 'mouse' && !startingCamera) return;
  if (startingCamera) runId += 1;
  void audio.unlock();
  if (!startingCamera) resetHands();
  if (active) {
    setMode('mouse');
    canvas.focus({ preventScroll: true });
  } else begin('mouse');
};

$('mode-camera').onclick = () => {
  if (mode === 'camera' || mode === 'bot') return;
  $<HTMLButtonElement>('camera').click();
};

$('stop').onclick = showMenu;
$('preview-toggle').onclick = () => {
  previewEnabled = !previewEnabled;
  preview.style.display = previewEnabled ? 'block' : 'none';
  toggleEffect('preview-toggle', previewEnabled);
};

$('reset').onclick = () => begin(mode === 'none' ? 'mouse' : mode);
$('again').onclick = () => begin(mode === 'none' ? 'mouse' : mode);

function toggleEffect(id: string, enabled: boolean): void {
  const button = $<HTMLButtonElement>(id);
  button.classList.toggle('active', enabled);
  button.setAttribute('aria-pressed', String(enabled));
}

$('sound-toggle').onclick = () => {
  soundEnabled = !soundEnabled;
  audio.setMuted(!soundEnabled);
  if (soundEnabled) void audio.unlock();
  toggleEffect('sound-toggle', soundEnabled);
  savePreference('sound', soundEnabled ? 'on' : 'off');
};
$('shake-toggle').onclick = () => {
  shakeEnabled = !shakeEnabled;
  if (!shakeEnabled) trauma = impactZoom = hitStopUntil = 0;
  toggleEffect('shake-toggle', shakeEnabled);
  $('stage').classList.toggle('reduced-fx', !shakeEnabled);
  savePreference('motion', shakeEnabled ? 'on' : 'off');
};
function pointer(event: PointerEvent): void {
  if (mode !== 'mouse' || !active || (activePointer !== null && event.pointerId !== activePointer)) return;
  const rect = canvas.getBoundingClientRect();
  slice({ x: event.clientX - rect.left, y: event.clientY - rect.top }, activePointer !== null, event.timeStamp);
}

canvas.onpointerdown = (event) => {
  if (mode !== 'mouse' || !active || pauseMenu.open || activePointer !== null || event.button !== 0) return;
  clearBlade();
  activePointer = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  void audio.unlock();
  pointer(event);
};
canvas.onpointermove = pointer;
canvas.onpointerup = canvas.onpointercancel = canvas.onlostpointercapture = (event) => {
  if (event.pointerId !== activePointer) return;
  activePointer = null;
  previous = null;
  swingHits = 0;
};

window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && active && !pauseMenu.open) {
    event.preventDefault();
    pauseGame();
    return;
  }
  if (mode !== 'mouse' || !active || pauseMenu.open || (event.target instanceof HTMLElement && event.target.closest('button, select, a'))) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(event.code)) {
    event.preventDefault();
    keys.add(event.code);
  }
});
window.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('blur', () => {
  keys.clear();
  activePointer = null;
  clearBlade();
});
document.addEventListener('visibilitychange', () => {
  clearBlade();
  keys.clear();
  activePointer = null;
  last = performance.now();
  if (document.hidden) pauseGame();
});
window.addEventListener('pagehide', () => {
  runId += 1;
  if (!startingCamera) {
    hands.stop();
    video.srcObject = null;
  }
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted && mode === 'camera') {
    setMode('mouse');
    holdStatus('已切换备用控制，可重新开启摄像头');
  }
});

function resizeArena(): void {
  const rect = canvas.getBoundingClientRect();
  pixelRatio = Math.min(devicePixelRatio, 2);
  if (rect.width < 2 || rect.height < 2) return;
  if (width !== rect.width || height !== rect.height) {
    for (const target of fruits) {
      target.x *= rect.width / width;
      target.y *= rect.height / height;
    }
  }
  width = rect.width;
  height = rect.height;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  paintOrchard(scenery, width, height, Math.min(pixelRatio, 1.5));
  clearBlade();
}

function render(now: number): void {
  requestAnimationFrame(render);
  const elapsed = Math.max(0, now - last);
  if (mode === 'camera' && !calibrating && now - handSeenAt >= 2200) pauseGame('手势失去跟踪');
  const running = active && !calibrating && !pauseMenu.open && !document.hidden;
  const realDt = Math.min(0.04, elapsed / 1000);
  const gameDt = running && now >= hitStopUntil ? realDt : 0;
  last = now;

  if (Math.min(devicePixelRatio, 2) !== pixelRatio) resizeArena();
  if (width < 2 || height < 2) return;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (running) {
    roundTime += elapsed;
    updateTimer();
    if (roundMode === 'arcade' && roundTime >= ARCADE_DURATION) finishGame('时间到');
  }

  if (active && gameDt > 0) {
    if (roundTime >= spawnAt) {
      let interval: number;
      if (roundMode === 'arcade') {
        const progress = Math.min(1, roundTime / ARCADE_DURATION);
        if (roundTime > 5000 && Math.random() < 0.45 + progress * 0.45) {
          const count = roundTime > 13_000 ? 3 : 2;
          const offset = (Math.random() - 0.5) * 0.10;
          for (let index = 0; index < count; index++) {
            spawnTarget(false, 0.5 + offset + (index - (count - 1) / 2) * 0.23, true);
          }
        } else spawnTarget();
        interval = (1050 - 400 * progress) * (isFlowActive() ? 0.79 : 1);
      } else {
        spawnTarget();
        interval = Math.max(660, 930 - score * 7);
      }
      spawnAt = roundTime + interval * SPAWN_INTERVAL_SCALE;
    }
    if (mode === 'mouse' && keys.size && activePointer === null) {
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
            y: Math.max(0, Math.min(1, fruit.y / height)),
          }, GESTURE_REGION)
        : { x: 0.5, y: 0.95 };
      hands.inject([syntheticHand(point.x, point.y, P.point)]);
    }

    for (const fruit of fruits) {
      const fruitDt = roundTime < iceUntil && fruit.state === 'whole' && fruit.kind !== 'bomb' ? gameDt * 0.55 : gameDt;
      fruit.vy += 520 * fruitDt;
      fruit.x += fruit.vx * fruitDt;
      fruit.y += fruit.vy * fruitDt;
      fruit.angle += fruit.spin * fruitDt;
      fruit.life -= fruitDt;
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
    if (shakeEnabled) updateAmbient(gameDt, now);
  }

  trauma = Math.max(0, trauma - realDt * 1.55);
  impactZoom = Math.max(0, impactZoom - realDt * 0.16);
  if (combo && roundTime > comboUntil) combo = 0;
  if (flowWasActive && !isFlowActive()) {
    flowWasActive = false;
    flowCharge = 0;
    if (active) holdStatus('流光耗尽 · 继续连击重新蓄能', 1200);
  }
  updateFlowHud();

  const shake = shakeEnabled ? trauma * trauma : 0;
  const shakeX = shake * (Math.sin(now * 0.052) * 10 + Math.sin(now * 0.097 + 1.7) * 4);
  const shakeY = shake * (Math.sin(now * 0.061 + 0.6) * 8 + Math.sin(now * 0.113) * 3);
  const zoom = 1 + (shakeEnabled ? impactZoom : 0);

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(shake * Math.sin(now * 0.043) * 0.008);
  ctx.scale(zoom, zoom);
  ctx.translate(-width / 2 + shakeX, -height / 2 + shakeY);

  if (shakeEnabled) drawAmbient();

  if (slashFx) {
    slashFx.life -= realDt;
    if (slashFx.life > 0 && shakeEnabled) {
      ctx.save();
      ctx.translate(slashFx.x, slashFx.y);
      ctx.rotate(slashFx.angle);
      ctx.globalAlpha = Math.max(0, slashFx.life / 0.16);
      ctx.strokeStyle = isFlowActive() ? 'rgba(112,255,204,.5)' : 'rgba(79,232,239,.5)';
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
    ctx.strokeStyle = '#102a2b';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(effect.text, 0, 0);
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

selectRound('classic');
$('stop').hidden = true;
$('stage').classList.toggle('reduced-fx', !shakeEnabled);
toggleEffect('shake-toggle', shakeEnabled);
toggleEffect('sound-toggle', soundEnabled);
audio.setMuted(!soundEnabled);
resizeArena();
new ResizeObserver(resizeArena).observe(canvas);
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
    activateFlow: () => activateFlow(roundTime),
    spawnBomb: () => spawnTarget(true),
  },
});
