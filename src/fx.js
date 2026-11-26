// 战斗演出时间轴 —— 纯函数层。
//
// 为什么要单独一层：原来 board.jsx 拿到 G.fx 事件后只做一件事
// （setPopup + 1.5 秒定时消失），场上的卡牌一动不动，观感就是
// 「浮出一块告示牌」。要做「冲撞 → 停顿 → 爆开」这种有节奏的演出，
// 得有统一的播放时钟：什么时候卡牌位移、什么时候受击、什么时候破坏。
//
// 本文件只做纯计算（无 DOM、无 React、无随机数），因此 node --test
// 可以直接测；DOM 量取与播放交给 board.jsx 与 app.css。

// ---- 演出总时长（毫秒）----------------------------------------------------
// 现代快节奏取向：一次攻击完整演出 720ms，比「原作卡牌冲撞」的厚重感短，
// 保证连续攻击不拖沓。分段见下面 beacons。
export const ATTACK_DURATION = 720;
// 卡牌冲到目标位所需时间（与 CSS .fx-lunge 的 animation-duration 一致）
export const LUNGE_MS = 260;
// 命中瞬间（卡牌到达目标）：受击抖动、血条掉血、音效在这一刻发生
export const IMPACT_MS = LUNGE_MS;
// 破坏碎裂动画时长
export const BREAK_MS = 320;
// 通用弹窗（召唤 / 魔法 / 效果）停留时长
export const BANNER_MS = 1500;
// 回合转场扫光时长
export const TURN_MS = 900;

// 演出开关：默认开。用户关掉后所有新增演出跳过，行为退回改动前的样子。
const FX_KEY = 'dd-fx';
const REDUCED_KEY = 'dd-fx-reduced';

function safeGet(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    // 隐私模式 / 存储写满：只影响「是否播放演出」，不影响对局。
    return fallback;
  }
}

function safeSet(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略 */
  }
}

export function fxEnabled() {
  return safeGet(FX_KEY, true) !== false;
}

export function setFxEnabled(on) {
  safeSet(FX_KEY, Boolean(on));
}

// 系统「减少动态效果」偏好。首次读到结果后缓存到 localStorage，
// 这样 jsdom（没有 matchMedia）里也能通过存储键模拟。
export function prefersReducedMotion() {
  const cached = safeGet(REDUCED_KEY, null);
  if (typeof cached === 'boolean') return cached;
  let reduced = false;
  try {
    reduced = Boolean(
      typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    reduced = false;
  }
  safeSet(REDUCED_KEY, reduced);
  return reduced;
}

// 总开关：用户关掉演出 或 系统要求减少动态，都走「无动画」路径。
export function shouldAnimate() {
  return fxEnabled() && !prefersReducedMotion();
}

// ---- 位移计算 -------------------------------------------------------------
// 卡牌能不能动，取决于能否量到「起点」和「终点」两个矩形。
// 任何一边缺失（元素还没挂载、被卸载、jsdom 没有布局）都返回 null，
// 调用方据此跳过动画 —— 宁可不动，也不能算出一个乱飞的坐标。
export function translateTo(from, to) {
  if (!from || !to) return null;
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  // 缩放：让飞出去的卡牌在视觉上放大到目标的宽度
  const scale = from.width > 0 && to.width > 0 ? to.width / from.width : 1;
  return {
    dx: Math.round(dx * 100) / 100,
    dy: Math.round(dy * 100) / 100,
    // 限制在 [0.6, 1.6]，避免极端布局下卡牌被拉成怪异尺寸
    scale: Math.max(0.6, Math.min(1.6, Math.round(scale * 1000) / 1000)),
  };
}

// ---- 攻击演出的帧序列 -----------------------------------------------------
// 返回 [{ at, kind, ... }]，at 是相对演出起点的毫秒数，严格递增。
// kind:
//   'lunge'    攻击方冲出去（at=0）
//   'impact'   命中：受击方抖动 + 血条掉血 + 音效
//   'break'    被破坏方碎裂
//   'retreat'  攻击方回位
//   'settle'   演出收尾（撤掉弹窗与所有临时类名）
export function attackSequence(ev) {
  const frames = [{ at: 0, kind: 'lunge', who: 'attacker' }];
  const hasDmg = typeof ev.dmg === 'number' && ev.dmg > 0;
  const outcome = ev.outcome;

  // 守备被破但未贯通（wall 且无 dmg）：没有扣血，但守备怪确实被破坏，
  // 所以依旧要演「命中 + 碎裂」。
  frames.push({
    at: IMPACT_MS,
    kind: 'impact',
    who: 'defender',
    dmg: hasDmg ? ev.dmg : 0,
  });

  // 破坏哪些：对手怪兽被破坏 → win / wall / draw 各自不同
  const breakDefender =
    outcome === 'win' || outcome === 'wall' || outcome === 'draw';
  const breakAttacker = outcome === 'lose' || outcome === 'draw';

  if (breakDefender && ev.target) {
    frames.push({ at: IMPACT_MS, kind: 'break', who: 'defender', card: ev.target });
  }
  if (breakAttacker) {
    // 反杀：攻击方自己炸掉，比命中稍晚一点，让「反杀」的因果读得出来
    frames.push({ at: IMPACT_MS + 60, kind: 'break', who: 'attacker', card: ev.attacker });
  }
  // 效果专属特效：与 impact/break 同落 IMPACT_MS。
  // 注意（上一轮踩过的坑）：同毫秒的多个帧会写同一个槽位，
  // board 侧必须追加类名而不是整体赋值，否则后一个会冲掉前一个。
  for (const f of attackEffectFrames(ev)) frames.push(f);

  frames.push({ at: ATTACK_DURATION - 160, kind: 'retreat', who: 'attacker', card: ev.attacker });
  frames.push({ at: ATTACK_DURATION, kind: 'settle' });
  return frames;
}

// ---- 召唤 / 魔法 / 通用事件的演出 ----------------------------------------
export function bannerSequence(ev) {
  const frames = [{ at: 0, kind: 'banner', card: ev.card || null }];
  if (ev.kind === 'effect' && (ev.effect === 'destroyBurn' || ev.effect === 'summonDraw')) {
    frames.push({
      at: 140,
      kind: 'effect',
      effect: ev.effect,
      visual: effectVisual(ev.effect),
      dmg: typeof ev.dmg === 'number' ? ev.dmg : 0,
      draw: typeof ev.draw === 'number' ? ev.draw : 0,
    });
  } else if (ev.kind === 'spell' && ev.effect === 'destroy' && ev.victim) {
    frames.push({ at: 200, kind: 'break', who: 'victim', card: ev.victim });
  }
  frames.push({ at: BANNER_MS, kind: 'settle' });
  return frames;
}

// ---- 效果专属演出 ---------------------------------------------------------
// 引擎只有 destroyBurn / summonDraw 会发独立的 kind:'effect' 事件；
// 其余 4 类效果是挂在 kind:'attack' 事件上的标记字段：
//   direct → true（直击越过怪兽）
//   pierced → true（贯通破壁造成伤害）
//   protected → true（战斗免疫，未被破坏）
//   boost → 数字（战斗中的实际攻击力）
// 所以专属演出必须「从攻击事件派生」，不能等一个不存在的独立事件。

// 从攻击事件里抽出生效的效果标记。返回空数组表示「普通战斗，没有效果参与」。
export function attackEffects(ev) {
  const out = [];
  if (!ev || ev.kind !== 'attack') return out;
  if (ev.direct) out.push('directAttack');
  if (ev.pierced) out.push('pierce');
  if (ev.protected) out.push('battleProtect');
  if (typeof ev.boost === 'number' && ev.boost > 0) out.push('battleBoost');
  return out;
}

// 效果 → 演出的视觉类别。CSS 里用 .fx-eff-<cls> 上色与做形状：
//   lance  贯通：穿透箭头
//   shield 免疫：护盾环
//   surge  强化：数值脉冲
//   strike 直击：斜切直砸
//   burn   灼烧：橙红粒子
//   draw   抽牌：卡背飞入
const EFFECT_VISUAL = {
  directAttack: 'strike',
  pierce: 'lance',
  battleProtect: 'shield',
  battleBoost: 'surge',
  destroyBurn: 'burn',
  summonDraw: 'draw',
};

export function effectVisual(effect) {
  return EFFECT_VISUAL[effect] || 'generic';
}

// 攻击事件里的效果特效帧：命中那一刻叠在受击/攻击方身上。
// 多个效果同时生效（例如「贯通 + 强化」）时全部输出，由 CSS 叠加。
export function attackEffectFrames(ev) {
  const effects = attackEffects(ev);
  return effects.map((effect) => ({
    at: IMPACT_MS,
    kind: 'effect',
    effect,
    visual: effectVisual(effect),
    // 直击指向对方血条；其余效果发生在交战的那张卡上
    who: effect === 'directAttack' ? 'panel' : 'defender',
    dmg: typeof ev.dmg === 'number' ? ev.dmg : 0,
    boost: typeof ev.boost === 'number' ? ev.boost : 0,
  }));
}

// ---- 回合转场 -------------------------------------------------------------
// 返回扫光方向：自己的回合从下往上，对手的回合从上往下，
// 让「轮到谁」在视觉上就有方向感。
export function turnTransition({ myTurn }) {
  return {
    at: 0,
    kind: 'turn',
    dir: myTurn ? 'up' : 'down',
    duration: TURN_MS,
  };
}

// ---- 终局 -----------------------------------------------------------------
export function gameoverSequence(ctx) {
  if (!ctx || !ctx.gameover) return null;
  return {
    at: 0,
    kind: 'gameover',
    draw: ctx.gameover.winner === null,
    duration: 1200,
  };
}

// ---- 调度器 ---------------------------------------------------------------
// 把帧序列交给浏览器定时器。返回 cancel()，组件卸载时必须调用，
// 否则旧对局的事件会在新对局里继续演（boardgame.io 换局不重挂组件）。
export function scheduleFrames(frames, onFrame, setTimer = setTimeout, clearTimer = clearTimeout) {
  const timers = [];
  for (const frame of frames) {
    timers.push(setTimer(() => onFrame(frame), frame.at));
  }
  return () => {
    for (const t of timers) clearTimer(t);
  };
}
