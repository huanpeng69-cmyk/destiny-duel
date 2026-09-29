import test from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, DECK_LIST, DECK_SIZE, CARD_CATALOG_COUNT } from '../src/cards.js';

test('新手牌组的常见卡牌显示中文名称和效果', () => {
  assert.equal(CARDS.blueEyes.cn, '青眼白龙');
  assert.equal(CARDS.potOfGreed.cn, '强欲之壶');
  assert.equal(CARDS.potOfGreed.desc, '①：自己抽2张。');
  assert.equal(DECK_SIZE, 40);
  assert.equal(DECK_LIST.length, DECK_SIZE);
  const copies = new Map();
  for (const id of DECK_LIST) copies.set(id, (copies.get(id) ?? 0) + 1);
  assert.ok([...copies.values()].every((count) => count <= 3));
  assert.ok(CARD_CATALOG_COUNT > 10000);
});
