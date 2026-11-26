import test from 'node:test';
import assert from 'node:assert/strict';

// fx.js 读 localStorage / matchMedia 的地方都在 try 里，但模块顶层不碰 window，
// 这里补一个最小 window，让开关相关函数可以测。
globalThis.window = globalThis.window ?? {
  localStorage: {
    _d: new Map(),
    getItem(k) {
      return this._d.has(k) ? this._d.get(k) : null;
    },
    setItem(k, v) {
      this._d.set(k, String(v));
    },
  },
};

const {
  ATTACK_DURATION,
  IMPACT_MS,
  BANNER_MS,
  TURN_MS,
  attackSequence,
  bannerSequence,
  turnTransition,
  gameoverSequence,
  translateTo,
  scheduleFrames,
  fxEnabled,
  attackEffects,
  attackEffectFrames,
  effectVisual,
  setFxEnabled,
  prefersReducedMotion,
  shouldAnimate,
} = await import('../src/fx.js');

// ---- 帧序列的通用性质 -----------------------------------------------------

function assertWellFormed(frames, label) {
  assert.ok(Array.isArray(frames) && frames.length > 0, `${label}: 序列不能为空`);
  for (const f of frames) {
    assert.equal(typeof f.at, 'number', `${label}: 每帧必须带毫秒时间`);
    assert.ok(f.at >= 0, `${label}: 时间不能为负`);
    assert.equal(typeof f.kind, 'string', `${label}: 每帧必须有 kind`);
  }
  const times = frames.map((f) => f.at);
  const sorted = [...times].sort((a, b) => a - b);
  assert.deepEqual(times, sorted, `${label}: 帧必须按时间递增`);
  // 必须能收尾，否则弹窗与临时类名会永久残留
  assert.equal(frames[frames.length - 1].kind, 'settle', `${label}: 末帧必须是 settle`);
}

test('attackSequence：结构完整、时间递增、以 settle 收尾', () => {
  assertWellFormed(
    attackSequence({ attacker: 'a', target: 'b', outcome: 'win', dmg: 1200 }),
    'win'
  );
});

test('attackSequence：各种 outcome 都能收尾（不漏 settle）', () => {
  for (const outcome of ['direct', 'win', 'lose', 'draw', 'wall']) {
    const ev = { attacker: 'a', target: outcome === 'direct' ? null : 'b', outcome, dmg: 500 };
    assertWellFormed(attackSequence(ev), outcome);
  }
});

test('attackSequence：第一帧是冲撞，且总时长等于 ATTACK_DURATION', () => {
  const frames = attackSequence({ attacker: 'a', target: 'b', outcome: 'win', dmg: 800 });
  assert.equal(frames[0].kind, 'lunge');
  assert.equal(frames[frames.length - 1].at, ATTACK_DURATION);
});

test('attackSequence：命中帧恰好落在 IMPACT_MS', () => {
  const frames = attackSequence({ attacker: 'a', target: 'b', outcome: 'win', dmg: 800 });
  const impact = frames.find((f) => f.kind === 'impact');
  assert.ok(impact, '必须有命中帧');
  assert.equal(impact.at, IMPACT_MS);
});

test('attackSequence：守备被破（wall 无伤）仍要演碎裂', () => {
  const frames = attackSequence({ attacker: 'a', target: 'b', outcome: 'wall', dmg: 0 });
  assert.ok(frames.some((f) => f.kind === 'break'), '破壁也是被破坏，必须有碎裂帧');
  assert.equal(frames.find((f) => f.kind === 'impact').dmg, 0, '破壁不扣血');
});

test('attackSequence：fin 破坏对手怪兽；反杀破坏攻击方自己', () => {
  const win = attackSequence({ attacker: 'a', target: 'b', outcome: 'win', dmg: 900 });
  const winBreaks = win.filter((f) => f.kind === 'break');
  assert.deepEqual(winBreaks.map((f) => f.who), ['defender'], 'win 只炸守方');
  assert.equal(winBreaks[0].card, 'b');

  const lose = attackSequence({ attacker: 'a', target: 'b', outcome: 'lose', dmg: 900 });
  const loseBreaks = lose.filter((f) => f.kind === 'break');
  assert.deepEqual(loseBreaks.map((f) => f.who), ['attacker'], 'lose 只炸攻方');
  assert.equal(loseBreaks[0].card, 'a');

  const draw = attackSequence({ attacker: 'a', target: 'b', outcome: 'draw', dmg: 0 });
  assert.equal(draw.filter((f) => f.kind === 'break').length, 2, '同归于尽两边都炸');
});

test('attackSequence：直接攻击没有 target，不产生守方碎裂', () => {
  const frames = attackSequence({ attacker: 'a', target: null, outcome: 'direct', dmg: 700 });
  assert.equal(frames.filter((f) => f.kind === 'break').length, 0);
});

test('attackSequence：免疫破坏（protected）时引擎不会传 break —— 序列只反映 outcome', () => {
  // 引擎对 protectedByEffect 的保底是不破坏守方，此时 outcome 仍是 win，
  // 但 damageToDefender 照算；序列这边按 outcome 判定，实际「不碎裂」由
  // board 的 DOM 是否还挂着那张卡兜底（卡仍在 → 找不到碎裂目标 → 跳过）。
  const frames = attackSequence({ attacker: 'a', target: 'b', outcome: 'win', dmg: 300, protected: true });
  assertWellFormed(frames, 'protected');
});

// ---- translateTo ----------------------------------------------------------

test('translateTo：中心到中心的位移', () => {
  const from = { x: 0, y: 0, width: 100, height: 100 };
  const to = { x: 200, y: 50, width: 100, height: 100 };
  assert.deepEqual(translateTo(from, to), { dx: 200, dy: 50, scale: 1 });
});

test('translateTo：任一侧缺失返回 null（宁可不动，也不乱飞）', () => {
  const r = { x: 0, y: 0, width: 10, height: 10 };
  assert.equal(translateTo(null, r), null);
  assert.equal(translateTo(r, null), null);
  assert.equal(translateTo(undefined, undefined), null);
});

test('translateTo：宽度缺失时缩放兜底为 1', () => {
  const from = { x: 0, y: 0, width: 0, height: 0 };
  const to = { x: 0, y: 0, width: 0, height: 0 };
  assert.equal(translateTo(from, to).scale, 1);
});

test('translateTo：极端缩放被夹在 [0.6, 1.6]', () => {
  const small = { x: 0, y: 0, width: 10, height: 10 };
  const huge = { x: 0, y: 0, width: 10000, height: 10 };
  assert.equal(translateTo(small, huge).scale, 1.6);
  assert.equal(translateTo(huge, small).scale, 0.6);
});

// ---- bannerSequence -------------------------------------------------------

test('bannerSequence：普通召唤只有 banner + settle', () => {
  const frames = bannerSequence({ kind: 'summon', card: 'c' });
  assertWellFormed(frames, 'summon');
  assert.deepEqual(frames.map((f) => f.kind), ['banner', 'settle']);
});

test('bannerSequence：破坏灼烧带出 effect 帧，且带伤害值', () => {
  const frames = bannerSequence({ kind: 'effect', effect: 'destroyBurn', card: 'c', dmg: 400 });
  const eff = frames.find((f) => f.kind === 'effect');
  assert.ok(eff, '灼烧必须有特效帧');
  assert.equal(eff.dmg, 400);
});

test('bannerSequence：旋风破坏对方怪兽时带碎裂帧', () => {
  const frames = bannerSequence({ kind: 'spell', effect: 'destroy', card: 's', victim: 'v' });
  const brk = frames.find((f) => f.kind === 'break');
  assert.ok(brk, '旋风破坏必须有碎裂帧');
  assert.equal(brk.card, 'v');
});

test('bannerSequence：没有受害者的魔法不产生碎裂帧', () => {
  const frames = bannerSequence({ kind: 'spell', effect: 'draw2', card: 's' });
  assert.equal(frames.filter((f) => f.kind === 'break').length, 0);
});

test('bannerSequence：整个序列以 BANNER_MS 收尾', () => {
  const frames = bannerSequence({ kind: 'summon', card: 'c' });
  assert.equal(frames[frames.length - 1].at, BANNER_MS);
});

// ---- 回合转场 / 终局 -------------------------------------------------------

test('turnTransition：自己回合向上、对手回合向下', () => {
  assert.equal(turnTransition({ myTurn: true }).dir, 'up');
  assert.equal(turnTransition({ myTurn: false }).dir, 'down');
  assert.equal(turnTransition({ myTurn: true }).duration, TURN_MS);
});

test('gameoverSequence：没有 gameover 时返回 null，有则给出平局标记', () => {
  assert.equal(gameoverSequence(null), null);
  assert.equal(gameoverSequence({}), null);
  assert.equal(gameoverSequence({ gameover: { winner: null } }).draw, true);
  assert.equal(gameoverSequence({ gameover: { winner: '0' } }).draw, false);
});

// ---- 开关与调度器 ---------------------------------------------------------

test('开关：默认开启，关掉后 shouldAnimate 为假', () => {
  setFxEnabled(true);
  assert.equal(fxEnabled(), true);
  setFxEnabled(false);
  assert.equal(fxEnabled(), false);
  assert.equal(shouldAnimate(), false);
  setFxEnabled(true);
});

test('开关：系统减少动态时一律不动画', () => {
  setFxEnabled(true);
  window.localStorage.setItem('dd-fx-reduced', 'true');
  assert.equal(prefersReducedMotion(), true);
  assert.equal(shouldAnimate(), false);
  window.localStorage.setItem('dd-fx-reduced', 'false');
  assert.equal(shouldAnimate(), true);
});

test('scheduleFrames：按帧延迟派发，cancel 后不再派发', () => {
  const seen = [];
  const timers = [];
  // 注入自己的 timer，避免依赖真实时间
  const cancel = scheduleFrames(
    [{ at: 0, kind: 'a' }, { at: 100, kind: 'b' }, { at: 200, kind: 'c' }],
    (f) => seen.push(f.kind),
    (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    (t) => {
      t.cancelled = true;
    }
  );
  assert.equal(timers.length, 3, '每帧一个定时器');
  assert.deepEqual(timers.map((t) => t.ms), [0, 100, 200], '按帧时间排期');
  timers.forEach((t) => t.fn());
  assert.deepEqual(seen, ['a', 'b', 'c']);
  cancel();
  assert.ok(timers.every((t) => t.cancelled), 'cancel 必须清掉所有定时器');
});

// ---- 效果专属演出 ---------------------------------------------------------

test('attackEffects：从攻击事件的标记字段抽出效果，普通战斗返回空', () => {
  assert.deepEqual(attackEffects({ kind: 'attack', outcome: 'win' }), [], '普通战斗没有效果');
  assert.deepEqual(attackEffects({ kind: 'attack', direct: true }), ['directAttack']);
  assert.deepEqual(attackEffects({ kind: 'attack', pierced: true }), ['pierce']);
  assert.deepEqual(attackEffects({ kind: 'attack', protected: true }), ['battleProtect']);
  assert.deepEqual(attackEffects({ kind: 'attack', boost: 2400 }), ['battleBoost']);
  // 多个效果同时生效时要全部保留（例如贯通 + 强化）
  assert.deepEqual(
    attackEffects({ kind: 'attack', pierced: true, boost: 2400 }),
    ['pierce', 'battleBoost']
  );
  // 非攻击事件一律返回空，避免误演
  assert.deepEqual(attackEffects({ kind: 'summon' }), []);
  assert.deepEqual(attackEffects(null), []);
});

test('effectVisual：6 类效果各有专属视觉类别，未知效果回落 generic', () => {
  assert.equal(effectVisual('directAttack'), 'strike');
  assert.equal(effectVisual('pierce'), 'lance');
  assert.equal(effectVisual('battleProtect'), 'shield');
  assert.equal(effectVisual('battleBoost'), 'surge');
  assert.equal(effectVisual('destroyBurn'), 'burn');
  assert.equal(effectVisual('summonDraw'), 'draw');
  assert.equal(effectVisual('unknownEffect'), 'generic');
  assert.equal(effectVisual(undefined), 'generic');
});

test('attackSequence：带效果的攻击会插入 effect 帧，且序列仍以 settle 收尾', () => {
  for (const ev of [
    { kind: 'attack', attacker: 'a', target: null, outcome: 'direct', dmg: 700, direct: true },
    { kind: 'attack', attacker: 'a', target: 'b', outcome: 'wall', dmg: 300, pierced: true },
    { kind: 'attack', attacker: 'a', target: 'b', outcome: 'win', dmg: 300, protected: true },
    { kind: 'attack', attacker: 'a', target: 'b', outcome: 'win', dmg: 500, boost: 2400 },
  ]) {
    const frames = attackSequence(ev);
    assertWellFormed(frames, `effect ${ev.outcome}`);
    assert.ok(frames.some((f) => f.kind === 'effect'), `${ev.outcome}: 必须有特效帧`);
  }
});

test('attackSequence：普通战斗不产生 effect 帧（不误演）', () => {
  const frames = attackSequence({ kind: 'attack', attacker: 'a', target: 'b', outcome: 'win', dmg: 800 });
  assert.equal(frames.filter((f) => f.kind === 'effect').length, 0);
});

test('attackEffectFrames：特效帧落在命中时刻，直击指向血条、其余指向守方', () => {
  const direct = attackEffectFrames({
    kind: 'attack', attacker: 'a', target: null, outcome: 'direct', dmg: 700, direct: true,
  });
  assert.equal(direct[0].at, IMPACT_MS, '特效要与命中同帧');
  assert.equal(direct[0].who, 'panel', '直击砸的是对方血条');
  assert.equal(direct[0].visual, 'strike');

  const pierce = attackEffectFrames({
    kind: 'attack', attacker: 'a', target: 'b', outcome: 'wall', dmg: 300, pierced: true,
  });
  assert.equal(pierce[0].who, 'defender', '贯通发生在守备怪身上');
  assert.equal(pierce[0].visual, 'lance');
});

test('attackEffectFrames：强化效果带出实际攻击力，便于在演出里标数值', () => {
  const [f] = attackEffectFrames({
    kind: 'attack', attacker: 'a', target: 'b', outcome: 'win', dmg: 500, boost: 2400,
  });
  assert.equal(f.effect, 'battleBoost');
  assert.equal(f.boost, 2400);
});

test('attackEffectFrames：多效果同时生效时按顺序各出一帧', () => {
  const frames = attackEffectFrames({
    kind: 'attack', attacker: 'a', target: 'b', outcome: 'wall', dmg: 400, pierced: true, boost: 1800,
  });
  assert.deepEqual(frames.map((f) => f.effect), ['pierce', 'battleBoost']);
  assert.ok(frames.every((f) => f.at === IMPACT_MS));
});

test('scheduleFrames：cancel 必须清掉所有定时器', () => {
  const timers = [];
  const cancel = scheduleFrames(
    [{ at: 0, kind: 'a' }, { at: 10, kind: 'b' }],
    () => {},
    (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return t;
    },
    (t) => {
      t.cancelled = true;
    }
  );
  cancel();
  assert.ok(timers.length > 0, '应当登记过定时器');
  assert.ok(timers.every((t) => t.cancelled), 'cancel 必须清掉所有定时器');
});
