// 全自动整局对局测试。
//
// 用与 AI 完全相同的决策函数（decideNextAction + applyAction）驱动双方，
// 通过与 UI 完全一致的 client.moves.* 接口把整局打完，直到分出胜负。
// 多种子运行，验证游戏能被人类从开局玩到终局而不中途卡死或状态异常。
//
// 这是 skill 里最看重的测试类型：单元测试全绿不等于这局能玩完。

import test from 'node:test';
import assert from 'node:assert/strict';
import { DestinyDuel } from '../src/game.js';
import { CARDS } from '../src/cards.js';
import { decideNextAction, applyAction } from '../src/bot.js';
import { Client } from 'boardgame.io/dist/esm/client.js';
import { Local } from 'boardgame.io/dist/esm/multiplayer.js';

async function playFullGame(seed) {
  const spec = {
    game: { ...DestinyDuel, seed },
    multiplayer: Local(),
  };
  const p0 = Client({ ...spec, playerID: '0' });
  const p1 = Client({ ...spec, playerID: '1' });
  p0.start();
  p1.start();
  await new Promise((r) => setTimeout(r, 120));

  let turns = 0;
  let actions = 0;
  while (!p0.getState().ctx.gameover && turns < 300) {
    const state = p0.getState();
    const current = state.ctx.currentPlayer;
    const client = current === '0' ? p0 : p1;
    const action = decideNextAction(client.getState(), current);
    if (action) {
      applyAction(client, action);
      actions++;
    }
    await new Promise((r) => setTimeout(r, 12));
    turns++;
  }

  const final = p0.getState();
  p0.stop();
  p1.stop();
  return { turns, actions, ctx: final.ctx, G: final.G };
}

for (const seed of ['duel-1', 'duel-2', 'duel-3', 'duel-4', 'duel-5']) {
  test(`整局自动对局（seed=${seed}）能正常分出胜负`, async () => {
    const { turns, actions, ctx, G } = await playFullGame(seed);

    assert.ok(
      ctx.gameover,
      `300 步内未分出胜负（实际 ${turns} 步 / ${actions} 次动作）`
    );

    if (ctx.gameover.winner === null) {
      // 平局：双方都应满足败北条件
      assert.ok(
        G.players['0'].lp <= 0 || G.players['0'].deckOut,
        '平局时玩家 0 应满足败北条件'
      );
      assert.ok(
        G.players['1'].lp <= 0 || G.players['1'].deckOut,
        '平局时玩家 1 应满足败北条件'
      );
      return;
    }

    const winner = ctx.gameover.winner;
    const loserId = winner === '0' ? '1' : '0';
    const loser = G.players[loserId];
    const champ = G.players[winner];

    // 败者必满足：生命值归零 或 卡组抽干
    assert.ok(
      loser.lp <= 0 || loser.deckOut,
      '败者应满足生命值归零或卡组抽干'
    );
    // 胜者必须还活着
    assert.ok(champ.lp > 0 && !champ.deckOut, '胜者状态应合法');
  });
}

test('AI 在无怪兽可打时不会空转到超限', async () => {
  const { actions, turns } = await playFullGame('idle-check');
  assert.ok(actions > 0, '应至少执行一个动作');
  assert.ok(actions <= turns + 1, '每步至多一个动作，不应连点');
});

test('战报在整局中持续累积且可读', async () => {
  const { G } = await playFullGame('log-check');
  assert.ok(Array.isArray(G.log), 'log 应是数组');
  assert.ok(G.log.length > 0, '战报不应为空');
  for (const e of G.log) {
    assert.equal(typeof e.text, 'string');
    assert.ok(e.text.length > 0, '战报文本不应为空串');
  }
  // 战报有上限，不会无限增长
  assert.ok(G.log.length <= 40, '战报长度应受 LOG_LIMIT 约束');
});

test('场上的怪兽数量始终不超过槽位数', async () => {
  const spec = { game: DestinyDuel, multiplayer: Local() };
  const c0 = Client({ ...spec, playerID: '0' });
  const c1 = Client({ ...spec, playerID: '1' });
  c0.start();
  c1.start();
  await new Promise((r) => setTimeout(r, 120));

  for (let i = 0; i < 80; i++) {
    const state = c0.getState();
    if (state.ctx.gameover) break;
    for (const id of ['0', '1']) {
      const f = state.G.players[id].field;
      assert.equal(f.length, 5, '每个玩家固定 5 个槽位');
      assert.ok(f.filter(Boolean).length <= 5, '怪兽数不能超过槽位数');
    }
    const current = state.ctx.currentPlayer;
    const client = current === '0' ? c0 : c1;
    const action = decideNextAction(client.getState(), current);
    if (action) applyAction(client, action);
    await new Promise((r) => setTimeout(r, 10));
  }
  c0.stop();
  c1.stop();
});

// ---- 先后手随机（回归测试，2026-03）----
// 踩坑根因：matchID 固定为 'duel-0' 时，Local() 用它派生确定性种子，
// random.Shuffle([0,1])[0] 每次返回同一个值 → 永远是同一方先发。
// 玩家反馈「每次都对手先」，实测 A/B 对照确认（10/10 局 AI 先发）。
// 修复：index.jsx 给 matchID 加页面加载时间戳。
// 防再犯：不同 matchID 必须产生不同先发，否则这条回归。
test('先后手随机：不同 matchID 应产生不同先发方（防固定先发回归）', async () => {
  const firsts = new Set();
  // 取 12 个不同 matchID；只要出现两种先发方就说明随机生效
  for (let i = 0; i < 12; i++) {
    const mp = Local();
    const c = Client({
      game: DestinyDuel,
      multiplayer: mp,
      matchID: `duel-0-${(10000 + i * 37).toString(36)}`,
      playerID: '0',
      debug: false,
    });
    c.start();
    await new Promise((r) => setTimeout(r, 20));
    firsts.add(c.getState().ctx.currentPlayer);
    c.stop();
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(
    firsts.size > 1,
    `不同 matchID 的先发方应随机变化，实际只有 ${JSON.stringify([...firsts])}`
  );
});
