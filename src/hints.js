// 共享的"这一步能不能做 / 为什么不能"判断。
//
// 为什么要单独抽一个模块：game.js 里的 moves 只能返回 INVALID_MOVE，
// 而 INVALID_MOVE 是静默的——新手点了没反应会以为游戏坏了。所以棋盘
// 必须在点击前算出拒绝理由并显示出来。让 AI 和 UI 共用同一份判断，
// 可以避免"UI 说能做但 move 拒绝"这类不一致。
//
// 纯函数，不改状态，因此纯 Node 测试可直接导入。

import { CARDS, tributesNeeded, MAX_NORMAL_SUMMONS } from './cards.js';
import { resolveBattle, canDirectAttack } from './effects.js';

const occupiedSlots = (p) =>
  p.field.map((e, i) => (e ? i : -1)).filter((i) => i >= 0);

// 能否把这张牌通常召唤到场上？返回 {ok, slot} 或 {ok:false, reason}。
// slot 是推荐的目标槽位（已考虑祭品腾位）。
export function planSummon(p, cardId) {
  const card = CARDS[cardId];
  if (!card) return { ok: false, reason: '未知卡牌' };
  if (card.type !== 'monster') {
    return { ok: false, reason: `${card.cn} 是魔法卡，不能召唤上场` };
  }
  if ((p.normalSummons ?? 0) >= MAX_NORMAL_SUMMONS) {
    return { ok: false, reason: '本回合的通常召唤次数（1 只）已经用完了' };
  }

  const need = tributesNeeded(card.level);
  const onField = occupiedSlots(p).length;
  if (onField < need) {
    return {
      ok: false,
      reason:
        need === 0
          ? '场上没有空位了'
          : `${card.cn} 是 ${card.level} 星，需要 ${need} 只祭品，场上只有 ${onField} 只怪兽`,
    };
  }

  const tributes = need > 0 ? pickTributeSlots(p, need) : [];
  const empty = p.field.indexOf(null);
  if (empty === -1 && tributes.length === 0) {
    // 场上全满且这张卡不需要/凑不出祭品腾位：真的没有空位
    return { ok: false, reason: '场上没有空位了' };
  }
  // 没有空位时，放进被送走的祭品腾出的槽位
  const slot = empty !== -1 ? empty : tributes[tributes.length - 1];
  return { ok: true, slot, tributes };
}

function pickTributeSlots(p, count) {
  const occ = occupiedSlots(p)
    .map((i) => ({ i, atk: CARDS[p.field[i].card].atk }))
    .sort((a, b) => a.atk - b.atk);
  return occ.slice(0, count).map((x) => x.i);
}

// 能否发动这张魔法？返回 null 表示可以，否则返回拒绝理由。
export function spellBlocked(p, opp, cardId) {
  const card = CARDS[cardId];
  if (!card) return '未知卡牌';
  if (!['spell', 'trap'].includes(card.type)) {
    return card.cn + ' 不是魔法/陷阱卡';
  }
  switch (card.effect) {
    case 'draw2':
    case 'draw3':
      return null;
    case 'destroyStrongest':
      return opp.field.some(Boolean)
        ? null
        : '对方场上没有怪兽，这张卡没有目标';
    case 'reborn': {
      if (!p.field.includes(null)) return '场上没有空位，无法特殊召唤';
      const hasMonster = p.graveyard.some((id) => CARDS[id].type === 'monster');
      return hasMonster ? null : '墓地里没有可以复活的怪兽';
    }
    case 'lockdown':
      return p.spellTrapZone?.some((slot) => slot === null)
        ? null
        : '魔法/陷阱区已满，持续效果无法留场';
    default:
      return '这张卡的效果还没有实现';
  }
}

// 选中这只怪兽后，可以攻击哪些目标？
// 返回 {ok, targets, canDirect, directByEffect} 或 {ok:false, reason}。
// directByEffect：带「直击」效果的怪兽，即使对方场上有怪兽也能直接攻击玩家。
export function attackOptions(p, opp, attackerSlot) {
  const entry = p.field[attackerSlot];
  if (!entry) return { ok: false, reason: '这个槽位没有怪兽' };
  if (entry.pos === 'defense') {
    return { ok: false, reason: '守备表示的怪兽不能发起攻击' };
  }
  if (entry.attacked) {
    return { ok: false, reason: '这只怪兽本回合已经攻击过了' };
  }
  const targets = occupiedSlots(opp);
  if (p.firstTurn) {
    return { ok: false, reason: '这是你的第一个回合，不能发起攻击；出牌后请结束回合' };
  }
  const direct = canDirectAttack(entry.card);
  return {
    ok: true,
    targets,
    // 对方空场时人人可直击；对方有怪时只有带直击效果的怪兽可以
    canDirect: targets.length === 0 || direct,
    directByEffect: direct,
  };
}

// 战前预测：告诉 UI/AI「这次打下去会发生什么」。
// 与 game.js 的 attack 共用 effects.resolveBattle，杜绝「UI 说能打、move 却拒绝」
// 或「预告伤害和实际不一致」。返回 null 表示目标非法。
export function attackPreview(p, opp, attackerSlot, targetSlot) {
  const entry = p.field[attackerSlot];
  if (!entry) return null;
  const target = opp.field[targetSlot];
  if (!target) return null;
  const result = resolveBattle({
    attackerCardId: entry.card,
    defenderCardId: target.card,
    defenderPos: target.pos,
  });
  if (!result) return null;
  return {
    ...result,
    attackerName: CARDS[entry.card].cn,
    defenderName: CARDS[target.card].cn,
  };
}

// 能否把场上这只怪兽改变表示形式？返回 null 表示可以，否则返回理由。
// turn = ctx.turn：每只怪兽每回合只能改 1 次（由 entry.posTurn 记录改过的回合号）。
export function changePositionBlocked(p, slotIdx, turn) {
  const entry = p.field[slotIdx];
  if (!entry) return '这个槽位没有怪兽';
  if (entry.posTurn === turn) return '这只怪兽本回合已经改变过表示形式了';
  return null;
}

// 能否进入战斗阶段？返回 null 表示可以，否则返回理由。
export function toBattleBlocked(p, ctx) {
  if (p.lockedUntil > ctx.turn) {
    return '光之护封剑还在生效，本回合无法攻击';
  }
  return null;
}

// 这张魔法/怪兽在当前局面下"有没有用"，供 AI 参考（0 = 没必要发动）。
export function spellUseless(p, opp, cardId, handSize) {
  const card = CARDS[cardId];
  if (spellBlocked(p, opp, cardId)) return true;
  switch (card.effect) {
    case 'draw2':
    case 'draw3':
      // 手牌已经很多时，单纯抽牌价值下降
      return handSize >= 7;
    case 'destroyStrongest': {
      // 对方最强的怪兽打不倒自己时，破坏它意义不大
      const best = Math.max(
        0,
        ...opp.field.filter(Boolean).map((e) => CARDS[e.card].atk)
      );
      return best < 1500;
    }
    case 'reborn':
      return false;
    case 'lockdown':
      return false;
    default:
      return true;
  }
}

// 能否把这张手牌怪特殊召唤（v1 简化规则：每回合 1 次，场满时送最低攻
// 入墓腾位，有空位免费；不占通常召唤名额）？
// 返回 {ok, slot, tributeSlots} 或 {ok:false, reason}。
export function specialSummonPlan(p, cardId) {
  const card = CARDS[cardId];
  if (!card) return { ok: false, reason: '未知卡牌' };
  if (card.type !== 'monster') {
    return { ok: false, reason: `${card.cn} 是魔法卡，不能召唤上场` };
  }
  if (!card.canSpecialSummon) {
    return { ok: false, reason: `${card.cn} 没有可特殊召唤的效果` };
  }
  if (p.specialSummonUsed) {
    return { ok: false, reason: '本回合的特殊召唤已经用过了' };
  }
  const empty = p.field.indexOf(null);
  // 场满时靠送最低攻入墓腾位（复用祭品选择逻辑），场上有怪但没空位也要付代价
  const tributeSlots = empty === -1 ? pickTributeSlots(p, 1) : [];
  if (empty === -1 && tributeSlots.length === 0) {
    return { ok: false, reason: '场上没有空位了' };
  }
  const slot = empty !== -1 ? empty : tributeSlots[tributeSlots.length - 1];
  return { ok: true, slot, tributeSlots };
}

// 能否把墓地这张怪复活到场上（v1：代价 1 张手牌送墓，需空位，
// 与手牌特召共用每回合 1 次配额）？
export function graveSummonPlan(p, cardId) {
  const card = CARDS[cardId];
  if (!card) return { ok: false, reason: '未知卡牌' };
  if (card.type !== 'monster') return { ok: false, reason: '墓地这张不是怪兽' };
  if (!card.canSpecialSummon) {
    return { ok: false, reason: `${card.cn} 没有可特殊召唤的效果，不能复活` };
  }
  if (p.specialSummonUsed) {
    return { ok: false, reason: '本回合的特殊召唤已经用过了' };
  }
  if (p.hand.length === 0) {
    return { ok: false, reason: '复活需要 1 张手牌作代价，你手上没有牌' };
  }
  if (!p.field.includes(null)) {
    return { ok: false, reason: '场上没有空位，无法复活' };
  }
  return { ok: true, slot: p.field.indexOf(null) };
}
