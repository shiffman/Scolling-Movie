const ENERGY_PER_SWIPE = 2.5; // playback energy gained by moving one card
const MAX_ENERGY = 2.5;
const HALF_LIFE = 0.6; // seconds for scroll energy to decay by half
const MAX_RATE = 2.0;
const MIN_RATE = 0.07; // below this the video pauses
const NUM_CARDS = 2001; // "endless" feed; we start in the middle
const START_CARD = 1000;

let started = false;
let video = null;
let energy = 0;
let rate = 0;

let scroller; // the invisible native scroll-snap container
let pos = START_CARD; // feed position in cards (fractional while moving)
let cardH = 0;

function setup() {
  createCanvas(windowWidth, windowHeight);
  textFont('Helvetica Neue, Helvetica, Arial, sans-serif');
  loadVideo('movie.mp4');
  makeScroller();
}

function loadVideo(url) {
  const v = createVideo(url);
  v.hide();
  v.elt.muted = !started;
  v.elt.playsInline = true;
  v.elt.addEventListener('loadeddata', () => {
    video = v;
  });
}

// ---------- scrolling ----------
function makeScroller() {
  scroller = createDiv();
  scroller.class('feed');
  for (let i = 0; i < NUM_CARDS; i++) createDiv().class('card').parent(scroller);
  scroller.elt.addEventListener('click', start);
  scroller.elt.addEventListener('scrollend', () => {
    const i = round(scroller.elt.scrollTop / cardH);
    if (i < 100 || i > NUM_CARDS - 100) {
      scroller.elt.scrollTop = START_CARD * cardH;
      pos = START_CARD;
    }
  });
}

function start() {
  if (started) return;
  started = true;
  if (video) {
    video.elt.muted = false;
    // phones only allow sound if play() is called directly inside the tap
    video.elt.play().catch(() => {});
  }
  energy = ENERGY_PER_SWIPE;
}

function draw() {
  const dt = min(deltaTime / 1000, 0.1);
  const L = layout();
  placeScroller(L);

  const next = scroller.elt.scrollTop / cardH;
  if (started) energy = min(MAX_ENERGY, energy + abs(next - pos) * ENERGY_PER_SWIPE);
  pos = next;

  energy *= pow(0.5, dt / HALF_LIFE);
  const target = min(energy, MAX_RATE);
  rate = lerp(rate, target, 1 - pow(0.001, dt));
  if (rate < MIN_RATE && target < MIN_RATE) rate = 0;

  if (started && video) updatePlayback();

  background(12);
  push();
  translate(L.px, L.py);
  drawingContext.save();
  drawingContext.beginPath();
  drawingContext.roundRect(0, 0, L.pw, L.ph, L.round);
  drawingContext.clip();
  drawFeed(L.pw, L.ph);
  drawingContext.restore();
  pop();
}

function placeScroller(L) {
  if (L.ph === cardH) return;
  const card = cardH ? round(scroller.elt.scrollTop / cardH) : START_CARD;
  scroller.position(L.px, L.py);
  scroller.size(L.pw, L.ph);
  scroller.style('border-radius', L.round + 'px');
  cardH = L.ph;
  scroller.elt.scrollTop = card * cardH;
  pos = card;
}

function updatePlayback() {
  const el = video.elt;
  if (rate >= MIN_RATE && !el.ended) {
    el.playbackRate = constrain(rate, 0.0625, 16);
    if (el.paused) el.play().catch(() => {});
  } else if (!el.paused) {
    el.pause();
  }
}

// vertical phone-shaped frame on desktop, full screen on mobile
function layout() {
  if (width < 600) return { px: 0, py: 0, pw: width, ph: height, round: 0 };
  const ph = height - 40;
  const pw = min(ph * (9 / 19.5), width - 40);
  return { px: (width - pw) / 2, py: 20, pw, ph, round: 36 };
}

// draw whichever cards are on screen (at most two at once)
function drawFeed(pw, ph) {
  noStroke();
  fill(0);
  rect(0, 0, pw, ph);

  const first = floor(pos);
  for (let i = first; i <= first + 1; i++) {
    const y = (i - pos) * ph;
    if (y < ph && y > -ph) drawCard(0, y, pw, ph);
  }

  fill(255, 200);
  textAlign(CENTER, CENTER);
  textSize(min(16, pw * 0.042));
  if (!started) text('Tap to start', pw / 2, ph / 2);
}

function drawCard(x, y, w, h) {
  noStroke();
  fill(0);
  rect(x, y, w, h);
  if (!video) return;

  const sw = video.elt.videoWidth || 16;
  const sh = video.elt.videoHeight || 9;
  const s = min(w / sw, h / sh);
  image(video, x + (w - sw * s) / 2, y + (h - sh * s) / 2, sw * s, sh * s);

  // progress bar
  const dur = video.elt.duration || 1;
  fill(255, 60);
  rect(x, y + h - 6, w, 3);
  fill(255);
  rect(x, y + h - 6, w * constrain(video.elt.currentTime / dur, 0, 1), 3);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
