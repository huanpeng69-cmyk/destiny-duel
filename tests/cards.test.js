import test from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, DECK_LIST, DECK_SIZE, buildRandomDeck, MAX_DECK_COPIES, CARD_CATALOG } from '../src/cards.js';

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
