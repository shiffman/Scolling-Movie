const SECONDS_PER_SWIPE = 2;
const MAX_BANKED = 3;
const NUM_CARDS = 2001;
const START_CARD = 1000;

let started = false;
let banked = 0;

let scroller;
let hint;
let pos = START_CARD;
let cardH = 0;

let slots = []; // { wrap, video, bar, card }
let current; // the slot on screen
let index = START_CARD; // the card the current slot is in

function setup() {
  noCanvas();
  makeScroller();
  for (let i = 0; i < 3; i++) slots.push(makeSlot('movie.mp4?copy=' + i));
  current = slots[1];
  placeSlots();
  hint = createDiv('Tap to start').class('hint');
}

function makeSlot(url) {
  const wrap = createDiv().class('slot').parent(scroller);
  const video = createElement('video');
  video.attribute('src', url);
  video.attribute('playsinline', '');
  video.attribute('preload', 'auto');
  video.parent(wrap);
  const track = createDiv().class('track').parent(wrap);
  const bar = createDiv().class('bar').parent(track);
  return { wrap: wrap.elt, video: video.elt, bar: bar.elt };
}

function placeSlots() {
  const others = slots.filter((s) => s !== current);
  const where = [
    [current, index],
    [others[0], index - 1],
    [others[1], index + 1],
  ];
  for (const [slot, i] of where) {
    slot.card = i;
    slot.wrap.style.height = cardH + 'px';
    slot.wrap.style.transform = `translateY(${i * cardH}px)`;
  }
}

function makeScroller() {
  scroller = createDiv().class('feed');
  for (let i = 0; i < NUM_CARDS; i++) createDiv().class('card').parent(scroller);
  scroller.elt.addEventListener('click', start);
  scroller.elt.addEventListener('scrollend', () => {
    const i = round(scroller.elt.scrollTop / cardH);
    if (i < 100 || i > NUM_CARDS - 100) {
      scroller.elt.scrollTop = START_CARD * cardH;
      pos = START_CARD;
      index = START_CARD;
      placeSlots();
    }
  });
}

// new main slot!
function setIndex(i) {
  if (i === index) return;
  const dir = i > index ? 1 : -1;
  const ahead = slots.find((s) => s.card === index + dir);
  index = i;
  if (ahead) current = ahead;
  for (const s of slots) s.video.muted = s !== current;
  placeSlots();
}

function start() {
  if (started) return;
  started = true;
  hint.hide();
  // iOS only allows sound from a video whose play() was called inside a tap,
  // so start every copy here, then mute all but the one on screen
  for (const s of slots) {
    s.video.muted = false;
    s.video.play().catch(() => {});
  }
  for (const s of slots) s.video.muted = s !== current;
  banked = SECONDS_PER_SWIPE;
}

function draw() {
  const dt = min(deltaTime / 1000, 0.1);
  placeScroller(layout());

  const next = scroller.elt.scrollTop / cardH;
  if (started) banked = min(MAX_BANKED, banked + abs(next - pos) * SECONDS_PER_SWIPE);
  banked = max(0, banked - dt);
  pos = next;
  if (abs(pos - round(pos)) < 0.15) setIndex(round(pos));

  if (started) updatePlayback(banked > 0);

  const progress = current.video.currentTime / (current.video.duration || 1);
  for (const s of slots) s.bar.style.transform = `scaleX(${progress})`;
}

function updatePlayback(playing) {
  const lead = current.video;
  for (const s of slots) {
    const v = s.video;
    if (playing && !lead.ended) {
      if (v.paused) v.play().catch(() => {});
    } else if (!v.paused) {
      v.pause();
    }
    // keep the off-screen copies on the same frame
    if (v !== lead && !v.seeking) {
      const drift = abs(v.currentTime - lead.currentTime);
      if (drift > (playing ? 0.3 : 0.04)) v.currentTime = lead.currentTime;
    }
  }
}

// keep the feed exactly over the phone screen
function placeScroller(L) {
  if (L.ph === cardH) return;
  const card = cardH ? round(scroller.elt.scrollTop / cardH) : START_CARD;
  scroller.position(L.px, L.py);
  scroller.size(L.pw, L.ph);
  scroller.style('border-radius', L.round + 'px');
  cardH = L.ph;
  scroller.elt.scrollTop = card * cardH;
  pos = card;
  placeSlots();
}

// vertical phone-shaped frame on desktop, full screen on mobile
function layout() {
  const w = windowWidth;
  const h = windowHeight;
  if (w < 600) return { px: 0, py: 0, pw: w, ph: h, round: 0 };
  const ph = h - 40;
  const pw = min(ph * (9 / 19.5), w - 40);
  return { px: (w - pw) / 2, py: 20, pw, ph, round: 36 };
}
