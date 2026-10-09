const VIDEO_URL = 'movie.mp4';
const ENERGY_PER_SWIPE = 2;
const MAX_ENERGY = 2;
const HALF_LIFE = 0.35;
const MAX_RATE = 2;
const MIN_RATE = 0.1;
const RATE_STEP = 0.05;
const RATE_UPDATE_MS = 80;
const NUM_CARDS = 2001;
const START_CARD = 1000;

const feed = document.getElementById('feed');
const progressBar = document.querySelector('#progress div');
const hint = document.getElementById('hint');

const cards = document.createDocumentFragment();
for (let i = 0; i < NUM_CARDS; i++) {
  const card = document.createElement('div');
  card.className = 'card';
  cards.append(card);
}
feed.append(cards);

const video = document.createElement('video');
video.src = VIDEO_URL;
video.preload = 'auto';
video.playsInline = true;
video.setAttribute('playsinline', '');
video.preservesPitch = false;
video.webkitPreservesPitch = false;
video.addEventListener('playing', () => {
  hasPlayed = true;
  hint.hidden = true;
});
feed.append(video);

const mirrors = [document.createElement('canvas'), document.createElement('canvas')];
feed.append(...mirrors);

let started = false;
let energy = 0;
let rate = 0;
let lastRateMs = 0;
let playPending = false;
let hasPlayed = false;

let index = START_CARD;
let pos = START_CARD;
let cardW = 0;
let cardH = 0;
let mirroredTime = -1;

function layout() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  let x = 0, y = 0, fw = w, fh = h, radius = 0;
  if (w >= 600) {
    fh = h - 40;
    fw = Math.min(fh * (9 / 19.5), w - 40);
    x = (w - fw) / 2;
    y = 20;
    radius = 36;
  }
  Object.assign(feed.style, {
    left: x + 'px', top: y + 'px', width: fw + 'px', height: fh + 'px', borderRadius: radius + 'px',
  });
  const progress = progressBar.parentNode;
  Object.assign(progress.style, { left: x + 'px', top: y + fh - 6 + 'px', width: fw + 'px' });

  cardW = fw;
  cardH = fh;
  video.style.height = cardH + 'px';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const c of mirrors) {
    c.width = Math.round(cardW * dpr);
    c.height = Math.round(cardH * dpr);
    c.style.height = cardH + 'px';
  }
  mirroredTime = -1;
  feed.scrollTop = index * cardH;
  pos = index;
  place();
}

function place() {
  video.style.transform = `translateY(${index * cardH}px)`;
  mirrors[0].style.transform = `translateY(${(index - 1) * cardH}px)`;
  mirrors[1].style.transform = `translateY(${(index + 1) * cardH}px)`;
}

function drawMirrors() {
  if (video.readyState < 2) return;
  for (const c of mirrors) {
    const ctx = c.getContext('2d');
    const s = Math.min(c.width / video.videoWidth, c.height / video.videoHeight);
    const w = video.videoWidth * s;
    const h = video.videoHeight * s;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(video, (c.width - w) / 2, (c.height - h) / 2, w, h);
  }
  mirroredTime = video.currentTime;
}

function start() {
  if (started) return;
  started = true;
  if (!hasPlayed) hint.textContent = 'Loading…';
  video.muted = false;
  video.play().catch(() => {});
  energy = ENERGY_PER_SWIPE;
}

feed.addEventListener('click', start);
feed.addEventListener('touchend', () => {
  if (started && video.paused && energy >= MIN_RATE) video.play().catch(() => {});
});
window.addEventListener('keydown', (e) => {
  start();
  const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
  if (!dir) return;
  e.preventDefault();
  feed.scrollBy({ top: dir * cardH, behavior: 'smooth' });
});
window.addEventListener('resize', layout);

function updatePlayback(now) {
  const playing = rate >= MIN_RATE && !video.ended;
  if (playing) {
    if (now - lastRateMs > RATE_UPDATE_MS) {
      const r = Math.round(Math.min(rate, MAX_RATE) / RATE_STEP) * RATE_STEP;
      if (video.playbackRate !== r) video.playbackRate = r;
      lastRateMs = now;
    }
    if (video.paused && !playPending) {
      playPending = true;
      video.play().catch(() => {}).finally(() => (playPending = false));
    }
  } else if (!video.paused) {
    video.pause();
  }
}

let lastNow = performance.now();
function tick(now) {
  const dt = Math.min((now - lastNow) / 1000, 0.1);
  lastNow = now;

  const next = feed.scrollTop / cardH;
  if (started) energy = Math.min(MAX_ENERGY, energy + Math.abs(next - pos) * ENERGY_PER_SWIPE);
  pos = next;

  const nearest = Math.round(pos);
  if (nearest !== index && Math.abs(pos - nearest) < 0.15) {
    index = nearest;
    place();
  }

  if (Math.abs(pos - index) < 0.001 && (index < 100 || index > NUM_CARDS - 100)) {
    index = START_CARD;
    feed.scrollTop = index * cardH;
    pos = index;
    place();
  }

  if (hasPlayed) energy *= 0.5 ** (dt / HALF_LIFE);
  const target = Math.min(energy, MAX_RATE);
  rate += (target - rate) * (1 - 0.001 ** dt);
  if (rate < MIN_RATE && target < MIN_RATE) rate = 0;

  if (started) updatePlayback(now);
  if (video.currentTime !== mirroredTime) drawMirrors();
  progressBar.style.transform = `scaleX(${video.currentTime / (video.duration || 1)})`;

  requestAnimationFrame(tick);
}

layout();
requestAnimationFrame(tick);
