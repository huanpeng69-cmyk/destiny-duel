import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TUTORIAL_VERSION,
  TUTORIAL_STORAGE_KEY,
  TUTORIAL_STEPS,
  buildTutorialState,
  hasSeenTutorial,
  markTutorialSeen,
  placeBubble,
  resetTutorial,
  shouldShowTutorial,
  stepActionLabel,
  stepHint,
} from '../src/tutorial.js';

// 假 storage：行为与 localStorage 一致，但不出现在 Node 环境里，可以精确控制初始状态。
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

// 隐私模式 / 配额写满：localStorage 存在但任何操作都抛错。
function throwingStorage() {
  const boom = () => {
    throw new Error('storage denied');
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

test('第一次进入（没有任何记录）应弹出指引', () => {
  assert.equal(shouldShowTutorial(fakeStorage()), true);
  assert.equal(hasSeenTutorial(fakeStorage()), false);
});

test('点完 / 跳过后写入版本号，之后不再弹', () => {
  const storage = fakeStorage();
  assert.equal(markTutorialSeen(storage), true);
  assert.equal(storage.map.get(TUTORIAL_STORAGE_KEY), String(TUTORIAL_VERSION));
  assert.equal(hasSeenTutorial(storage), true);
  assert.equal(shouldShowTutorial(storage), false);
});

test('resetTutorial 清掉记录后会重新弹一次', () => {
  const storage = fakeStorage();
  markTutorialSeen(storage);
  assert.equal(shouldShowTutorial(storage), false);
  assert.equal(resetTutorial(storage), true);
  assert.equal(shouldShowTutorial(storage), true);
});

test('记录的是旧版本号时应重新引导', () => {
  const storage = fakeStorage({ [TUTORIAL_STORAGE_KEY]: String(TUTORIAL_VERSION - 1) });
  assert.equal(shouldShowTutorial(storage), true);
});

test('记录为当前或更高版本时不再打扰', () => {
  assert.equal(shouldShowTutorial(fakeStorage({ [TUTORIAL_STORAGE_KEY]: String(TUTORIAL_VERSION) })), false);
  assert.equal(
    shouldShowTutorial(fakeStorage({ [TUTORIAL_STORAGE_KEY]: String(TUTORIAL_VERSION + 5) })),
    false
  );
});

test('脏数据（空串 / 非数字）按没看过处理', () => {
  for (const value of ['', 'abc', 'NaN', 'null']) {
    assert.equal(shouldShowTutorial(fakeStorage({ [TUTORIAL_STORAGE_KEY]: value })), true, `脏值 ${value}`);
  }
});

test('storage 抛错时既不崩也不误判为已看过', () => {
  const storage = throwingStorage();
  assert.doesNotThrow(() => hasSeenTutorial(storage));
  assert.equal(hasSeenTutorial(storage), false);
  assert.doesNotThrow(() => markTutorialSeen(storage));
  assert.equal(markTutorialSeen(storage), false);
  assert.doesNotThrow(() => resetTutorial(storage));
  assert.equal(resetTutorial(storage), false);
  assert.equal(shouldShowTutorial(storage), true);
});

test('localStorage 整体不可用（storage 为 null）时不崩', () => {
  assert.equal(hasSeenTutorial(null), false);
  assert.equal(markTutorialSeen(null), false);
  assert.equal(resetTutorial(null), false);
});

test('步骤数据完整：7 步、id 唯一且顺序固定', () => {
  assert.deepEqual(
    TUTORIAL_STEPS.map((step) => step.id),
    ['hand', 'stance', 'position', 'battle', 'attack', 'end', 'finish']
  );
  assert.equal(new Set(TUTORIAL_STEPS.map((s) => s.id)).size, TUTORIAL_STEPS.length);
});

test('每步都把「按钮在哪」与「怎么用」写清楚（就地标注的核心）', () => {
  // 用户要求：指引不脱离操作区域，必须就地说明按钮位置和用法。
  for (const step of TUTORIAL_STEPS) {
    assert.ok(step.title && step.title.trim().length > 0, `${step.id} 缺标题`);
    assert.ok(
      typeof step.where === 'string' && step.where.trim().length >= 8,
      `${step.id} 的 where（位置说明）太短或缺失`
    );
    assert.ok(
      typeof step.how === 'string' && step.how.trim().length >= 8,
      `${step.id} 的 how（用法说明）太短或缺失`
    );
    // 位置说明必须指向屏幕上的具体位置/控件，而不是泛泛而谈。
    assert.match(step.where, /(下面|上面|上方|中间|最右|最左|这一|那排|这条|弹出的|按钮)/, `${step.id} 的 where 没指到具体位置`);
  }
});

test('每步的锚点都指向 board.jsx 里真实存在的元素', () => {
  // 防止以后改界面类名时，指引静默失去锚点（框不到控件就等于退化成整屏变暗）。
  const boardSource = readFileSync(new URL('../src/board.jsx', import.meta.url), 'utf8');
  const hasClass = (cls) => new RegExp(`className=["'\`][^"'\`]*\\b${cls}\\b`).test(boardSource);
  for (const step of TUTORIAL_STEPS) {
    for (const selector of [step.target, step.fallbackTarget].filter(Boolean)) {
      assert.ok(selector.startsWith('.'), `${step.id} 的锚点应是 class 选择器：${selector}`);
      const classes = [...selector.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]);
      assert.ok(classes.length > 0, `${step.id} 的锚点没解析出类名`);
      for (const cls of classes) {
        assert.ok(hasClass(cls), `${step.id} 的锚点类名 ${cls} 在 board.jsx 里找不到`);
      }
    }
  }
});

test('只有可选步骤没有 done 谓词，其余步骤都能被「做完自动前进」推进', () => {
  for (const step of TUTORIAL_STEPS) {
    if (step.optional) {
      assert.equal(step.done, undefined, `${step.id} 是可选步骤，不该自动推进`);
    } else if (step.id !== 'finish') {
      assert.equal(typeof step.done, 'function', `${step.id} 缺 done 谓词`);
    }
  }
  // 最后一步是收尾，没有「做完」这个概念。
  assert.equal(TUTORIAL_STEPS.at(-1).id, 'finish');
});

test('done 谓词对「还没做」与「已经做了」返回正确的真假', () => {
  const byId = (id) => TUTORIAL_STEPS.find((s) => s.id === id);
  const idle = { myTurn: true, askingSummon: false, myMonsters: 0, battleEntered: false, attacked: false };
  const idleFirstTurn = { ...idle, firstTurn: true };

  // hand：点了手牌（弹出表示形式选择）或场上有怪，都算做完。
  assert.equal(byId('hand').done(idle), false);
  assert.equal(byId('hand').done({ ...idle, askingSummon: true }), true);
  assert.equal(byId('hand').done({ ...idle, myMonsters: 1 }), true);

  // stance：选择栏关掉且怪已在场上 = 选好了表示形式。
  assert.equal(byId('stance').done(idle), false);
  assert.equal(byId('stance').done({ ...idle, askingSummon: true, myMonsters: 0 }), false);
  assert.equal(byId('stance').done({ ...idle, myMonsters: 1 }), true);

  // battle：切到战斗阶段才算。
  assert.equal(byId('battle').done(idle), false);
  assert.equal(byId('battle').done({ ...idle, battleEntered: true }), true);

  // attack：有怪兽已攻击过才算；首回合永远打不了，由 stepHint 提示手动跳过。
  assert.equal(byId('attack').done(idleFirstTurn), false);
  assert.equal(byId('attack').done({ ...idle, attacked: true }), true);

  // end：回合交给对手（myTurn 变假）才算。
  assert.equal(byId('end').done({ ...idle, myTurn: true }), false);
  assert.equal(byId('end').done({ ...idle, myTurn: false }), true);
});

test('buildTutorialState 把棋盘状态压成指引需要的判断量', () => {
  const me = { hand: ['a', 'b', 'c'], field: [{ cardId: 'x', attacked: true }, null, null], firstTurn: false };
  const foe = { field: [null, { cardId: 'y' }, null] };
  const state = buildTutorialState({ me, foe, myTurn: true, isActive: true, step: 'battle', turn: 3, pendingSummon: { handIdx: 1 } });
  assert.deepEqual(state, {
    myTurn: true,
    isActive: true,
    battleEntered: true,
    firstTurn: false,
    handCount: 3,
    myMonsters: 1,
    foeMonsters: 1,
    attacked: true,
    askingSummon: true,
    turn: 3,
  });

  // 空/缺字段不能崩（首帧、重连、测试夹具都可能给不全）。
  const empty = buildTutorialState({});
  assert.equal(empty.myMonsters, 0);
  assert.equal(empty.handCount, 0);
  assert.equal(empty.askingSummon, false);
  assert.equal(empty.battleEntered, false);
  assert.equal(empty.turn, 1);
});

test('stepHint 只在真会卡住或理解错时才给现场提示', () => {
  // 对手回合：等它打完。
  assert.match(stepHint('hand', { myTurn: false }), /对手回合/);
  assert.equal(stepHint('hand', { myTurn: true }), null);
  // 首回合禁攻：给「跳过到下一回合」的走法，而不是硬卡住。
  assert.match(stepHint('attack', { firstTurn: true }), /第一回合不能攻击/);
  // 没进战斗阶段。
  assert.match(stepHint('attack', { firstTurn: false, battleEntered: false }), /进入战斗阶段/);
  // 对手空场 → 点自己怪兽就是直击。
  assert.match(stepHint('attack', { firstTurn: false, battleEntered: true, foeMonsters: 0 }), /直接打对手玩家/);
  // 正常对打时不打废话。
  assert.equal(stepHint('attack', { firstTurn: false, battleEntered: true, foeMonsters: 1 }), null);
  assert.equal(stepHint('position', {}), null);
});

test('主按钮文案：可选步骤「继续」、末步「开始对战」、其余「下一步」', () => {
  const byId = (id) => TUTORIAL_STEPS.find((s) => s.id === id);
  assert.equal(stepActionLabel(byId('hand'), false), '下一步');
  assert.equal(stepActionLabel(byId('position'), false), '继续');
  assert.equal(stepActionLabel(byId('finish'), true), '开始对战');
});

test('placeBubble：按优先方位贴在控件外侧，且不压住控件', () => {
  const spot = { top: 400, left: 500, width: 200, height: 80 };
  const size = { width: 300, height: 160 };
  const viewport = { width: 1280, height: 900 };

  const above = placeBubble(spot, size, 'top', viewport);
  assert.equal(above.placement, 'top');
  assert.ok(above.top + size.height <= spot.top, '气泡底边应高于控件顶边');
  assert.ok(Math.abs(above.left + size.width / 2 - (spot.left + spot.width / 2)) < 1, '应与控件水平居中对齐');
  assert.equal(above.arrow.axis, 'x');
  assert.ok(above.arrow.offset > 0 && above.arrow.offset < size.width, '箭头应落在气泡范围内');

  const below = placeBubble(spot, size, 'bottom', viewport);
  assert.equal(below.placement, 'bottom');
  assert.ok(below.top >= spot.top + spot.height, '气泡顶边应低于控件底边');
});

test('placeBubble：上方放不下时自动翻到下方，且始终留在视口内', () => {
  const viewport = { width: 1280, height: 900 };
  const size = { width: 300, height: 200 };
  // 控件贴着视口顶部：上方没空间。
  const nearTop = { top: 10, left: 500, width: 200, height: 60 };
  const flipped = placeBubble(nearTop, size, 'top', viewport);
  assert.notEqual(flipped.placement, 'top');
  assert.ok(flipped.top >= 0, '不能跑到视口上方');

  // 控件贴右边缘：任何方位都要被夹回视口内。
  const nearRight = { top: 400, left: 1180, width: 90, height: 60 };
  const clamped = placeBubble(nearRight, size, 'top', viewport);
  assert.ok(clamped.left >= 0 && clamped.left + size.width <= viewport.width, '不能超出视口宽度');
  assert.ok(clamped.top >= 0 && clamped.top + size.height <= viewport.height, '不能超出视口高度');
  assert.ok(clamped.arrow.offset >= 18 && clamped.arrow.offset <= size.width - 18, '夹回视口后箭头仍指得准');
});

test('placeBubble：缺测量数据时返回 null，组件退化为底部固定气泡而不是崩', () => {
  assert.equal(placeBubble(null, { width: 1, height: 1 }, 'top', { width: 800, height: 600 }), null);
  assert.equal(placeBubble({ top: 0, left: 0, width: 10, height: 10 }, null, 'top', {}), null);
  assert.equal(placeBubble({ top: 0, left: 0, width: 10, height: 10 }, { width: 0, height: 0 }, 'top', {}), null);
});

test('board.jsx 真的把指引状态传给了组件（防接线断开）', () => {
  const boardSource = readFileSync(new URL('../src/board.jsx', import.meta.url), 'utf8');
  assert.match(boardSource, /state=\{tutorialState\}/, 'board.jsx 没把 tutorialState 传给 Tutorial');
  assert.match(boardSource, /buildTutorialState\(\{/, 'board.jsx 没调用 buildTutorialState');
});

test('存储键名保持稳定（改名会让所有人重新看到指引）', () => {
  assert.equal(TUTORIAL_STORAGE_KEY, 'yugioh-duel.tutorial.seen');
});
