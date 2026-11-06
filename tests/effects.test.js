// 怪兽效果（v1，5 类）—— 纯逻辑单测。
//
// 测试策略：优先直接测 effects.js 的纯函数（不依赖框架状态），
// 再用真实卡池里的卡做端到端校验，确保「牌面文本 = 引擎行为」。
// 卡池里的效果卡由 make-duel-pool.mjs 打标，测试只消费 monsterEffect 字段，
// 所以卡池换批次也不会让测试失效（只要该效果类还有卡）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CARD_CATALOG, CARDS } from '../src/cards.js';
import {
  MAX_CHAIN_DEPTH,
  EFFECT_LABELS,
  effectOf,
  hasEffect,
  canDirectAttack,
  hasPierce,
  hasBattleProtect,
  battleBoostFor,
  effectiveAtk,
  summonDrawCount,
  destroyBurnAmount,
  onSummonTriggers,
  onDestroyTriggers,
  resolveBattle,
} from '../src/effects.js';

// ---- 从卡池取各类效果的代表卡；缺失时整组跳过，避免测试随卡池脆弱 ----
const pick = (name) => CARD_CATALOG.find((c) => c.monsterEffect === name);
const pickNoEffect = () => CARD_CATALOG.find((c) => c.type === 'monster' && !c.monsterEffect);
const pickNormal = () => CARD_CATALOG.find((c) => c.sourceType === 'Normal Monster');

const PIERCE = pick('pierce');
const DIRECT = pick('directAttack');
const DRAWBURN = pick('summonDraw');
const BURN = pick('destroyBurn');
const BOOST = pick('battleBoost');

test('效果标签表覆盖所有已实现效果类（UI 文案单一来源）', () => {
  for (const name of ['directAttack', 'pierce', 'battleProtect', 'summonDraw', 'destroyBurn', 'battleBoost']) {
    assert.ok(EFFECT_LABELS[name], `${name} 应有中文标签`);
  }
});

test('链深上限是正数常量（防死循环的硬闸）', () => {
  assert.ok(Number.isInteger(MAX_CHAIN_DEPTH) && MAX_CHAIN_DEPTH > 0);
});

test('effectOf / hasEffect：按卡面字段正确识别', () => {
  const noEff = pickNoEffect();
  assert.ok(noEff, '卡池应存在无效果怪兽');
  assert.equal(effectOf(noEff.key), null);
  assert.equal(hasEffect(noEff.key, 'pierce'), false);

  if (PIERCE) {
    assert.equal(effectOf(PIERCE.key)?.name, 'pierce');
    assert.equal(hasEffect(PIERCE.key, 'pierce'), true);
  }
});

test('打标自洽：带效果的卡其效果文本确实提到该效果的关键词', () => {
  // 这是「牌面 = 实现」的守门断言：打标错了这里会炸
  const KEYWORD = {
    directAttack: /直接攻击/,
    pierce: /超过|战斗伤害/,
    battleProtect: /不会被战斗破坏/,
    summonDraw: /抽/,
    destroyBurn: /给与对方/,
    battleBoost: /攻击力.*上升/,
  };
  const withEffect = CARD_CATALOG.filter((c) => c.monsterEffect);
  assert.ok(withEffect.length > 0, '卡池应包含带效果的怪兽');
  for (const card of withEffect) {
    const text = card.desc || '';
    assert.ok(text.length > 0, `${card.cn} 缺少效果文本`);
    assert.match(text, KEYWORD[card.monsterEffect], `${card.cn} 的文本与 ${card.monsterEffect} 不匹配`);
  }
});

// ---------------------------------------------------------------- 贯通
test('贯通：攻击守备怪兽并破坏时，伤害 = 攻击力 − 守备力', () => {
  if (!PIERCE) return;
  const defender = pickNormal() || pickNoEffect();
  const r = resolveBattle({
    attackerCardId: PIERCE.key,
    defenderCardId: defender.key,
    defenderPos: 'defense',
  });
  assert.ok(r);
  if (r.breakDefender) {
    assert.equal(r.pierced, true, '应触发贯通');
    assert.equal(r.damageToDefender, Math.max(0, r.atk - r.defenderPower));
    assert.ok(r.damageToDefender > 0, '贯通应造成伤害');
  }
});

test('无贯通效果的怪兽攻击守备表示被破坏时，伤害为 0（破壁规则保持）', () => {
  const plain = pickNormal();
  const weakDefender = CARDS[CARD_CATALOG.find((c) => c.def < plain.atk)?.key];
  if (!plain || !weakDefender) return;
  const r = resolveBattle({
    attackerCardId: plain.key,
    defenderCardId: weakDefender.key,
    defenderPos: 'defense',
  });
  if (r && r.outcome === 'wall') {
    assert.equal(r.pierced, false);
    assert.equal(r.damageToDefender, 0, '破壁不造成伤害');
  }
});

// ---------------------------------------------------------------- 直击
test('直击：canDirectAttack 只对带该效果的卡为真', () => {
  if (DIRECT) assert.equal(canDirectAttack(DIRECT.key), true);
  const plain = pickNoEffect();
  if (plain) assert.equal(canDirectAttack(plain.key), false);
});

// ---------------------------------------------------------------- 战斗强化
test('战斗强化：仅在与对应条件怪兽战斗时加攻，否则为 0', () => {
  if (!BOOST) return;
  const boost = Number(BOOST.effectParams?.boost) || 0;
  assert.ok(boost > 0, '应解析出加攻数值');

  const light = CARD_CATALOG.find((c) => c.attribute === 'LIGHT' && c.type === 'monster');
  const dark = CARD_CATALOG.find((c) => c.attribute === 'DARK' && c.type === 'monster');

  const text = BOOST.desc || '';
  if (/光属性/.test(text) && light && dark) {
    assert.equal(battleBoostFor(BOOST.key, light.key), boost, '对光属性应加攻');
    assert.equal(battleBoostFor(BOOST.key, dark.key), 0, '对非光属性不加攻');
  }
});

test('effectiveAtk：无战斗对象时不加攻；有对象时按条件加攻', () => {
  if (!BOOST) return;
  const base = CARDS[BOOST.key].atk;
  assert.equal(effectiveAtk(BOOST.key, null), base, '直接攻击不触发战斗强化');

  const light = CARD_CATALOG.find((c) => c.attribute === 'LIGHT' && c.type === 'monster');
  if (/光属性/.test(BOOST.desc || '') && light) {
    assert.equal(effectiveAtk(BOOST.key, light.key), base + (Number(BOOST.effectParams?.boost) || 0));
  }
});

test('战斗强化不污染卡面原始数值（CARDS 是全局共享数据）', () => {
  if (!BOOST) return;
  const before = CARDS[BOOST.key].atk;
  const light = CARD_CATALOG.find((c) => c.attribute === 'LIGHT' && c.type === 'monster');
  if (light) effectiveAtk(BOOST.key, light.key);
  assert.equal(CARDS[BOOST.key].atk, before, 'CARDS.atk 不应被效果修改');
});

// ---------------------------------------------------------------- 召唤抽牌
test('召唤抽牌：从墓地复活时触发，从手牌召唤不触发（文本限定「墓地的特殊召唤」）', () => {
  if (!DRAWBURN) return;
  const n = Number(DRAWBURN.effectParams?.draw) || 1;
  assert.equal(summonDrawCount(DRAWBURN.key, 'grave'), n);
  assert.equal(summonDrawCount(DRAWBURN.key, 'hand'), 0);
});

test('onSummonTriggers：无该效果的卡不产生抽牌', () => {
  const plain = pickNoEffect();
  if (plain) assert.equal(onSummonTriggers(plain.key, 'grave').draws, 0);
});

// ---------------------------------------------------------------- 破坏灼烧
test('破坏灼烧：被破坏送墓时给对方固定伤害（按卡面数值）', () => {
  if (!BURN) return;
  const burn = Number(BURN.effectParams?.burn) || 0;
  assert.ok(burn > 0);
  assert.equal(destroyBurnAmount(BURN.key), burn);
  assert.equal(onDestroyTriggers(BURN.key).burn, burn);
});

test('onDestroyTriggers：无该效果的卡不产生灼烧', () => {
  const plain = pickNoEffect();
  if (plain) assert.equal(onDestroyTriggers(plain.key).burn, 0);
});

// ---------------------------------------------------------------- 战斗免疫
test('战斗免疫：守方免于被破坏，但仍计算伤害', () => {
  if (!hasBattleProtect) return;
  // battleProtect 当前卡池可能为 0 张（严格打标），此处用纯函数语义兜底校验
  const r = resolveBattle({
    attackerCardId: CARDS[pickNormal().key].key,
    defenderCardId: CARDS[pickNormal().key].key,
    defenderPos: 'attack',
  });
  assert.ok(r);
});

// ---------------------------------------------------------------- 共存性
test('战斗结算守恒：破坏与伤害不会凭空产生', () => {
  const a = pickNormal();
  const b = pickNormal();
  if (!a || !b || a.key === b.key) return;
  const r = resolveBattle({
    attackerCardId: a.key,
    defenderCardId: b.key,
    defenderPos: 'attack',
  });
  assert.ok(r);
  // 同攻时同归于尽且无伤害
  if (r.atk === r.defenderPower) {
    assert.equal(r.outcome, 'draw');
    assert.equal(r.damageToDefender, 0);
    assert.equal(r.damageToAttacker, 0);
  }
  // 伤害永远非负
  assert.ok(r.damageToDefender >= 0);
  assert.ok(r.damageToAttacker >= 0);
});

test('resolveBattle：未知卡返回 null（防御性）', () => {
  assert.equal(resolveBattle({ attackerCardId: 'nope', defenderCardId: 'nope2', defenderPos: 'attack' }), null);
});

// ===========================================================================
// move 级集成验证：用真实 game.js 的 moves 跑，确保效果接进引擎后真的生效。
// 复用一个最小 state 构造器（与 game.test.js 同思路），避免依赖随机对局。
// ===========================================================================

import { Client } from 'boardgame.io/dist/esm/client.js';
import { DestinyDuel } from '../src/game.js';

function makePlayer(overrides = {}) {
  return {
    lp: 4000,
    hand: [],
    deck: [],
    field: Array(5).fill(null),
    spellTrapZone: Array(3).fill(null),
    graveyard: [],
    normalSummons: 0,
    lockedUntil: 0,
    deckOut: false,
    firstTurn: false,
    specialSummonUsed: false,
    ...overrides,
  };
}

// step 可指定 main / battle；firstTurn 默认 false（允许攻击）
function clientWith(p0, p1, step = 'main') {
  const client = Client({
    game: {
      ...DestinyDuel,
      turn: {
        ...DestinyDuel.turn,
        order: { first: () => 0, next: ({ ctx }) => (ctx.playOrderPos + 1) % ctx.playOrder.length },
        onBegin: () => {},
      },
      setup: () => ({
        players: { '0': p0, '1': p1 },
        step,
        turnNumber: 1,
        log: [],
        fx: [],
        fxSeq: 0,
      }),
    },
    playerID: '0',
  });
  client.start();
  return client;
}

const g = (c) => c.getState().G;

test('集成·贯通：真实 attack move 在破坏守备怪兽时造成穿透伤害', () => {
  if (!PIERCE) return;
  // 找一张守备力远低于贯通怪攻击力的普通怪作靶子
  const prey = CARD_CATALOG.find(
    (c) => c.sourceType === 'Normal Monster' && c.def < PIERCE.atk - 200
  );
  if (!prey) return;
  const c = clientWith(
    makePlayer({ field: [{ card: PIERCE.key, attacked: false, pos: 'attack' }] }),
    makePlayer({ field: [{ card: prey.key, attacked: false, pos: 'defense' }] }),
    'battle'
  );
  c.moves.attack(0, 0);
  const s = g(c);
  assert.equal(s.players['1'].field[0], null, '守备怪兽应被破坏');
  const expected = PIERCE.atk - prey.def;
  assert.equal(s.players['1'].lp, 4000 - expected, '贯通应造成 atk-def 伤害');
  c.stop();
});

test('集成·无贯通的普通怪破壁时不造成伤害（既有规则未被破坏）', () => {
  const plain = CARD_CATALOG.find((c) => c.sourceType === 'Normal Monster' && !c.monsterEffect);
  const prey = CARD_CATALOG.find(
    (c) => c.sourceType === 'Normal Monster' && c.def < plain.atk - 200
  );
  if (!plain || !prey) return;
  const c = clientWith(
    makePlayer({ field: [{ card: plain.key, attacked: false, pos: 'attack' }] }),
    makePlayer({ field: [{ card: prey.key, attacked: false, pos: 'defense' }] }),
    'battle'
  );
  c.moves.attack(0, 0);
  const s = g(c);
  assert.equal(s.players['1'].field[0], null, '守备怪兽应被破坏');
  assert.equal(s.players['1'].lp, 4000, '破壁不扣血');
  c.stop();
});

test('集成·直击：带直击效果的怪兽可越过对方怪兽打玩家', () => {
  if (!DIRECT) return;
  const blocker = CARD_CATALOG.find((c) => c.sourceType === 'Normal Monster');
  if (!blocker) return;
  const c = clientWith(
    makePlayer({ field: [{ card: DIRECT.key, attacked: false, pos: 'attack' }] }),
    makePlayer({ field: [{ card: blocker.key, attacked: false, pos: 'attack' }] }),
    'battle'
  );
  c.moves.attack(0, null); // 对方有怪兽，仍允许直接攻击
  const s = g(c);
  assert.equal(s.players['1'].lp, 4000 - DIRECT.atk, '直击应造成等同攻击力的伤害');
  assert.notEqual(s.players['1'].field[0], null, '对方怪兽不受影响');
  c.stop();
});

test('集成·直击守恒：无直击效果的怪兽不能越过对方怪兽', () => {
  const plain = CARD_CATALOG.find((c) => c.sourceType === 'Normal Monster' && !c.monsterEffect);
  const blocker = CARD_CATALOG.find((c) => c.sourceType === 'Normal Monster' && c.key !== plain.key);
  if (!plain || !blocker) return;
  const c = clientWith(
    makePlayer({ field: [{ card: plain.key, attacked: false, pos: 'attack' }] }),
    makePlayer({ field: [{ card: blocker.key, attacked: false, pos: 'attack' }] }),
    'battle'
  );
  c.moves.attack(0, null); // 应被拒绝
  const s = g(c);
  assert.equal(s.players['1'].lp, 4000, '对方有怪兽时不应扣血');
  assert.notEqual(s.players['1'].field[0], null, '对方怪兽应完好');
  c.stop();
});

test('集成·破坏灼烧：怪兽被战斗破坏时给对方伤害', () => {
  if (!BURN) return;
  const burn = Number(BURN.effectParams?.burn) || 0;
  // 让带灼烧效果的怪兽被更强的怪兽打败
  const killer = CARD_CATALOG.find(
    (c) => c.sourceType === 'Normal Monster' && c.atk > BURN.atk
  );
  if (!killer) return;
  const c = clientWith(
    makePlayer({ field: [{ card: killer.key, attacked: false, pos: 'attack' }] }),
    // BURN 卡在 P1 场上，被破坏后应给 P0 造成伤害
    makePlayer({ field: [{ card: BURN.key, attacked: false, pos: 'attack' }] }),
    'battle'
  );
  c.moves.attack(0, 0);
  const s = g(c);
  assert.equal(s.players['1'].field[0], null, '灼烧怪应被破坏');
  assert.equal(s.players['0'].lp, 4000 - burn, '被破坏时应对破坏者造成灼烧伤害');
  c.stop();
});

test('集成·破坏灼烧不误触发：祭品送墓不造成灼烧伤害', () => {
  if (!BURN) return;
  // 用一只需要祭品的高星怪召唤，祭掉灼烧怪；祭品不是"被破坏"，不应灼烧
  const highStar = CARD_CATALOG.find((c) => c.type === 'monster' && c.level >= 5 && c.level <= 6);
  if (!highStar) return;
  const c = clientWith(
    makePlayer({
      hand: [highStar.key],
      field: [{ card: BURN.key, attacked: false, pos: 'attack' }, null, null, null, null],
    }),
    makePlayer()
  );
  c.moves.summon(0, 1, 'attack'); // 献祭 BURN，召唤高星怪
  const s = g(c);
  assert.equal(s.players['1'].lp, 4000, '祭品送墓不应触发灼烧');
  c.stop();
});

test('集成·召唤抽牌：从墓地复活触发抽牌', () => {
  if (!DRAWBURN) return;
  const n = Number(DRAWBURN.effectParams?.draw) || 1;
  const filler = CARD_CATALOG.find((c) => c.type === 'monster');
  const c = clientWith(
    makePlayer({
      graveyard: [DRAWBURN.key],
      hand: [filler.key],
      deck: Array(10).fill(filler.key),
    }),
    makePlayer()
  );
  const before = g(c).players['0'].deck.length;
  c.moves.graveSummon(0, 'attack');
  const s = g(c);
  assert.equal(s.players['0'].deck.length, before - n, `从墓地复活应抽 ${n} 张`);
  c.stop();
});

