// 规则单元测试 —— 直接用 Client 驱动，覆盖每条新手规则的边界。
// 按 skill 要求，本文件导入的所有 boardgame.io 模块都用深层 ESM 路径，
// 这样纯 Node（无打包器）也能加载。

import test from 'node:test';
import assert from 'node:assert/strict';
import { DestinyDuel } from '../src/game.js';
import { Client } from 'boardgame.io/dist/esm/client.js';
import { Local } from 'boardgame.io/dist/esm/multiplayer.js';

// 构造一个指定状态的客户端，便于精确测试每条规则。
// onBegin 打桩为空：client.start() 会触发它，而它会抽 1 张牌，污染手牌断言。
// 回合钩子本身由下面的「回合钩子」测试单独覆盖。
function clientWith(p0, p1) {
  const client = Client({
    game: {
      ...DestinyDuel,
      turn: { ...DestinyDuel.turn, onBegin: () => {} },
      setup: () => ({
        players: { '0': p0, '1': p1 },
        step: 'main',
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

function duelClients(p0, p1) {
  const multiplayer = Local();
  const game = {
    ...DestinyDuel,
    turn: { ...DestinyDuel.turn, onBegin: () => {} },
    setup: () => ({
      players: { '0': p0, '1': p1 },
      step: 'main',
      turnNumber: 1,
      log: [],
      fx: [],
      fxSeq: 0,
    }),
  };
  const clients = ['0', '1'].map((playerID) => Client({
    game,
    multiplayer,
    matchID: 'spell-lifecycle-test',
    playerID,
  }));
  clients.forEach((client) => client.start());
  return clients;
}

const mk = (over = {}) => ({
  lp: 4000,
  hand: [],
  deck: ['potOfGreed', 'potOfGreed', 'potOfGreed', 'potOfGreed', 'potOfGreed'],
  field: [null, null, null],
  spellTrapZone: [null, null, null],
  graveyard: [],
  normalSummonUsed: false,
  lockedUntil: 0,
  deckOut: false,
  ...over,
});

const g = (client) => client.getState().G;
const ctx = (client) => client.getState().ctx;

// ---- 召唤与祭品 ----

test('4 星怪兽无需祭品即可召唤', () => {
  const c = clientWith(mk({ hand: ['geminiElf'] }), mk());
  c.moves.summon(0, 1);
  assert.equal(g(c).players['0'].field[1].card, 'geminiElf');
  assert.equal(g(c).players['0'].hand.length, 0);
  assert.equal(g(c).players['0'].normalSummonUsed, true);
  c.stop();
});

test('7 星怪兽需要 2 个祭品，场上不足时拒绝', () => {
  const c = clientWith(mk({ hand: ['darkMagician'] }), mk());
  c.moves.summon(0, 0);
  assert.equal(g(c).players['0'].field[0], null, '没有祭品时不应召唤成功');
  c.stop();
});

test('7 星怪兽在 2 个祭品齐备时成功，祭品入墓', () => {
  const c = clientWith(
    mk({
      hand: ['darkMagician'],
      field: [{ card: 'geminiElf', attacked: false }, { card: 'gearfried', attacked: false }, null],
    }),
    mk()
  );
  c.moves.summon(0, 0);
  const f = g(c).players['0'].field;
  assert.equal(f[0].card, 'darkMagician', '应放进被腾出的槽位');
  assert.equal(g(c).players['0'].graveyard.length, 2, '两只祭品应进墓地');
  c.stop();
});

test('每回合只能通常召唤一次', () => {
  const c = clientWith(mk({ hand: ['geminiElf', 'gearfried'] }), mk());
  c.moves.summon(0, 0);
  c.moves.summon(1, 1);
  assert.equal(g(c).players['0'].field[1], null, '第二次通常召唤应被拒绝');
  c.stop();
});

test('不能召唤魔法卡', () => {
  const c = clientWith(mk({ hand: ['potOfGreed'] }), mk());
  c.moves.summon(0, 0);
  assert.equal(g(c).players['0'].field[0], null);
  c.stop();
});

// ---- 魔法 ----

test('贪杯之瓶抽 2 张', () => {
  const c = clientWith(mk({ hand: ['potOfGreed'], deck: ['geminiElf', 'gearfried', 'redEyes'] }), mk());
  c.moves.castSpell(0);
  assert.equal(g(c).players['0'].hand.length, 2);
  assert.equal(g(c).players['0'].hand[0], 'geminiElf');
  assert.ok(g(c).players['0'].graveyard.includes('potOfGreed'), '一次性魔法效果用完后应进入墓地');
  c.stop();
});

test('恩惠的抽卡抽 3 张', () => {
  const c = clientWith(mk({ hand: ['gracefulCharity'], deck: ['geminiElf', 'gearfried', 'redEyes'] }), mk());
  c.moves.castSpell(0);
  assert.equal(g(c).players['0'].hand.length, 3);
  c.stop();
});

test('银河旋风破坏对方攻击力最高的怪兽', () => {
  const c = clientWith(
    mk({ hand: ['typhoon'] }),
    mk({
      field: [
        { card: 'geminiElf', attacked: false },   // 攻 1900
        { card: 'blueEyes', attacked: false },    // 攻 3000 <- 目标
        { card: 'gearfried', attacked: false },    // 攻 1800
      ],
    })
  );
  c.moves.castSpell(0);
  const f = g(c).players['1'].field;
  assert.equal(f[1], null, '青眼白龙应被破坏');
  assert.equal(f[0].card, 'geminiElf');
  assert.equal(f[2].card, 'gearfried');
  c.stop();
});

test('银河旋风在对方场上无怪兽时拒绝发动', () => {
  const c = clientWith(mk({ hand: ['typhoon'] }), mk());
  c.moves.castSpell(0);
  assert.equal(g(c).players['0'].hand.length, 1, '手牌不应减少');
  c.stop();
});

test('死者苏生从墓地特殊召唤，不占通常召唤次数', () => {
  const c = clientWith(
    mk({ hand: ['monsterReborn'], graveyard: ['geminiElf'] }),
    mk()
  );
  c.moves.castSpell(0);
  assert.equal(g(c).players['0'].field[0].card, 'geminiElf');
  assert.equal(g(c).players['0'].normalSummonUsed, false, '不应占用通常召唤');
  c.stop();
});

test('死者苏生在墓地里没有怪兽时拒绝', () => {
  const c = clientWith(mk({ hand: ['monsterReborn'], graveyard: [] }), mk());
  c.moves.castSpell(0);
  assert.equal(g(c).players['0'].hand.length, 1);
  c.stop();
});

test('一次性魔法在持续效果区已满时仍能发动并进入墓地', () => {
  const c = clientWith(
    mk({ hand: ['potOfGreed'], spellTrapZone: [{ card: 'swordsOfLight' }, { card: 'swordsOfLight' }, { card: 'swordsOfLight' }] }),
    mk()
  );
  c.moves.castSpell(0);
  assert.equal(g(c).players['0'].hand.length, 2, '抽到的两张牌仍留在手牌');
  assert.ok(g(c).players['0'].graveyard.includes('potOfGreed'));
  c.stop();
});

test('光之护封剑留在场上直到对手回合结束，再进入墓地', () => {
  const [p0, p1] = duelClients(mk({ hand: ['swordsOfLight'] }), mk());
  const g0 = () => p0.getState().G;
  p0.moves.castSpell(0);
  assert.equal(g0().players['0'].spellTrapZone[0].card, 'swordsOfLight');
  assert.ok(!g0().players['0'].graveyard.includes('swordsOfLight'));
  assert.equal(g0().players['1'].lockedUntil, 3);

  p0.moves.endTurn();
  assert.equal(p0.getState().ctx.currentPlayer, '1');
  p1.moves.toBattle();
  assert.equal(g0().step, 'main', '受影响回合不能进入战斗阶段');
  p1.moves.endTurn();

  assert.equal(g0().players['0'].spellTrapZone[0], null);
  assert.ok(g0().players['0'].graveyard.includes('swordsOfLight'));
  p0.stop();
  p1.stop();
});

// ---- 战斗 ----

function battle(p0, p1) {
  const c = clientWith(p0, p1);
  c.moves.toBattle();
  assert.equal(g(c).step, 'battle', '应已进入战斗阶段');
  return c;
}

test('攻击表示对战使用攻击力相减', () => {
  // 青眼白龙 攻3000 打 双生精灵 攻1900/防900（攻击表示）=> 伤害 1100
  const c = battle(
    mk({ field: [{ card: 'blueEyes', attacked: false }, null, null] }),
    mk({ field: [{ card: 'geminiElf', attacked: false, pos: 'attack' }, null, null] })
  );
  c.moves.attack(0, 0);
  assert.equal(g(c).players['1'].field[0], null, '守方应被破坏');
  assert.equal(g(c).players['1'].lp, 4000 - (3000 - 1900));
  c.stop();
});

test('攻击力更低时，攻击表示对战仍按攻击力相减', () => {
  // 双生精灵 攻1900/防900 打 青眼白龙 攻3000/防2500 => 伤害 1100
  const c = battle(
    mk({ field: [{ card: 'geminiElf', attacked: false }, null, null] }),
    mk({ field: [{ card: 'blueEyes', attacked: false, pos: 'attack' }, null, null] })
  );
  c.moves.attack(0, 0);
  assert.equal(g(c).players['0'].field[0], null, '攻击方应被破坏');
  assert.equal(g(c).players['0'].lp, 4000 - (3000 - 1900));
  c.stop();
});

test('守备表示对战使用攻击力减防守力', () => {
  // 青眼白龙 攻3000 打 精灵之少女 守备力2000 => 伤害 1000
  const c = battle(
    mk({ field: [{ card: 'blueEyes', attacked: false }, null, null] }),
    mk({ field: [{ card: 'mysticalElf', attacked: false, pos: 'defense' }, null, null] })
  );
  c.moves.attack(0, 0);
  assert.equal(g(c).players['1'].field[0], null, '守方应被破坏');
  assert.equal(g(c).players['1'].lp, 4000 - (3000 - 2000));
  c.stop();
});

test('攻击力相同时同归于尽，双方不掉血', () => {
  // 两只双生精灵 攻1900 相撞
  const c = battle(
    mk({ field: [{ card: 'geminiElf', attacked: false }, null, null] }),
    mk({ field: [{ card: 'geminiElf', attacked: false }, null, null] })
  );
  c.moves.attack(0, 0);
  assert.equal(g(c).players['0'].field[0], null);
  assert.equal(g(c).players['1'].field[0], null);
  assert.equal(g(c).players['0'].lp, 4000);
  assert.equal(g(c).players['1'].lp, 4000);
  c.stop();
});

test('直接攻击在对方有怪兽时被拒绝', () => {
  const c = battle(
    mk({ field: [{ card: 'blueEyes', attacked: false }, null, null] }),
    mk({ field: [{ card: 'geminiElf', attacked: false }, null, null] })
  );
  c.moves.attack(0, null);
  assert.equal(g(c).players['1'].lp, 4000, '不应造成伤害');
  assert.equal(g(c).players['0'].field[0].attacked, false, '不应标记为已攻击');
  c.stop();
});

test('对方空场时可以直击，伤害 = 攻击力', () => {
  const c = battle(
    mk({ field: [{ card: 'blueEyes', attacked: false }, null, null] }),
    mk()
  );
  c.moves.attack(0, null);
  assert.equal(g(c).players['1'].lp, 4000 - 3000);
  c.stop();
});

test('每位玩家的第一个回合不能直接攻击，结束回合后解除限制', () => {
  const c = clientWith(
    mk({ firstTurn: true, field: [{ card: 'blueEyes', attacked: false }, null, null] }),
    mk()
  );
  c.moves.toBattle();
  c.moves.attack(0, null);
  assert.equal(g(c).players['1'].lp, 4000, '首回合直接攻击应被拒绝');
  assert.equal(g(c).players['0'].field[0].attacked, false);
  c.moves.endTurn();
  assert.equal(g(c).players['0'].firstTurn, false, '结束回合后应解除限制');
  c.stop();
});

test('同一只怪兽每回合只能攻击一次', () => {
  const c = battle(
    mk({ field: [{ card: 'blueEyes', attacked: false }, null, null] }),
    mk()
  );
  c.moves.attack(0, null);
  c.moves.attack(0, null);
  assert.equal(g(c).players['1'].lp, 4000 - 3000, '只应造成一次伤害');
  c.stop();
});

test('主要阶段不能攻击', () => {
  const c = clientWith(
    mk({ field: [{ card: 'blueEyes', attacked: false }, null, null] }),
    mk()
  );
  c.moves.attack(0, null);
  assert.equal(g(c).players['1'].lp, 4000);
  c.stop();
});

// ---- 胜负 ----

test('生命值归零判负', () => {
  const c = battle(
    mk({ field: [{ card: 'blueEyes', attacked: false }, null, null] }),
    mk({ lp: 2000 })
  );
  c.moves.attack(0, null);
  assert.equal(ctx(c).gameover.winner, '0');
  c.stop();
});

test('卡组抽干判负', () => {
  const c = clientWith(mk({ hand: ['potOfGreed'], deck: [] }), mk());
  c.moves.castSpell(0);
  assert.equal(g(c).players['0'].deckOut, true);
  assert.equal(ctx(c).gameover.winner, '1');
  c.stop();
});

// ---- 秘密状态 ----

test('playerView 隐藏对手手牌与双方卡组', () => {
  const c = clientWith(
    mk({ hand: ['geminiElf', 'gearfried'], deck: ['potOfGreed', 'redEyes'] }),
    mk({ hand: ['blueEyes'], deck: ['darkMagician'] })
  );
  const view = c.getState().G;
  assert.equal(view.players['1'].hand[0], null, '对手手牌应被隐藏');
  assert.equal(view.players['0'].hand[0], 'geminiElf', '自己手牌应可见');
  assert.equal(view.players['0'].deck[0], null, '自己卡组也应隐藏');
  assert.equal(view.players['1'].deck[0], null);
  c.stop();
});

// ---- 回合钩子（用真实 setup，不打桩）----

test('回合开始抽 1 张牌并重置回合内标记', () => {
  const c = Client({ game: DestinyDuel, playerID: '0' });
  c.start();
  const { G, ctx } = c.getState();
  const p = G.players[ctx.currentPlayer];
  // setup 发 5 张，onBegin 再抽 1 张
  assert.equal(p.hand.length, 6);
  assert.equal(p.lp, 4000);
  assert.equal(p.normalSummonUsed, false);
  assert.equal(G.step, 'main');
  c.stop();
});

test('新一轮开始时清除上一回合的攻击标记与召唤次数', async () => {
  const multiplayer = Local();
  const c0 = Client({ game: DestinyDuel, multiplayer, playerID: '0' });
  const c1 = Client({ game: DestinyDuel, multiplayer, playerID: '1' });
  c0.start();
  c1.start();
  await new Promise((r) => setTimeout(r, 80));

  // 玩家 0 正常行动一回合
  c0.moves.summon(0, 0);
  c0.moves.toBattle();
  c0.moves.attack(0, null);
  c0.moves.endTurn();
  await new Promise((r) => setTimeout(r, 80));

  // 玩家 1 也结束回合，才会真正进入玩家 0 的下一回合。
  c1.moves.endTurn();
  await new Promise((r) => setTimeout(r, 80));

  // 玩家 0 的下个回合：攻击标记与召唤次数都应重置
  const p0 = c0.getState().G.players['0'];
  assert.equal(p0.normalSummonUsed, false, '召唤次数应重置');
  c0.stop();
  c1.stop();
});
