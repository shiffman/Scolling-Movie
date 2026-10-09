if (new URLSearchParams(location.search).has('debug')) {
  const panel = document.createElement('pre');
  Object.assign(panel.style, {
    position: 'fixed',
    top: 'env(safe-area-inset-top, 0px)',
    left: '0',
    right: '0',
    margin: '0',
    padding: '8px',
    font: '11px/1.35 ui-monospace, Menlo, monospace',
    color: '#ff0',
    background: 'rgba(0, 0, 0, 0.7)',
    whiteSpace: 'pre-wrap',
    pointerEvents: 'none',
    zIndex: '10',
  });
  document.body.append(panel);

  const log = [];
  const t0 = performance.now();
  const note = (msg) => {
    log.push(`${((performance.now() - t0) / 1000).toFixed(1)}s ${msg}`);
    if (log.length > 12) log.shift();
  };

  for (const type of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'suspend', 'pause', 'ended', 'abort', 'emptied']) {
    video.addEventListener(type, () => note(type));
  }
  video.addEventListener('error', () => note(`ERROR code ${video.error && video.error.code} ${video.error && video.error.message}`));
  window.addEventListener('error', (e) => note(`JS ERROR ${e.message} (${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => note(`REJECTED ${e.reason}`));
  feed.addEventListener('click', () => note('tap'));
  feed.addEventListener('touchend', () => note('touchend'));

  const play = video.play.bind(video);
  video.play = () => {
    note('play()');
    return play().catch((e) => {
      note(`play() failed: ${e.name} ${e.message}`);
      throw e;
    });
  };

  const states = ['NOTHING', 'METADATA', 'CURRENT', 'FUTURE', 'ENOUGH'];
  const nets = ['EMPTY', 'IDLE', 'LOADING', 'NO_SOURCE'];
  setInterval(() => {
    const buffered = video.buffered.length ? video.buffered.end(video.buffered.length - 1).toFixed(1) : '0';
    panel.textContent = [
      `ready ${states[video.readyState]}  net ${nets[video.networkState]}  ${video.paused ? 'PAUSED' : 'PLAYING'}`,
      `t ${video.currentTime.toFixed(2)} / ${(video.duration || 0).toFixed(0)}  buffered to ${buffered}  ${video.videoWidth}x${video.videoHeight}`,
      `playbackRate ${video.playbackRate.toFixed(2)}  muted ${video.muted}`,
      `rate ${rate.toFixed(2)}  energy ${energy.toFixed(2)}  started ${started}  hasPlayed ${hasPlayed}`,
      `card ${index}  pos ${pos.toFixed(3)}  mirrors at t ${mirroredTime.toFixed(2)}`,
      '',
      ...log,
    ].join('\n');
  }, 200);
}
