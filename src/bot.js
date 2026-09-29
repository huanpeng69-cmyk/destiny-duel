// AI 对手 —— 脚本式机器人。
//
// 为什么不用框架自带的 RandomBot / MCTSBot：本作的 move 参数是手牌
// 下标、目标槽位，枚举空间要复刻全部守卫条件，容易出错。脚本机器人直接
// 复用与整局自动对局测试相同的决策思路——一次只做一个动作，由状态订阅
// 驱动，天然不会连点。
//
// 决策用的合法性判断与 UI 共用 hints.js，保证"AI 认为能做"和"move 接受"
// 永远一致。
//
// 本文件被纯 Node 测试导入，按 boardgame-io skill 规则使用深层 ESM 导入。

import { Client } from 'boardgame.io/dist/esm/client.js';
import { CARDS } from './cards.js';
import { planSummon, spellBlocked, spellUseless, attackOptions, toBattleBlocked } from './hints.js';

const opponentOf = (id) => (id === '0' ? '1' : '0');

// 下一步该做什么。返回 null 表示本回合无事可做，交还回合。
export function decideNextAction({ G, ctx }, playerID) {
  const me = G.players[playerID];
  const foe = G.players[opponentOf(playerID)];
  const hand = (me.hand || [])
    .map((id, idx) => ({ id, idx, card: CARDS[id] }))
    .filter((x) => x.card);

  if (G.step === 'main') {
    // 1) 魔法：优先抽牌（手牌少时价值最高），其次是能翻盘的效果
    const spell = hand
      .filter((x) => x.card.type === 'spell' && !spellBlocked(me, foe, x.id))
      .sort((a, b) => {
        const score = (x) => {
          if (x.card.effect === 'draw2' || x.card.effect === 'draw3') return 100 - me.hand.length;
          if (x.card.effect === 'lockdown') return foe.field.some(Boolean) ? 20 : 5;
          if (x.card.effect === 'destroyStrongest') return 60;
          if (x.card.effect === 'reborn') return 40;
          return 0;
        };
        return score(b) - score(a);
      })
      .find((x) => !spellUseless(me, foe, x.id, me.hand.length));
    if (spell) return { kind: 'spell', handIdx: spell.idx };

    // 2) 召唤场上能打出的最强怪兽（按攻击力排序，含祭品决策）
    //    决策要点：敌方下回合能打我 1900+ 时，高防低攻的卡放守备表示更划算；
    //    否则一律攻击表示，因为守备表示会失去攻击机会。
    if (!me.normalSummonUsed) {
      const threat = Math.max(
        0,
        ...foe.field.filter(Boolean).map((e) => CARDS[e.card].atk)
      );
      const candidate = hand
        .filter((x) => x.card.type === 'monster')
        .map((x) => ({ x, plan: planSummon(me, x.id) }))
        .filter(({ plan }) => plan.ok)
        .sort((a, b) => b.x.card.atk - a.x.card.atk)[0];
      if (candidate) {
        const c = candidate.x.card;
        // 守备表示的收益：def 高、atk 低于对手威胁时，能大幅削减伤害
        const pos =
          c.def > c.atk * 0.8 && c.atk < threat ? 'defense' : 'attack';
        return {
          kind: 'summon',
          handIdx: candidate.x.idx,
          slot: candidate.plan.slot,
          pos,
        };
      }
    }

    // 3) 进入战斗阶段，或直接结束回合
    if (!toBattleBlocked(me, ctx)) return { kind: 'toBattle' };
    return { kind: 'endTurn' };
  }

  // ---- 战斗阶段 ----
  const ready = me.field
    .map((entry, i) => ({ entry, i }))
    .filter(({ entry }) => entry && !entry.attacked && entry.pos !== 'defense');

  for (const { entry, i } of ready) {
    const opts = attackOptions(me, foe, i);
    if (!opts.ok) continue;

    // 对方空场：直接攻击
    if (opts.canDirect) return { kind: 'attack', attacker: i, target: null };

    const myAtk = CARDS[entry.card].atk;
    // 只打稳赢的目标：攻击力严格大于对方才出手，避免无谓送怪
    const prey = opts.targets
      .map((j) => ({ j, atk: CARDS[foe.field[j].card].atk }))
      .filter((t) => myAtk > t.atk)
      // 优先打能一击致命的，其次打攻击力最高的
      .sort((a, b) => (myAtk - b.atk) - (myAtk - a.atk) || b.atk - a.atk)[0];
    if (prey) return { kind: 'attack', attacker: i, target: prey.j };
  }

  return { kind: 'endTurn' };
}

// 导出让整局自动对局测试复用同一套动作映射，避免测试与 AI 逻辑漂移。
export function applyAction(client, action) {
  switch (action.kind) {
    case 'spell':
      client.moves.castSpell(action.handIdx);
      break;
    case 'summon':
      client.moves.summon(action.handIdx, action.slot, action.pos || 'attack');
      break;
    case 'toBattle':
      client.moves.toBattle();
      break;
    case 'attack':
      client.moves.attack(action.attacker, action.target);
      break;
    case 'endTurn':
      client.moves.endTurn();
      break;
    default:
      break;
  }
}

// 创建一个在自己回合自动行动的 AI 客户端。
// 必须与人类客户端共享同一个 multiplayer 实例和 matchID。
// 返回带 stop() 的 client。
export function createBotClient({
  game,
  multiplayer,
  matchID,
  playerID = '1',
  delayMs = 1100,
}) {
  // debug: false 是必须的：Local() 的 master 会把调试面板挂到 document.body，
  // 门槛是 client.debugOpt === false。只要有任何一个客户端没显式关掉，
  // 面板就会出现，浮在棋盘上方拦截真实点击（人类客户端关了也没用）。
  const client = Client({ game, multiplayer, matchID, playerID, debug: false });
  let timer = null;

  const tick = () => {
    timer = null;
    const state = client.getState();
    if (!state || state.ctx.gameover) return;
    if (state.ctx.currentPlayer !== playerID) return;
    const action = decideNextAction(state, playerID);
    if (action) applyAction(client, action);
    // 动作引发状态更新 -> 订阅再次触发 -> 走出下一步
  };

  const unsubscribe = client.subscribe(() => {
    const state = client.getState();
    if (!state || state.ctx.gameover) return;
    if (state.ctx.currentPlayer !== playerID) return;
    if (timer !== null) return; // 同一时刻只排一个动作
    timer = setTimeout(tick, delayMs);
  });

  client.start();

  const origStop = client.stop.bind(client);
  client.stop = () => {
    if (timer !== null) clearTimeout(timer);
    unsubscribe();
    origStop();
  };
  return client;
}
