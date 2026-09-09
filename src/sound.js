/* 本地合成骰子与木棋音效，不读取资源，也不接触游戏的随机数。 */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LudoSound = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function create(options = {}) {
    let context = options.context || null;
    let master = null, limiter = null;
    let enabled = true;
    let randomState = 0x6c75646f;
    const voices = new Set();
    const knownKinds = new Set(['roll', 'step', 'capture', 'finish', 'win']);

    // 独立种子让音色略有变化，并保持离线验收可以复现。
    function random() {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      return (randomState >>> 0) / 4294967296;
    }

    function offline() {
      return context && typeof context.startRendering === 'function';
    }

    function isReady() {
      try { return Boolean(enabled && master && context && context.state !== 'closed' && (offline() || context.state === 'running')); }
      catch { return false; }
    }

    function disconnect(node) {
      try { if (node) node.disconnect(); } catch { /* 浏览器已回收节点时无需再处理。 */ }
    }

    function prepare() {
      if (master) return;
      if (!context) {
        const AudioContextClass = root.AudioContext || root.webkitAudioContext;
        if (typeof AudioContextClass !== 'function') throw new Error('audio-unavailable');
        context = new AudioContextClass();
      }
      let nextMaster = null, nextLimiter = null;
      try {
        nextMaster = context.createGain();
        nextMaster.gain.value = 0.58;
        nextLimiter = context.createDynamicsCompressor();
        nextLimiter.threshold.value = -9;
        nextLimiter.knee.value = 6;
        nextLimiter.ratio.value = 16;
        nextLimiter.attack.value = 0.002;
        nextLimiter.release.value = 0.07;
        nextLimiter.connect(nextMaster);
        nextMaster.connect(context.destination);
        master = nextMaster;
        limiter = nextLimiter;
      } catch (error) {
        disconnect(nextMaster); disconnect(nextLimiter);
        throw error;
      }
    }

    async function unlock() {
      try {
        if (!enabled) return false;
        prepare();
        // OfflineAudioContext 从 suspended 开始，不能按真实播放设备调用 resume。
        if (!offline() && context.state !== 'running') await context.resume();
        return isReady();
      } catch { return false; }
    }

    // 短暂噪声激励加非整数倍衰减共振，模拟硬骰子与木棋落在棋盘上的声音。
    function addImpact(data, start, strength, dice) {
      const rate = context.sampleRate;
      const offset = Math.max(0, Math.round(start * rate));
      const length = Math.min(data.length - offset, Math.ceil((dice ? 0.09 : 0.105) * rate));
      const pitch = 0.91 + random() * 0.18;
      const frequencies = dice ? [870, 1820, 3180, 205] : [560, 1130, 1970, 155];
      const decays = dice ? [0.012, 0.007, 0.0036, 0.021] : [0.018, 0.009, 0.0045, 0.023];
      const weights = dice ? [0.34, 0.2, 0.1, 0.23] : [0.34, 0.14, 0.055, 0.31];
      let previousNoise = 0, softNoise = 0;
      for (let index = 0; index < length; index++) {
        const time = index / rate;
        const noise = random() * 2 - 1;
        softNoise += 0.2 * (noise - softNoise);
        let sample = 0;
        for (let mode = 0; mode < frequencies.length; mode++) {
          sample += weights[mode] * Math.sin(2 * Math.PI * frequencies[mode] * pitch * time) * Math.exp(-time / decays[mode]);
        }
        sample += ((noise - previousNoise) * (dice ? 0.065 : 0.025) + softNoise * 0.17) * Math.exp(-time / 0.005);
        previousNoise = noise;
        const attack = Math.min(1, time / 0.0007);
        const tail = Math.min(1, (length - index - 1) / (rate * 0.006));
        data[offset + index] += sample * strength * attack * tail;
      }
    }

    function addNote(data, start, frequency, strength) {
      const rate = context.sampleRate;
      const offset = Math.round(start * rate);
      const length = Math.min(data.length - offset, Math.ceil(rate * 0.28));
      for (let index = 0; index < length; index++) {
        const time = index / rate;
        const body = Math.sin(2 * Math.PI * frequency * time) * Math.exp(-time / 0.075);
        const overtone = Math.sin(2 * Math.PI * frequency * 2.76 * time) * 0.14 * Math.exp(-time / 0.025);
        const attack = Math.min(1, time / 0.003);
        const tail = Math.min(1, (length - index - 1) / (rate * 0.012));
        data[offset + index] += (body + overtone) * strength * attack * tail;
      }
    }

    function makeBuffer(kind, duration) {
      const rollDuration = Number.isFinite(duration) ? Math.max(0, Math.min(3, duration)) : 0.54;
      const length = kind === 'roll' ? Math.max(0.105, rollDuration) : kind === 'step' ? 0.105 : kind === 'capture' ? 0.36 : kind === 'finish' ? 0.44 : 0.61;
      const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * length), context.sampleRate);
      const data = buffer.getChannelData(0);
      if (kind === 'step') addImpact(data, 0, 0.62, false);
      else if (kind === 'roll') {
        if (rollDuration < 0.16) addImpact(data, 0, 0.76, true);
        else {
          const count = Math.max(3, Math.min(20, Math.round(rollDuration * 15)));
          const span = Math.max(0.025, rollDuration - 0.09);
          for (let index = 0; index < count; index++) {
            const fraction = index / (count - 1);
            const time = span * Math.pow(fraction, 0.85);
            const strength = index === count - 1 ? 0.8 : (0.36 + random() * 0.25) * (1 - fraction * 0.2);
            addImpact(data, time, strength, true);
          }
        }
      } else {
        const notes = kind === 'capture' ? [392, 294] : kind === 'finish' ? [523.25, 659.25, 783.99] : [523.25, 659.25, 783.99, 1046.5];
        const spacing = kind === 'win' ? 0.11 : 0.08;
        notes.forEach((frequency, index) => addNote(data, spacing * index, frequency, kind === 'capture' ? 0.17 : 0.14));
      }
      // 只对单次音效的极端叠加限幅，日常强弱关系保持一致。
      let peak = 0;
      for (const sample of data) peak = Math.max(peak, Math.abs(sample));
      if (peak > 0.82) for (let index = 0; index < data.length; index++) data[index] *= 0.82 / peak;
      return buffer;
    }

    function release(voice) {
      voices.delete(voice);
      voice.source.onended = null;
      disconnect(voice.source);
      disconnect(voice.gain);
    }

    function stop() {
      for (const voice of Array.from(voices)) {
        try {
          const now = context.currentTime;
          voice.gain.gain.cancelScheduledValues(now);
          voice.gain.gain.setTargetAtTime(0, now, 0.002);
          voice.source.stop(now + 0.012);
        } catch { release(voice); }
      }
    }

    function play(kind, settings = {}) {
      if (!knownKinds.has(kind) || !isReady()) return;
      let source = null, gain = null, voice = null;
      try {
        // 限制意外连续调用的资源占用；正常棋局同时仅有一到两个音效。
        if (voices.size >= 24) {
          const oldest = voices.values().next().value;
          try { oldest.source.stop(); } catch { /* 已结束的节点可直接释放。 */ }
          release(oldest);
        }
        source = context.createBufferSource();
        source.buffer = makeBuffer(kind, settings && settings.duration);
        gain = context.createGain();
        source.connect(gain);
        gain.connect(limiter);
        voice = { source, gain };
        source.onended = () => release(voice);
        voices.add(voice);
        source.start();
      } catch {
        if (voice) release(voice);
        else { disconnect(source); disconnect(gain); }
      }
    }

    function setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) stop();
    }

    function info() {
      return Object.freeze({ enabled, ready: isReady(), activeVoices: voices.size, sampleRate: context ? context.sampleRate : null });
    }

    return Object.freeze({ unlock, play, stop, setEnabled, isReady, info });
  }

  return Object.freeze({ create });
});
