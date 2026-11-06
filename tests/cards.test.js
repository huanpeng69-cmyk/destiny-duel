import test from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, DECK_LIST, DECK_SIZE, buildRandomDeck, MAX_DECK_COPIES, CARD_CATALOG, DIRECT_ATTACK_RESERVE, EFFECT_MONSTER_RESERVE } from '../src/cards.js';

test('新手牌组的常见卡牌显示中文名称和效果', () => {
  assert.equal(CARDS.blueEyes.cn, '青眼白龙');
  assert.equal(CARDS.potOfGreed.cn, '强欲之壶');
  assert.equal(CARDS.potOfGreed.desc, '①：自己抽2张。');
  assert.equal(DECK_SIZE, 40);
  assert.equal(DECK_LIST.length, DECK_SIZE);
  const copies = new Map();
  for (const id of DECK_LIST) copies.set(id, (copies.get(id) ?? 0) + 1);
  assert.ok([...copies.values()].every((count) => count <= 3));
  assert.ok(CARD_CATALOG.length >= DECK_SIZE, '卡池规模应不小于卡组');
});

// 基于种子的确定性伪随机（mulberry32）+ Fisher–Yates 洗牌，
// 模拟 boardgame.io 注入的 random，用于验证 buildRandomDeck 的组牌逻辑。
function seededShuffleRandom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    Shuffle: (arr) => {
      const clone = [...arr];
      for (let i = clone.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [clone[i], clone[j]] = [clone[j], clone[i]];
      }
      return clone;
    },
  };
}

test('buildRandomDeck 生成一套完整、合法的全新卡组', () => {
  const deck = buildRandomDeck(seededShuffleRandom(1));
  assert.equal(deck.length, DECK_SIZE);
  for (const key of deck) assert.ok(CARDS[key], `卡组里的卡必须在卡池内: ${key}`);
  const counts = new Map();
  for (const key of deck) counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const [key, n] of counts) {
    assert.ok(n <= MAX_DECK_COPIES, `${key} 超过单卡张数上限`);
  }
});

test('buildRandomDeck 同种子确定、异种子不同，且卡组有差异性', () => {
  const a = buildRandomDeck(seededShuffleRandom(42));
  const b = buildRandomDeck(seededShuffleRandom(42));
  const c = buildRandomDeck(seededShuffleRandom(43));
  assert.deepEqual(a, b, '同一种子应得到同一套牌');
  assert.notDeepEqual(a, c, '不同种子应得到不同牌组');
  const distinct = new Set(a).size;
  assert.ok(distinct >= 15, `卡组应多样，只抽到 ${distinct} 张不同卡`);
  assert.ok(CARD_CATALOG.length > DECK_SIZE, '卡池需大过单副卡组，才谈得上每局刷新');
});

// ---- 直击怪保底（2026-03 用户裁决：保底 2 份）----
// 背景：4 张直击怪在 74 张池里随机抽 40 张，实测平均 2.17 张、8.3% 的牌组一张都没有，
// 起手含直击只有 24.2%——玩家手里没有直击怪时界面「直接攻击」入口不出现，
// 看起来就是「效果没生效」。保底后起手率 38.0%，且不干预起手洗牌。

const countDirect = (deck) =>
  deck.filter((key) => CARDS[key].monsterEffect === 'directAttack').length;

test('每副随机卡组都保留保底份数的「直击」怪', () => {
  assert.ok(DIRECT_ATTACK_RESERVE >= 1, '保底份数应至少 1 份');
  for (let seed = 1; seed <= 200; seed++) {
    const deck = buildRandomDeck(seededShuffleRandom(seed));
    assert.equal(deck.length, DECK_SIZE, `种子 ${seed} 的牌组长度应不变`);
    assert.ok(
      countDirect(deck) >= DIRECT_ATTACK_RESERVE,
      `种子 ${seed} 的牌组只有 ${countDirect(deck)} 张直击怪，低于保底 ${DIRECT_ATTACK_RESERVE}`
    );
  }
});

test('保底不突破单卡张数上限，也不改变同种子确定性', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const deck = buildRandomDeck(seededShuffleRandom(seed));
    const counts = new Map();
    for (const key of deck) counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const [key, n] of counts) {
      assert.ok(n <= MAX_DECK_COPIES, `种子 ${seed}：${key} 有 ${n} 张，超过上限`);
    }
  }
  const a = buildRandomDeck(seededShuffleRandom(7));
  const b = buildRandomDeck(seededShuffleRandom(7));
  assert.deepEqual(a, b, '加入保底后同种子仍必须完全一致（回放依赖这一点）');
});

test('保底在直击怪之间轮换，不是每局都塞同一张', () => {
  const directKeys = new Set(
    CARD_CATALOG.filter((c) => c.monsterEffect === 'directAttack').map((c) => c.key)
  );
  const seen = new Set();
  for (let seed = 1; seed <= 200; seed++) {
    for (const key of buildRandomDeck(seededShuffleRandom(seed))) {
      if (directKeys.has(key)) seen.add(key);
    }
  }
  assert.ok(seen.size > 1, `保底应随机挑卡，实际只用到 ${seen.size} 张直击怪`);
});

// ---- 效果怪保底（2026-03 用户裁决：卡池扩容到 302 张时同批加入，保底 6 份）----
// 背景：扩容把普通怪从 55 张涨到 280 张，而能打标的效果怪只有 17 张，效果怪密度
// 被稀释到 4.03 份/牌组（扩容前 8.75），正是「功能做完却几乎不触发」的老坑。
// 保底后回到 9.5 份/牌组，与扩容前持平。

const countEffect = (deck) => deck.filter((key) => CARDS[key].monsterEffect).length;

test('每副随机卡组都保留保底份数的效果怪（含直击怪）', () => {
  assert.ok(EFFECT_MONSTER_RESERVE >= 1, '保底份数应至少 1 份');
  const floor = Math.min(
    DIRECT_ATTACK_RESERVE + EFFECT_MONSTER_RESERVE,
    DECK_SIZE
  );
  for (let seed = 1; seed <= 200; seed++) {
    const deck = buildRandomDeck(seededShuffleRandom(seed));
    assert.equal(deck.length, DECK_SIZE, `种子 ${seed} 的牌组长度应不变`);
    assert.ok(
      countEffect(deck) >= floor,
      `种子 ${seed} 的效果怪只有 ${countEffect(deck)} 张，低于保底 ${floor}`
    );
  }
});

test('效果保底也在多张效果怪之间轮换，且不突破单卡张数上限', () => {
  const effectKeys = new Set(
    CARD_CATALOG.filter((c) => c.monsterEffect && c.monsterEffect !== 'directAttack').map(
      (c) => c.key
    )
  );
  const seen = new Set();
  for (let seed = 1; seed <= 200; seed++) {
    const deck = buildRandomDeck(seededShuffleRandom(seed));
    const counts = new Map();
    for (const key of deck) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (effectKeys.has(key)) seen.add(key);
    }
    for (const [key, n] of counts) {
      assert.ok(n <= MAX_DECK_COPIES, `种子 ${seed}：${key} 有 ${n} 张，超过上限`);
    }
  }
  assert.ok(
    seen.size > EFFECT_MONSTER_RESERVE,
    `保底应随机挑卡，实际只用到 ${seen.size} 张非直击效果怪`
  );
});
