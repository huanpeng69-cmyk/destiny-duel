// AI 决策单元测试 —— 直接向 decideNextAction 注入精确局面做断言。
//
// 为什么不用随机整局对局验证：随机对局里「bot 恰好摆出一只该守备化的怪兽」
// 只是偶尔出现，靠它验证等于碰运气（项目已有教训：效果系统做完了，可随机
// 对局里触发 0 次）。按 AGENTS.md 的验证协议，这里注入精确 G 断言决策结果，
// 随机整局只用于兜「卡死 / 不收敛」（那部分在 fullgame.test.js）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideNextAction, applyAction } from '../src/bot.js';
import { DestinyDuel } from '../src/game.js';
import { Client } from 'boardgame.io/dist/esm/client.js';

// 卡牌数值来源（src/data/duel-pool.json）：
//   mysticalElf 圣精灵   800/2000 —— 攻低防高，守备化的正主
//   geminiElf   双生精灵 1900/900  —— 攻高防低
//   darkMagician 黑魔术师 2500/2100
//   bitelon     咬噬龙   2400/1000 + 贯通
//   jinzo7      人造人7号 500/400  + 直击
//   servantOfCatabolism 异形的从者 700/500 + 直击

const mk = (over = {}) => ({
  lp: 4000,
  hand: [],
  deck: [],
  field: [null, null, null, null, null],
  spellTrapZone: [null, null, null],
  graveyard: [],
  normalSummons: 0,
  firstTurn: false,
  lockedUntil: 0,
  deckOut: false,
  specialSummonUsed: false,
  ...over,
});

const entry = (card, pos = 'attack', posTurn) => {
  const e = { card, attacked: false, pos };
  if (posTurn !== undefined) e.posTurn = posTurn; // 本回合改过表示形式的回合号
  return e;
};

// 注入局面：playerID '0' = bot，'1' = 对手。
function stateWith(p0, p1, step = 'main') {
  return {
    G: { players: { '0': p0, '1': p1 }, step, turnNumber: 4, log: [], fx: [], fxSeq: 0 },
    ctx: { turn: 4, currentPlayer: '0', step },
  };
}
const decide = (p0, p1) => decideNextAction(stateWith(p0, p1), '0');

// ---- 守备化（changePosition）----

test('打不出收益的攻击表示怪兽 → 转守备表示', () => {
  // 圣精灵 800/2000 打不过黑魔术师 2500：摆攻击 = 被破坏且掉 1700 血，
  // 摆守备 = 破壁 0 伤。这是纯赚的防守动作。
  const action = decide(
    mk({ field: [entry('mysticalElf'), null, null, null, null] }),
    mk({ field: [entry('darkMagician'), null, null, null, null] })
  );
  assert.deepEqual(action, { kind: 'changePosition', slot: 0 });
});

test('手里有能召唤的怪兽时先召唤，不顺带守备化', () => {
  // 守备化不占通常召唤配额（2026-03 改），但召唤带来的场面收益更大，仍先召唤。
  const action = decide(
    mk({ hand: ['geminiElf'], field: [entry('mysticalElf'), null, null, null, null] }),
    mk({ field: [entry('darkMagician'), null, null, null, null] })
  );
  assert.equal(action.kind, 'summon');
});

test('能打死对方且不被反杀的怪兽保持攻击表示（不守备化）', () => {
  const action = decide(
    mk({ field: [entry('geminiElf'), null, null, null, null] }),
    mk({ field: [entry('jinzo7'), null, null, null, null] })
  );
  assert.equal(action.kind, 'toBattle', '这只怪兽还有进攻收益，不能转守备');
});

test('直击效果的怪兽即使打不过也不守备化（它还能打玩家）', () => {
  const action = decide(
    mk({ field: [entry('servantOfCatabolism'), null, null, null, null] }),
    mk({ field: [entry('darkMagician'), null, null, null, null] })
  );
  assert.equal(action.kind, 'toBattle');
});

test('对方带「贯通」时守备反而更亏 → 不守备化', () => {
  // 双生精灵 1900/900 对上咬噬龙 2400（贯通）：
  //   摆攻击被破坏掉 500 血；摆守备被贯通掉 2400−900=1500 血。
  // 守备更差，所以必须保持原样。
  const action = decide(
    mk({ field: [entry('geminiElf'), null, null, null, null] }),
    mk({ field: [entry('bitelon'), null, null, null, null] })
  );
  assert.equal(action.kind, 'toBattle');
});

test('通常召唤名额用尽也照样能守备化（改表示不占名额）', () => {
  // 旧版让改表示与通常召唤共用 1 次配额，实测 8 局里 47 次有效防守机会只剩
  // 1 次用得上——功能等于作废，用户裁决改为「不占名额，每只怪兽每回合 1 次」。
  const action = decide(
    mk({ normalSummons: 1, field: [entry('mysticalElf'), null, null, null, null] }),
    mk({ field: [entry('darkMagician'), null, null, null, null] })
  );
  assert.deepEqual(action, { kind: 'changePosition', slot: 0 });
});

test('同一只怪兽本回合已经改过表示形式 → 不再守备化', () => {
  // ctx.turn = 4；posTurn 记 4 表示本回合改过，换回合（posTurn < 4）才放行。
  const action = decide(
    mk({ field: [entry('mysticalElf', 'attack', 4), null, null, null, null] }),
    mk({ field: [entry('darkMagician'), null, null, null, null] })
  );
  assert.equal(action.kind, 'toBattle', '每只怪兽每回合只能改 1 次');
});

test('对方空场时不守备化（没有威胁可防）', () => {
  const action = decide(
    mk({ field: [entry('mysticalElf'), null, null, null, null] }),
    mk()
  );
  assert.equal(action.kind, 'toBattle');
});

test('多只候选时，选省血最多的那只', () => {
  // 双生精灵 1900/900：守备更亏，不动。
  // 圣精灵 800/2000：省下 1700 血，最值得转。
  const action = decide(
    mk({ field: [entry('geminiElf'), entry('mysticalElf'), null, null, null] }),
    mk({ field: [entry('darkMagician'), null, null, null, null] })
  );
  assert.deepEqual(action, { kind: 'changePosition', slot: 1 });
});

test('applyAction 把 changePosition 落到真实 move 上，且不会原地打转', () => {
  const client = Client({
    game: {
      ...DestinyDuel,
      turn: {
        ...DestinyDuel.turn,
        order: { first: () => 0, next: ({ ctx }) => (ctx.playOrderPos + 1) % ctx.playOrder.length },
        onBegin: () => {},
      },
      setup: () => ({
        players: {
          '0': mk({ field: [entry('mysticalElf'), null, null, null, null] }),
          '1': mk({ field: [entry('darkMagician'), null, null, null, null] }),
        },
        step: 'main',
        turnNumber: 4,
        log: [],
        fx: [],
        fxSeq: 0,
      }),
    },
    playerID: '0',
  });
  client.start();

  const action = decideNextAction(client.getState(), '0');
  assert.equal(action.kind, 'changePosition');

  applyAction(client, action);
  const p0 = client.getState().G.players['0'];
  assert.equal(p0.field[0].pos, 'defense', '守备化应真实写回场上');
  assert.equal(p0.normalSummons, 0, '改表示不消耗通常召唤');
  assert.equal(p0.field[0].posTurn, client.getState().ctx.turn, '应记录改过表示的回合号');

  // 防死循环：同一只怪兽本回合已经改过，不能再守备化，否则 bot 会卡在原地不动。
  const next = decideNextAction(client.getState(), '0');
  assert.notEqual(next.kind, 'changePosition', '同一回合不应重复守备化');
  client.stop();
});
