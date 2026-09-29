// Web Audio 合成音效 —— 零素材、零版权。
// 两个构件够用：tone（振荡器+包络）和 noise（衰减噪声）。
// 浏览器自动播放策略：AudioContext 必须在首次用户交互后才能 resume，
// 所以由棋盘在 onPointerDown 时调用 ensureUnlocked()。

let ctx = null;
let enabled = JSON.parse(localStorage.getItem('dd-sfx') ?? 'true');

function ac() {
  if (ctx === null) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

// 首次交互时解锁音频上下文。
export function ensureUnlocked() {
  const c = ac();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

export function sfxEnabled() {
  return enabled;
}

export function setSfx(on) {
  enabled = on;
  localStorage.setItem('dd-sfx', JSON.stringify(on));
}

function tone({ freq = 440, type = 'sine', dur = 0.18, vol = 0.2, at = 0, slide = 0 }) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + at;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise({ dur = 0.16, vol = 0.16, lowpass = 1800, hp = 200 }) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime;
  const frames = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = lowpass;
  const hpf = c.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.frequency.value = hp;
  const gain = c.createGain();
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(hpf).connect(lp).connect(gain).connect(c.destination);
  src.start(t0);
}

// 事件音效表。每个都用 guard 包装：开关关闭或异常时静默失败。
const play = (fn) => (...args) => {
  if (!enabled) return;
  try {
    ensureUnlocked();
    fn(...args);
  } catch {
    /* 音频不可用时静默降级 */
  }
};

export const sfx = {
  // 召唤：低频锣 + 泛音
  summon: play(() => {
    tone({ freq: 180, type: 'triangle', dur: 0.4, vol: 0.22 });
    tone({ freq: 540, type: 'sine', dur: 0.28, vol: 0.1, at: 0.04 });
  }),
  // 攻击：带通噪声 + 下滑音
  attack: play(() => {
    noise({ dur: 0.2, vol: 0.2, lowpass: 3200, hp: 400 });
    tone({ freq: 420, type: 'sawtooth', dur: 0.22, vol: 0.14, slide: -260 });
  }),
  // 受击：低通钝响
  hit: play(() => {
    noise({ dur: 0.3, vol: 0.26, lowpass: 420, hp: 60 });
    tone({ freq: 90, type: 'square', dur: 0.24, vol: 0.12, slide: -40 });
  }),
  // 魔法：上行琶音
  spell: play(() => {
    [523, 659, 784].forEach((f, i) =>
      tone({ freq: f, type: 'sine', dur: 0.16, vol: 0.12, at: i * 0.06 })
    );
  }),
  // 抽牌：高频短噪
  draw: play(() => {
    noise({ dur: 0.09, vol: 0.09, lowpass: 6000, hp: 1800 });
  }),
  // 怪兽被破坏：下行三连
  destroy: play(() => {
    [440, 330, 220].forEach((f, i) =>
      tone({ freq: f, type: 'triangle', dur: 0.14, vol: 0.13, at: i * 0.07 })
    );
  }),
  // 回合开始：钟磬
  turn: play(() => {
    tone({ freq: 660, type: 'sine', dur: 0.5, vol: 0.12 });
    tone({ freq: 990, type: 'sine', dur: 0.35, vol: 0.05, at: 0.02 });
  }),
  // 胜利 / 落败
  win: play(() => {
    [523, 659, 784, 1047].forEach((f, i) =>
      tone({ freq: f, type: 'triangle', dur: 0.26, vol: 0.15, at: i * 0.11 })
    );
  }),
  lose: play(() => {
    [392, 330, 262, 196].forEach((f, i) =>
      tone({ freq: f, type: 'triangle', dur: 0.3, vol: 0.14, at: i * 0.13 })
    );
  }),
  // 点击反馈
  click: play(() => {
    tone({ freq: 880, type: 'sine', dur: 0.06, vol: 0.07 });
  }),
  // 操作被拒绝：低沉短音
  deny: play(() => {
    tone({ freq: 150, type: 'square', dur: 0.12, vol: 0.09, slide: -50 });
  }),
};
