// 中文卡库测试：
// 1) 显示函数命中中文时返回中文，缺失时回落英文且不伪造中文
// 2) 内置 14 张译名回归（不受 zhName 字段影响）
// 3) 集成：starter 14 张在 zh-cards.json 中全部有中文，且与 CARDS.cn 一致
// 4) 覆盖率阈值
// 5) 导入/校验纯函数 buildTranslation 的行为

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cardNameForDisplay,
  cardDescriptionForDisplay,
  CARDS,
} from '../src/cards.js';
import { buildTranslation } from '../scripts/import-zh-cards.mjs';
import zh from '../public/data/zh-cards.json' with { type: 'json' };

test('有中文译名时显示中文', () => {
  const card = {
    id: '89631139',
    name: 'Blue-Eyes White Dragon',
    desc: 'english flavor',
    zhName: '青眼白龙',
    zhDesc: '以高攻击力著称的传说之龙。',
  };
  assert.equal(cardNameForDisplay(card), '青眼白龙');
  assert.equal(cardDescriptionForDisplay(card), '以高攻击力著称的传说之龙。');
});

test('无中文译名时回落英文原文，不冒充中文', () => {
  const card = { id: '999', name: 'Some TCG Only Card', desc: 'English effect text.' };
  // 没有 zhName/zhDesc 字段
  assert.equal(cardNameForDisplay(card), 'Some TCG Only Card');
  assert.equal(cardDescriptionForDisplay(card), 'English effect text.');
  // 即使 zhName 是空串（中文源缺失该字段），也应回落而非伪造
  const empty = { name: 'X', desc: 'Y', zhName: '', zhDesc: '' };
  assert.equal(cardNameForDisplay(empty), 'X');
});

test('内置 14 张译名回归（不依赖 zhName 字段）', () => {
  assert.equal(cardNameForDisplay({ name: 'Dark Magician' }), '黑魔术师');
  assert.equal(cardNameForDisplay({ name: 'Blue-Eyes White Dragon' }), '青眼白龙');
  assert.equal(
    cardDescriptionForDisplay({ name: 'Pot of Greed' }),
    '①：自己抽2张。'
  );
});

test('starter 14 张在中文卡库中全部命中，且与 CARDS.cn 一致', () => {
  const map = zh.cards;
  let checked = 0;
  for (const card of Object.values(CARDS)) {
    const t = map[String(card.id)];
    assert.ok(t, `卡 ${card.cn}（${card.id}）应在中文卡库中`);
    assert.ok(t.name && t.name.trim().length > 0, `${card.cn} 应有中文卡名`);
    assert.ok(t.desc && t.desc.trim().length > 0, `${card.cn} 应有中文效果`);
    assert.equal(t.name, card.cn, `${card.cn} 的中文名应与 CARDS.cn 一致`);
    checked += 1;
  }
  assert.equal(checked, 14, '应校验全部 14 张 starter 卡');
});

test('中文卡库覆盖率达到阈值', () => {
  // 已知约 14,237 / 14,586（97.6%）命中。即便未来数据源变动，也应保持高位。
  assert.ok(zh.count >= 14000, `中文卡数 ${zh.count} 应 ≥ 14000`);
});

test('buildTranslation：按密码匹配并返回中文', () => {
  const catalog = [{ id: '89631139', name: 'Blue-Eyes White Dragon' }];
  const zhEntries = [{ id: 89631139, cn_name: '青眼白龙', text: { desc: '传说之龙' } }];
  const { cards, coverage } = buildTranslation(catalog, zhEntries);
  assert.equal(cards['89631139'].name, '青眼白龙');
  assert.equal(cards['89631139'].desc, '传说之龙');
  assert.equal(coverage.matched, 1);
  assert.equal(coverage.withName, 1);
});

test('buildTranslation：中文源缺失该卡则不写入（不伪造）', () => {
  const catalog = [{ id: '1', name: 'Only English Card' }];
  // 仅有英文 en_name、无 cn_name/sc_name、无 desc —— 不应产生任何中文条目
  const zhEntries = [{ id: 1, en_name: 'Only English Card' }];
  const { cards, coverage } = buildTranslation(catalog, zhEntries);
  assert.equal(Object.keys(cards).length, 0, '不应写入任何伪造的中文');
  assert.equal(coverage.matched, 1, '密码命中但无中文内容');
  assert.equal(coverage.withName, 0);
});

test('buildTranslation：图鉴没有的卡不会进入产物', () => {
  const catalog = [{ id: '89631139', name: 'Blue-Eyes White Dragon' }];
  const zhEntries = [
    { id: 89631139, cn_name: '青眼白龙', text: { desc: 'd' } },
    { id: 12345678, cn_name: '不存在于图鉴的卡', text: { desc: 'x' } },
  ];
  const { cards } = buildTranslation(catalog, zhEntries);
  assert.equal(Object.keys(cards).length, 1, '只应包含图鉴内存在的卡');
  assert.ok(cards['89631139']);
});
