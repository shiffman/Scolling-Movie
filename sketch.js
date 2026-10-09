const params = new URLSearchParams(location.search);
const HOLD_SECONDS = Number(params.get('hold')) || 1;
const HALF_LIFE = 0.5;
const MAX_RATE = Number(params.get('max')) || 1;
const MAX_ENERGY = MAX_RATE * 2 ** (HOLD_SECONDS / HALF_LIFE);
const ENERGY_PER_SWIPE = MAX_ENERGY;
const STOP_RATE = 0.02;
const NUM_CARDS = 2001;
const START_CARD = 1000;
const FETCH_SIZE = 2 * 1024 * 1024;
const SEGMENT_SECONDS = 4;
const FRAME_QUEUE = 8;
const AUDIO_CHUNK_SECONDS = 6;
const AUDIO_OVERLAP_FRAMES = 24;
const AUDIO_PREROLL_FRAMES = 2;
const CROSSFADE = 0.02;
const NUDGE_AFTER_SECONDS = 6;
const DEBUG = params.has('debug');

let videoUrl = '';
let wantStart = false;

const feed = document.getElementById('feed');
const progressBar = document.querySelector('#progress div');
const hint = document.getElementById('hint');
const home = document.getElementById('home');
const player = document.getElementById('player');
const back = document.getElementById('back');
const nudge = document.getElementById('nudge');
let stoppedFor = 0;

const cards = document.createDocumentFragment();
for (let i = 0; i < NUM_CARDS; i++) {
  const card = document.createElement('div');
  card.className = 'card';
  cards.append(card);
}
feed.append(cards);

const screens = [0, 1, 2].map(() => document.createElement('canvas'));
feed.append(...screens);

let started = false;
let ready = false;
let failed = false;
let energy = 0;
let rate = 0;
let t = 0;

let index = START_CARD;
let pos = START_CARD;
let cardW = 0;
let cardH = 0;

let duration = 0;
let videoTrack = null;
let audioTrack = null;
let decoder = null;
let nextVideo = 0;
let flushed = false;
const frames = [];
let shown = null;
const segments = new Map();

let ctx = null;
let master = null;
const audioChunks = new Map();
let voice = null;
let anchoredWhileStopped = false;
let analyser = null;
let peak = 0;

const log = [];
function note(msg) {
  log.push(`${(performance.now() / 1000).toFixed(1)}s ${msg}`);
  if (log.length > 10) log.shift();
}

function fail(msg) {
  failed = true;
  hint.hidden = false;
  hint.textContent = msg;
  note('FAIL ' + msg);
}

async function fetchRange(start, end) {
  const res = await fetch(videoUrl, { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status} loading ${videoUrl}`);
  const buf = await res.arrayBuffer();
  return res.status === 200 ? buf.slice(start, end) : buf;
}

async function openMovie() {
  const file = MP4Box.createFile(false);
  let info = null;
  let parseError = null;
  file.onReady = (i) => (info = i);
  file.onError = (e) => (parseError = e);
  let filePos = 0;
  for (let reads = 0; !info; reads++) {
    if (parseError) throw new Error('could not read the movie file: ' + parseError);
    if (reads > 50) throw new Error('could not find the movie index');
    const buf = await fetchRange(filePos, filePos + FETCH_SIZE);
    if (!buf.byteLength) throw new Error('could not find the movie index');
    buf.fileStart = filePos;
    const next = file.appendBuffer(buf);
    filePos = next > filePos ? next : filePos + buf.byteLength;
  }
  duration = info.duration / info.timescale;
  if (!info.videoTracks.length) throw new Error('the movie has no video track');
  videoTrack = makeTrack(file, info.videoTracks[0], info.timescale);
  if (info.audioTracks.length) audioTrack = makeTrack(file, info.audioTracks[0], info.timescale);
  note(`opened: ${info.videoTracks[0].codec}, ${audioTrack ? info.audioTracks[0].codec : 'no audio'}, ${duration.toFixed(0)}s`);
}

function makeTrack(file, info, movieTimescale) {
  const trak = file.getTrackById(info.id);
  const ts = info.timescale;
  let shift = 0;
  for (const edit of info.edits || []) {
    if (edit.media_time === -1) {
      shift += edit.segment_duration / movieTimescale;
    } else {
      shift -= edit.media_time / ts;
      break;
    }
  }
  const samples = trak.samples.map((s) => ({
    offset: s.offset,
    size: s.size,
    pt: s.cts / ts + shift,
    dur: s.duration / ts,
    key: s.is_sync,
  }));
  const last = samples[samples.length - 1];
  const seconds = Math.max(1, last.pt + last.dur);
  return {
    info,
    entry: trak.mdia.minf.stbl.stsd.entries[0],
    samples,
    segN: Math.max(1, Math.round((samples.length / seconds) * SEGMENT_SECONDS)),
  };
}

function segmentOf(track, i) {
  return Math.floor(i / track.segN);
}

function byteRange(track, k) {
  const a = k * track.segN;
  const b = Math.min(track.samples.length, a + track.segN);
  if (a >= b) return null;
  let lo = Infinity;
  let hi = 0;
  for (let i = a; i < b; i++) {
    const s = track.samples[i];
    lo = Math.min(lo, s.offset);
    hi = Math.max(hi, s.offset + s.size);
  }
  return [lo, hi];
}

function loadSegment(k) {
  if (segments.has(k)) return segments.get(k);
  const ranges = [videoTrack, audioTrack]
    .filter(Boolean)
    .map((track) => byteRange(track, k))
    .filter(Boolean)
    .sort((x, y) => x[0] - y[0]);
  if (!ranges.length) return null;
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1024 * 1024) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const seg = { pieces: [], ready: false, promise: null };
  seg.promise = Promise.all(
    merged.map(([lo, hi]) => fetchRange(lo, hi).then((buf) => seg.pieces.push({ start: lo, bytes: new Uint8Array(buf) })))
  )
    .then(() => (seg.ready = true))
    .catch((e) => {
      segments.delete(k);
      note('fetch failed: ' + e.message);
    });
  segments.set(k, seg);
  return seg;
}

function sampleBytes(track, i) {
  const seg = loadSegment(segmentOf(track, i));
  if (!seg || !seg.ready) return null;
  const s = track.samples[i];
  for (const p of seg.pieces) {
    if (s.offset >= p.start && s.offset + s.size <= p.start + p.bytes.length) {
      return p.bytes.subarray(s.offset - p.start, s.offset - p.start + s.size);
    }
  }
  return null;
}

function evictSegments() {
  let keep = segmentOf(videoTrack, nextVideo);
  if (audioTrack && audioTrack.chunkFrames) {
    const firstFrame = Math.max(0, audioChunkAt(t) * audioTrack.chunkFrames - AUDIO_PREROLL_FRAMES);
    keep = Math.min(keep, segmentOf(audioTrack, firstFrame));
  }
  for (const k of segments.keys()) if (k < keep - 1) segments.delete(k);
}

async function setupVideo() {
  if (!('VideoDecoder' in window)) throw new Error('This page needs a newer browser (on iPhone, iOS 16.4 or later).');
  const entry = videoTrack.entry;
  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  let description;
  if (box) {
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(stream);
    description = new Uint8Array(stream.buffer, 8);
  }
  const config = {
    codec: videoTrack.info.codec,
    codedWidth: videoTrack.info.video.width,
    codedHeight: videoTrack.info.video.height,
    description,
  };
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`This browser can't decode this video (${config.codec}).`);
  decoder = new VideoDecoder({
    output: (frame) => frames.push(frame),
    error: (e) => fail('video decoder error: ' + e.message),
  });
  decoder.configure(config);
}

function feedDecoder() {
  const samples = videoTrack.samples;
  loadSegment(segmentOf(videoTrack, nextVideo) + 1);
  while (nextVideo < samples.length && decoder.decodeQueueSize < 3 && frames.length < FRAME_QUEUE) {
    const data = sampleBytes(videoTrack, nextVideo);
    if (!data) break;
    const s = samples[nextVideo];
    decoder.decode(new EncodedVideoChunk({
      type: s.key ? 'key' : 'delta',
      timestamp: Math.round(s.pt * 1e6),
      duration: Math.round(s.dur * 1e6),
      data,
    }));
    nextVideo++;
  }
  if (nextVideo >= samples.length && !flushed) {
    flushed = true;
    decoder.flush().catch(() => {});
  }
}

function showFrame() {
  const now = t * 1e6;
  while (frames.length > 1 && frames[1].timestamp <= now) frames.shift().close();
  const frame = frames[0];
  if (!frame || frame === shown) return;
  shown = frame;
  for (const c of screens) {
    const g = c.getContext('2d');
    const s = Math.min(c.width / frame.displayWidth, c.height / frame.displayHeight);
    const w = frame.displayWidth * s;
    const h = frame.displayHeight * s;
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(frame, (c.width - w) / 2, (c.height - h) / 2, w, h);
  }
}

function canAdvance() {
  if (flushed && frames.length <= 1) return t < duration;
  return frames.some((f) => f.timestamp > t * 1e6);
}

function setupAudio() {
  if (!audioTrack) return;
  if (!audioTrack.info.codec.startsWith('mp4a')) {
    note(`audio codec ${audioTrack.info.codec} not supported, playing silent`);
    audioTrack = null;
    return;
  }
  const asc = audioTrack.entry.esds.esd.findDescriptor(4).findDescriptor(5).data;
  const objectType = asc[0] >> 3;
  const rateIndex = ((asc[0] & 7) << 1) | (asc[1] >> 7);
  const channels = (asc[1] >> 3) & 15;
  if (rateIndex === 15 || objectType === 31) {
    note('unusual AAC config, playing silent');
    audioTrack = null;
    return;
  }
  audioTrack.adts = { profile: (objectType === 5 || objectType === 29 ? 2 : objectType) - 1, rateIndex, channels };
  const first = audioTrack.samples[0];
  audioTrack.chunkFrames = Math.max(1, Math.round(AUDIO_CHUNK_SECONDS / first.dur));
  ensureAudioContext();
}

function ensureAudioContext() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.connect(ctx.destination);
  if (DEBUG) {
    analyser = ctx.createAnalyser();
    master.connect(analyser);
  }
}

function unlockAudio() {
  if (navigator.audioSession) navigator.audioSession.type = 'playback';
  ensureAudioContext();
  ctx.resume();
  const unlock = ctx.createBufferSource();
  unlock.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  unlock.connect(ctx.destination);
  unlock.start();
}

function adtsHeader(out, at, frameLength) {
  const { profile, rateIndex, channels } = audioTrack.adts;
  const len = frameLength + 7;
  out[at] = 0xff;
  out[at + 1] = 0xf1;
  out[at + 2] = (profile << 6) | (rateIndex << 2) | (channels >> 2);
  out[at + 3] = ((channels & 3) << 6) | (len >> 11);
  out[at + 4] = (len >> 3) & 0xff;
  out[at + 5] = ((len & 7) << 5) | 0x1f;
  out[at + 6] = 0xfc;
}

function audioChunkAt(time) {
  const first = audioTrack.samples[0];
  const i = Math.max(0, Math.floor((time - first.pt) / first.dur));
  return Math.floor(i / audioTrack.chunkFrames);
}

function requestAudioChunk(c) {
  if (audioChunks.has(c)) return;
  const samples = audioTrack.samples;
  const n = audioTrack.chunkFrames;
  const a = c * n;
  if (c < 0 || a >= samples.length) return;
  const chunk = { buffer: null, t0: 0, start: samples[a].pt };
  audioChunks.set(c, chunk);
  decodeAudioChunk(c, chunk).catch((e) => {
    audioChunks.delete(c);
    note(`audio chunk ${c} failed: ${e.message || e}`);
  });
}

async function decodeAudioChunk(c, chunk) {
  const samples = audioTrack.samples;
  const n = audioTrack.chunkFrames;
  const a = c * n;
  const from = Math.max(0, a - AUDIO_PREROLL_FRAMES);
  const to = Math.min(samples.length, a + n + AUDIO_OVERLAP_FRAMES);
  const needed = new Set();
  for (let i = from; i < to; i++) needed.add(segmentOf(audioTrack, i));
  await Promise.all([...needed].map((k) => loadSegment(k)?.promise));
  let total = 0;
  for (let i = from; i < to; i++) total += samples[i].size + 7;
  const out = new Uint8Array(total);
  let p = 0;
  for (let i = from; i < to; i++) {
    const data = sampleBytes(audioTrack, i);
    if (!data) throw new Error('missing audio data');
    adtsHeader(out, p, data.length);
    out.set(data, p + 7);
    p += data.length + 7;
  }
  const buffer = await ctx.decodeAudioData(out.buffer);
  const expected = samples[to - 1].pt + samples[to - 1].dur - samples[from].pt;
  chunk.t0 = samples[from].pt + (expected - buffer.duration);
  chunk.expected = expected;
  chunk.buffer = buffer;
}

function startVoice(chunk, r) {
  const src = ctx.createBufferSource();
  src.buffer = chunk.buffer;
  src.playbackRate.value = r;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(gain).connect(master);
  src.start(0, Math.max(0, t - chunk.t0));
  gain.gain.setTargetAtTime(1, ctx.currentTime, CROSSFADE / 3);
  return { src, gain, chunk };
}

function stopVoice(v) {
  v.gain.gain.setTargetAtTime(0, ctx.currentTime, CROSSFADE / 3);
  v.src.stop(ctx.currentTime + CROSSFADE * 4);
}

function updateAudio(r) {
  if (!audioTrack || !ctx) return;
  const c = audioChunkAt(t);
  requestAudioChunk(c);
  requestAudioChunk(c + 1);
  for (const key of audioChunks.keys()) if (key < c - 1 || key > c + 2) audioChunks.delete(key);
  if (!started) return;

  const chunk = audioChunks.get(c);
  const reanchor = r === 0 && voice && !anchoredWhileStopped;
  if (chunk && chunk.buffer && (!voice || voice.chunk !== chunk || reanchor)) {
    const old = voice;
    voice = startVoice(chunk, r);
    if (old) stopVoice(old);
    if (reanchor) anchoredWhileStopped = true;
  }
  if (r > 0) anchoredWhileStopped = false;
  if (voice) voice.src.playbackRate.setTargetAtTime(r, ctx.currentTime, 0.01);
}

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
  Object.assign(nudge.style, { left: x + 'px', width: fw + 'px', top: y + fh - 130 + 'px' });
  Object.assign(back.style, { left: x + 'px', top: `calc(${y}px + env(safe-area-inset-top, 0px))` });

  cardW = fw;
  cardH = fh;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const c of screens) {
    c.width = Math.round(cardW * dpr);
    c.height = Math.round(cardH * dpr);
    c.style.height = cardH + 'px';
  }
  shown = null;
  feed.scrollTop = index * cardH;
  pos = index;
  place();
}

function place() {
  screens.forEach((c, i) => (c.style.transform = `translateY(${(index + i - 1) * cardH}px)`));
}

function start() {
  if (started || failed) return;
  started = true;
  hint.hidden = true;
  unlockAudio();
  energy = ENERGY_PER_SWIPE;
}

feed.addEventListener('click', () => ready && start());
feed.addEventListener('touchend', () => {
  if (started && ctx && ctx.state !== 'running') ctx.resume();
});
window.addEventListener('keydown', (e) => {
  if (ready) start();
  const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
  if (!dir) return;
  e.preventDefault();
  feed.scrollBy({ top: dir * cardH, behavior: 'smooth' });
});
window.addEventListener('resize', () => !player.hidden && layout());

let lastNow = performance.now();
let effectiveRate = 0;
function tick(now) {
  const dt = Math.min((now - lastNow) / 1000, 0.1);
  lastNow = now;
  if (player.hidden) return requestAnimationFrame(tick);

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

  if (ready && !failed) {
    feedDecoder();
    const loaded = !started || canAdvance();
    if (started && loaded) energy *= 0.5 ** (dt / HALF_LIFE);
    const target = Math.min(energy, MAX_RATE);
    rate += (target - rate) * (1 - 0.001 ** dt);
    if (rate < STOP_RATE && target < STOP_RATE) rate = 0;
    effectiveRate = started && loaded ? rate : 0;
    t = Math.min(duration, t + effectiveRate * dt);
    showFrame();
    updateAudio(effectiveRate);
    evictSegments();
    progressBar.style.transform = `scaleX(${t / (duration || 1)})`;
    stoppedFor = started && effectiveRate === 0 && energy < STOP_RATE ? stoppedFor + dt : 0;
    nudge.classList.toggle('show', stoppedFor > NUDGE_AFTER_SECONDS);
  }
  if (DEBUG) updateDebug();

  requestAnimationFrame(tick);
}

let debugPanel = null;
function updateDebug() {
  if (!debugPanel) {
    debugPanel = document.createElement('pre');
    Object.assign(debugPanel.style, {
      position: 'fixed', top: 'env(safe-area-inset-top, 0px)', left: '0', right: '0', margin: '0', padding: '8px',
      font: '11px/1.35 ui-monospace, Menlo, monospace', color: '#ff0', background: 'rgba(0, 0, 0, 0.7)',
      whiteSpace: 'pre-wrap', pointerEvents: 'none', zIndex: '10',
    });
    document.body.append(debugPanel);
  }
  if (analyser) {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let level = 0;
    for (const x of data) level = Math.max(level, Math.abs(x));
    peak = Math.max(level, peak * 0.97);
  }
  const vc = voice && voice.chunk;
  const voiceInfo = vc
    ? `voice buffer ${vc.buffer.duration.toFixed(2)}s (expected ${vc.expected.toFixed(2)}s) ${vc.buffer.sampleRate}Hz  t0 ${vc.t0.toFixed(2)}  reading at ${(t - vc.t0).toFixed(2)}s  speed ${voice.src.playbackRate.value.toFixed(2)}  gain ${voice.gain.gain.value.toFixed(2)}`
    : 'voice -';
  const chunks = [...audioChunks.entries()].map(([k, c]) => `${k}${c.buffer ? '' : '…'}`).join(' ');
  debugPanel.textContent = [
    `VideoDecoder ${'VideoDecoder' in window}  audioSession ${navigator.audioSession ? navigator.audioSession.type : 'none'}  ctx ${ctx ? ctx.state + ' ' + ctx.sampleRate + 'Hz' : '-'}`,
    `OUTPUT LEVEL ${'█'.repeat(Math.round(peak * 40)).padEnd(40, '·')} ${peak.toFixed(3)}`,
    voiceInfo,
    `t ${t.toFixed(2)} / ${duration.toFixed(0)}  rate ${effectiveRate.toFixed(2)}  energy ${energy.toFixed(2)}`,
    `frames ${frames.length}  decodeQ ${decoder ? decoder.decodeQueueSize : '-'}  nextVideo ${nextVideo}  segments ${[...segments.keys()].join(' ')}`,
    `audio chunks ${chunks}  voice ${voice ? audioChunkAt(voice.chunk.start) : '-'}`,
    `card ${index}  pos ${pos.toFixed(3)}  started ${started}  ready ${ready}`,
    '',
    ...log,
  ].join('\n');
}

window.addEventListener('error', (e) => note(`JS ERROR ${e.message} (${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => note(`REJECTED ${e.reason}`));

async function init() {
  try {
    await openMovie();
    await setupVideo();
    setupAudio();
    ready = true;
    if (wantStart) start();
    else hint.textContent = 'Tap to start';
  } catch (e) {
    fail(e.message || String(e));
  }
}

function openFilm(id, autoStart) {
  videoUrl = `films/${id}.mp4`;
  wantStart = autoStart;
  home.hidden = true;
  player.hidden = false;
  layout();
  init();
}

for (const button of document.querySelectorAll('[data-film]')) {
  button.addEventListener('click', () => {
    const id = button.dataset.film;
    unlockAudio();
    history.pushState(null, '', `?film=${id}${DEBUG ? '&debug' : ''}`);
    openFilm(id, true);
  });
}
window.addEventListener('popstate', () => location.reload());

const linked = params.get('film');
if (linked && document.querySelector(`[data-film="${linked}"]`)) openFilm(linked, false);
requestAnimationFrame(tick);
