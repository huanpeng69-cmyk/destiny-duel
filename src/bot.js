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
import { CARDS, MAX_NORMAL_SUMMONS } from './cards.js';
import { planSummon, spellBlocked, spellUseless, attackOptions, attackPreview, toBattleBlocked, specialSummonPlan, graveSummonPlan, changePositionBlocked } from './hints.js';
import { resolveBattle } from './effects.js';

const opponentOf = (id) => (id === '0' ? '1' : '0');

// 怪兽效果在「召唤决策」里的估值（等效攻击力加成）。
// 只用于排序，不改动卡面数值与战斗结算。
//   directAttack：能越过对方怪兽直接打玩家，价值最高
//   pierce：    对方常摆守备，穿透伤害打开局面
//   destroyBurn / summonDraw / battleBoost：稳定小收益
const EFFECT_SUMMON_BONUS = {
  directAttack: 700,
  pierce: 400,
  battleBoost: 300,
  destroyBurn: 250,
  summonDraw: 250,
  battleProtect: 200,
};

function summonScore(card) {
  const atk = Number(card.atk) || 0;
  const bonus = card.monsterEffect ? EFFECT_SUMMON_BONUS[card.monsterEffect] || 0 : 0;
  return atk + bonus;
}

// ---- 守备化决策（2026-03）----
//
// 为什么 bot 需要这一步：破壁规则下「守备表示被破坏不扣血」，而攻击表示被
// 破坏要按 对方攻击力 − 我方攻击力 扣血（effects.resolveBattle）。bot 原先把
// 怪兽永远摆在攻击表示，等于每回合主动放弃这条防守收益，比人类玩家少一只手。
//
// 什么时候才转（避免瞎转）：
//   1) 这只怪兽本轮打不出收益 —— 打谁都会被反杀、又不能直击。否则留着进攻；
//   2) 转守备确实更省血 —— 用真实结算公式分别算两种表示形式的掉血损失，
//      只有守备更少才转。这样对方带「贯通」时（守备反而更亏）会自动排除；
//   3) 这只怪兽本回合还没改过表示 —— 每只怪兽每回合 1 次，不占通常召唤
//      （hints.changePositionBlocked 兜底，保证「AI 认为能做」与「move 接受」一致）。
//
// 配额史（2026-03，别改回去）：v1 让改表示与通常召唤共用 1 次配额，实测 8 局
// 完整对战里「守备化能省血」的时机出现 47 次，但配额只有 1 次空着可用，
// bot 全程只成功 1 次 —— 等于功能作废。改成「每只怪兽每回合 1 次、不占通常
// 召唤」后这条决策才真正跑起来。
function defensiveReposition({ G, ctx }, playerID) {
  const me = G.players[playerID];
  const foe = G.players[opponentOf(playerID)];
  // 用对方最强的一只做推演：够保守，也够便宜（不需要搜索全部进攻组合）。
  let foeBest = null;
  for (const entry of foe.field) {
    if (!entry) continue;
    const card = CARDS[entry.card];
    if (!card) continue;
    if (!foeBest || (Number(card.atk) || 0) > (Number(CARDS[foeBest.card].atk) || 0)) {
      foeBest = entry;
    }
  }
  if (!foeBest) return null; // 对方空场：没有威胁可防

  let best = null;
  me.field.forEach((entry, slot) => {
    if (!entry || entry.pos === 'defense') return;
    const card = CARDS[entry.card];
    if (!card) return;

    // 1) 还有进攻收益就不转：能直击，或能打死对方而自己不被破坏
    const opts = attackOptions(me, foe, slot);
    const hasOffense = opts.ok && (opts.canDirect || opts.targets.some((j) => {
      const preview = attackPreview(me, foe, slot, j);
      return preview && !preview.breakAttacker;
    }));
    if (hasOffense) return;

    // 2) 两种表示形式下的实际战损（damageToDefender = 守方玩家的掉血）
    const asAttack = resolveBattle({
      attackerCardId: foeBest.card,
      defenderCardId: entry.card,
      defenderPos: 'attack',
    });
    const asDefense = resolveBattle({
      attackerCardId: foeBest.card,
      defenderCardId: entry.card,
      defenderPos: 'defense',
    });
    if (!asAttack || !asDefense) return;
    const saved = asAttack.damageToDefender - asDefense.damageToDefender;
    if (saved <= 0) return;

    // 3) 这只怪兽本回合还没改过（与 move 共用同一守卫）
    if (changePositionBlocked(me, slot, ctx.turn) !== null) return;

    if (!best || saved > best.saved) best = { slot, saved };
  });

  return best ? { kind: 'changePosition', slot: best.slot } : null;
}

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

    // 2) 召唤场上能打出的最强怪兽（按攻击力排序，含祭品决策）。每回合 1 只
    //    通常召唤，用完走下面的特殊召唤。
    //    决策要点：敌方下回合能打我 1900+ 时，高防低攻的卡放守备表示更划算；
    //    否则一律攻击表示，因为守备表示会失去攻击机会。
    if ((me.normalSummons ?? 0) < MAX_NORMAL_SUMMONS) {
      const threat = Math.max(
        0,
        ...foe.field.filter(Boolean).map((e) => CARDS[e.card].atk)
      );
      const candidate = hand
        .filter((x) => x.card.type === 'monster')
        .map((x) => ({ x, plan: planSummon(me, x.id) }))
        .filter(({ plan }) => plan.ok)
        // 评分 = 攻击力 + 效果价值。
        // 为什么要给效果加权：否则 bot 永远按 ATK 选，效果怪因攻低而永远不上场，
        // 玩家就看不到「直击/贯通」这些玩法（实测过：6 局 0 次效果触发）。
        // 权重取「通常能换来多少等效伤害」，不改变既有数值强弱排序的主体。
        .sort((a, b) => summonScore(b.x.card) - summonScore(a.x.card))[0];
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

    // 3) 特殊召唤：每回合 1 次（手牌/墓地共用）。
    //    通常召唤名额用完或无合法通常召唤时，把带标记的强怪补上来。
    if (!(me.specialSummonUsed ?? false)) {
      const markedHand = hand
        .filter((x) => x.card.canSpecialSummon && x.card.type === 'monster')
        .sort((a, b) => b.card.atk - a.card.atk)[0];
      if (markedHand) {
        const plan = specialSummonPlan(me, markedHand.id);
        if (plan.ok) {
          return {
            kind: 'specialSummon',
            handIdx: markedHand.idx,
            pos: markedHand.card.def > markedHand.card.atk * 0.8 ? 'defense' : 'attack',
          };
        }
      }
      // 墓地复活：手里至少留 2 张（留资源余量），找墓地里攻最高的可特召怪
      const graveOpt = me.graveyard
        .map((id, i) => ({ id, i, card: CARDS[id] }))
        .filter((x) => x.card && x.card.type === 'monster' && x.card.canSpecialSummon)
        .sort((a, b) => b.card.atk - a.card.atk)[0];
      if (graveOpt && me.hand.length >= 2 && graveSummonPlan(me, graveOpt.id).ok) {
        return { kind: 'graveSummon', graveIdx: graveOpt.i, pos: 'attack' };
      }
    }
    // 4) 守备化：把打不出收益的攻击表示怪兽转守备，省下回合被反打的战损
    //    （破壁 0 伤）。不占通常召唤，所以放在召唤/特召之后——先摊完场面，
    //    再收起打不动的残兵。
    const reposition = defensiveReposition({ G, ctx }, playerID);
    if (reposition) return reposition;
    // 5) 进入战斗阶段，或直接结束回合
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

    // 对方空场，或自己带「直击」效果：直接打玩家最划算
    if (opts.canDirect) return { kind: 'attack', attacker: i, target: null };

    // 用战前预测挑选：只打「不会送掉自己」的目标。
    // 预测与 move 共用 resolveBattle，所以这里看到的破坏/伤害就是真实结算。
    const prey = opts.targets
      .map((j) => ({ j, preview: attackPreview(me, foe, i, j) }))
      .filter(({ preview }) => preview && !preview.breakAttacker)
      // 优先「破坏对方且有伤害」，其次「破坏对方」，最后「破壁清场」
      .sort((a, b) => {
        const score = (x) => {
          let s = 0;
          if (x.preview.breakDefender) s += 100;
          s += Math.min(99, x.preview.damageToDefender || 0) / 100;
          return s;
        };
        return score(b) - score(a);
      })[0];

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
    case 'specialSummon':
      client.moves.specialSummon(action.handIdx, action.pos || 'attack');
      break;
    case 'graveSummon':
      client.moves.graveSummon(action.graveIdx, action.pos || 'attack');
      break;
    case 'changePosition':
      client.moves.changePosition(action.slot);
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
