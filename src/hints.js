// 共享的"这一步能不能做 / 为什么不能"判断。
//
// 为什么要单独抽一个模块：game.js 里的 moves 只能返回 INVALID_MOVE，
// 而 INVALID_MOVE 是静默的——新手点了没反应会以为游戏坏了。所以棋盘
// 必须在点击前算出拒绝理由并显示出来。让 AI 和 UI 共用同一份判断，
// 可以避免"UI 说能做但 move 拒绝"这类不一致。
//
// 纯函数，不改状态，因此纯 Node 测试可直接导入。

import { CARDS, tributesNeeded } from './cards.js';

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
  if (p.normalSummonUsed) {
    return { ok: false, reason: '本回合的通常召唤次数已经用过了' };
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
// 返回 {ok, targets, canDirect} 或 {ok:false, reason}。
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
  if (targets.length === 0 && p.firstTurn) {
    return { ok: false, reason: '这是你的第一个回合，不能直接攻击；出牌后请结束回合' };
  }
  return { ok: true, targets, canDirect: targets.length === 0 };
}

// 能否把场上这只怪兽改变表示形式？返回 null 表示可以，否则返回理由。
export function changePositionBlocked(p, slotIdx) {
  if (p.normalSummonUsed) {
    return '改变表示形式要消耗通常召唤，本回合已经用过了';
  }
  if (!p.field[slotIdx]) return '这个槽位没有怪兽';
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
