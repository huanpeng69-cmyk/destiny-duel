import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TUTORIAL_VERSION,
  TUTORIAL_STORAGE_KEY,
  TUTORIAL_STEPS,
  hasSeenTutorial,
  markTutorialSeen,
  resetTutorial,
  shouldShowTutorial,
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

test('步骤数据完整：6 步、id 唯一且顺序固定、每步都有标题与说明', () => {
  assert.deepEqual(
    TUTORIAL_STEPS.map((step) => step.id),
    ['goal', 'hand', 'battle', 'direct', 'position', 'end']
  );
  for (const step of TUTORIAL_STEPS) {
    assert.ok(step.title && step.title.length > 0, `${step.id} 缺标题`);
    assert.ok(Array.isArray(step.body) && step.body.length > 0, `${step.id} 缺说明`);
    assert.ok(
      step.body.every((line) => typeof line === 'string' && line.trim().length > 0),
      `${step.id} 有空白说明行`
    );
    assert.ok(step.target.startsWith('.'), `${step.id} 的 target 应是 class 选择器`);
  }
});

test('每步的高亮选择器都指向 board.jsx 里真实存在的元素', () => {
  // 防止以后改界面类名时，指引静默失去高亮（挖不到洞就等于整屏变暗）。
  const boardSource = readFileSync(new URL('../src/board.jsx', import.meta.url), 'utf8');
  for (const step of TUTORIAL_STEPS) {
    const classes = [...step.target.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]);
    assert.ok(classes.length > 0, `${step.id} 的 target 没解析出类名`);
    for (const cls of classes) {
      assert.ok(
        new RegExp(`className=["'\`][^"'\`]*\\b${cls}\\b`).test(boardSource),
        `${step.id} 的 target 类名 ${cls} 在 board.jsx 里找不到`
      );
    }
  }
});

test('存储键名保持稳定（改名会让所有人重新看到指引）', () => {
  assert.equal(TUTORIAL_STORAGE_KEY, 'yugioh-duel.tutorial.seen');
});
