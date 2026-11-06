// 怪兽效果 —— 纯逻辑，无 React、无网络依赖。
//
// 设计原则（见 AGENTS.md 决策记录「怪兽效果 v1」）：
//   1. **不模拟 OCG 原文**。本引擎没有连锁、除外、额外卡组、字段系统，
//      逐卡忠实实现不可行。效果被归入 5 个引擎能真实实现的类别，
//      由 make-duel-pool.mjs 用「整段锚定」正则给卡打标（monsterEffect 字段）。
//      打标前提是「牌面文本 = 引擎行为」，所以只收整段就是这一条效果的卡。
//   2. **不重写战斗公式**。效果只做「定点修正」，战斗管线本身不变：
//      directAttack 只放开目标选择；pierce 只改破壁那一条的伤害；
//      battleProtect 只取消破坏；battleBoost 只在伤害步骤内临时加攻。
//   3. **一切都是纯函数**。随机一律不用（需要随机时由调用方传 random），
//      保证客户端/服务端/回放三端结果一致。
//   4. **链深有上限**。效果可能互相触发（破坏 → 灼烧 → …），
//      超出 MAX_CHAIN_DEPTH 就停止，避免死循环卡死整局。
//
// 效果类清单：
//   directAttack  可直接攻击对方玩家（无视对方场上有怪兽）
//   pierce        攻击守备表示怪兽并将其破坏时，伤害 = 攻击力 − 守备力
//   battleProtect 不会被战斗破坏
//   summonDraw    召唤/特殊召唤成功时抽 N 张
//   destroyBurn   被战斗破坏送入墓地时，给与对方 N 点伤害
//   battleBoost   与特定怪兽战斗的伤害步骤内，攻击力 +N

import { CARDS } from './cards.js';

// 效果可能互相触发，链深上限防止「破坏 → 触发 → 再破坏」死循环。
// 8 层足够覆盖 v1 的所有组合（最坏情况：一只怪破另一只，二者都带 destroyBurn）。
export const MAX_CHAIN_DEPTH = 8;

// 效果类的中文名（UI 角标与日志共用，避免两处文案漂移）
export const EFFECT_LABELS = {
  directAttack: '直击',
  pierce: '贯通',
  battleProtect: '战斗免疫',
  summonDraw: '召唤抽牌',
  destroyBurn: '破坏灼烧',
  battleBoost: '战斗强化',
};

// 取一张卡的怪兽效果定义；没有则返回 null。
export function effectOf(cardId) {
  const card = CARDS[cardId];
  if (!card || !card.monsterEffect) return null;
  return {
    name: card.monsterEffect,
    params: card.effectParams || {},
  };
}

// 这张卡是否带指定效果？
export function hasEffect(cardId, name) {
  const card = CARDS[cardId];
  return Boolean(card && card.monsterEffect === name);
}

// ---------------------------------------------------------------------------
// battleBoost：伤害步骤内的临时攻击力
// ---------------------------------------------------------------------------
// 只在「这张卡与对方怪兽战斗」的伤害计算瞬间生效，不写入任何持久状态。
// 这样不会污染 CARDS（它是全局共享数据，改它会让双方与回放一起崩）。
//
// 判定条件来自卡面原文：
//   - 「和通常怪兽以外的怪兽进行战斗」→ 对方不是通常怪兽时加攻
//   - 「和光属性怪兽进行战斗」        → 对方是光属性时加攻
// 由于打标阶段已保证整段文本就是这一条，这里按卡面区分两种触发条件。
export function battleBoostFor(attackerCardId, defenderCardId) {
  const eff = effectOf(attackerCardId);
  if (!eff || eff.name !== 'battleBoost') return 0;
  const defender = CARDS[defenderCardId];
  if (!defender) return 0;
  // 用「这张卡自己的效果文本」判断触发条件（desc 是中文效果文本）
  const selfText = CARDS[attackerCardId]?.desc || '';
  const boost = Number(eff.params.boost) || 0;

  // 条件一：与「通常怪兽以外」的怪兽战斗
  if (/通常怪兽以外/.test(selfText)) {
    return defender.sourceType === 'Normal Monster' ? 0 : boost;
  }
  // 条件二：与「光属性」怪兽战斗
  if (/光属性/.test(selfText)) {
    return defender.attribute === 'LIGHT' ? boost : 0;
  }
  // 兜底：无法判定条件时不加攻（宁可保守，也不凭猜测改数值）
  return 0;
}

// 计算某只怪兽在本次战斗中的实际攻击力（含 battleBoost 修正）。
// 攻击侧与防守侧都要用这个函数取数，保证两边口径一致。
export function effectiveAtk(entryCardId, opponentCardId) {
  const card = CARDS[entryCardId];
  if (!card) return 0;
  const base = Number(card.atk) || 0;
  if (!opponentCardId) return base; // 直接攻击没有战斗对象，无修正
  return base + battleBoostFor(entryCardId, opponentCardId);
}

// ---------------------------------------------------------------------------
// 战斗相关效果
// ---------------------------------------------------------------------------

// directAttack：这只怪兽可以无视对方怪兽直接攻击玩家吗？
export function canDirectAttack(cardId) {
  return hasEffect(cardId, 'directAttack');
}

// pierce：攻击守备表示怪兽并将其破坏时，是否改为造成穿透伤害？
export function hasPierce(cardId) {
  return hasEffect(cardId, 'pierce');
}

// battleProtect：这只怪兽被战斗破坏时，是否抵消该次破坏？
export function hasBattleProtect(cardId) {
  return hasEffect(cardId, 'battleProtect');
}

// ---------------------------------------------------------------------------
// 触发型效果
// ---------------------------------------------------------------------------

// summonDraw：这只怪兽召唤成功后应抽几张？（0 表示不触发）
// 卡面文本写的是「从墓地的特殊召唤成功时」，因此只在「从墓地复活」时触发。
export function summonDrawCount(cardId, summonedFrom) {
  const eff = effectOf(cardId);
  if (!eff || eff.name !== 'summonDraw') return 0;
  const selfText = CARDS[cardId]?.desc || '';
  // 文本明确限定「从墓地的特殊召唤」→ 只在 grave 来源触发
  if (/墓地的特殊召唤/.test(selfText)) {
    return summonedFrom === 'grave' ? Number(eff.params.draw) || 1 : 0;
  }
  return Number(eff.params.draw) || 1;
}

// destroyBurn：这只怪兽被破坏送墓时应给对方多少伤害？（0 表示不触发）
export function destroyBurnAmount(cardId) {
  const eff = effectOf(cardId);
  if (!eff || eff.name !== 'destroyBurn') return 0;
  return Number(eff.params.burn) || 0;
}

// ---------------------------------------------------------------------------
// 触发器分发
// ---------------------------------------------------------------------------
// 统一入口：game.js 只负责在固定锚点调用它，不重复实现效果逻辑。
// 返回值描述「发生了什么」，由调用方决定如何写日志与演出 —— effect 层
// 不直接改 G，这样它可以被纯 Node 单测直接导入。

// 触发「召唤成功」类效果。返回 { draws: number }。
export function onSummonTriggers(cardId, summonedFrom) {
  return { draws: summonDrawCount(cardId, summonedFrom) };
}

// 触发「被破坏送墓」类效果。返回 { burn: number, byOwner: 'self'|'opponent' }。
// byOwner 表示伤害打给谁：destroyBurn 的受击者是「被破坏怪兽的控制者的对手」。
export function onDestroyTriggers(cardId) {
  return { burn: destroyBurnAmount(cardId) };
}

// 计算一次战斗的最终结果（纯函数，不碰状态）。
// 输入双方卡 id、守方表示形式；输出破坏/伤害/是否被免疫。
// game.js 拿到结果后按顺序落地，避免"计算"与"应用"混在一起难以测试。
//
// 返回：
//   {
//     atk,                   // 攻方本次实际攻击力（含 battleBoost）
//     defenderPower,         // 守方本次参与比较的数值
//     breakDefender,         // 是否破坏守方
//     breakAttacker,         // 是否破坏攻方
//     damageToDefender,      // 对守方玩家造成的伤害
//     damageToAttacker,      // 对攻方玩家造成的伤害
//     protectedByEffect,     // 守方是否因 battleProtect 免于破坏
//     pierced,               // 是否触发贯通伤害
//     outcome,               // 'win' | 'wall' | 'lose' | 'draw'
//   }
export function resolveBattle({
  attackerCardId,
  defenderCardId,
  defenderPos,
  attackerIsFirstTurn = false,
}) {
  const atkCard = CARDS[attackerCardId];
  const defCard = CARDS[defenderCardId];
  if (!atkCard || !defCard) {
    return null;
  }

  // 攻方实际攻击力：加入 battleBoost（与对方这个具体怪兽战斗时）
  const atk = effectiveAtk(attackerCardId, defenderCardId);
  // 守方参与比较的数值：守备表示用 DEF，攻击表示用 ATK
  const defenderPower =
    defenderPos === 'defense'
      ? Number(defCard.def) || 0
      : effectiveAtk(defenderCardId, attackerCardId);

  const wall = defenderPos === 'defense';
  const protect = hasBattleProtect(defenderCardId);
  const pierce = hasPierce(attackerCardId);

  // 攻击力更高：破坏守方
  if (atk > defenderPower) {
    // 破壁规则（用户 2025-06）：守备表示被破坏不扣血；
    // 但带「贯通」的攻方例外 —— 伤害 = 攻击力 − 守备力。
    const pierced = wall && pierce;
    const damageToDefender = wall ? (pierced ? atk - defenderPower : 0) : atk - defenderPower;
    return {
      atk,
      defenderPower,
      breakDefender: !protect,
      breakAttacker: false,
      damageToDefender: Math.max(0, damageToDefender),
      damageToAttacker: 0,
      protectedByEffect: protect,
      pierced,
      outcome: protect ? (wall ? 'wall' : 'win') : wall && !pierced ? 'wall' : 'win',
    };
  }

  // 攻击力更低：攻方被反杀
  if (atk < defenderPower) {
    const damageToAttacker = Math.max(0, defenderPower - atk);
    return {
      atk,
      defenderPower,
      breakDefender: false,
      breakAttacker: true,
      damageToDefender: 0,
      damageToAttacker,
      protectedByEffect: false,
      pierced: false,
      outcome: 'lose',
    };
  }

  // 攻击力相同：同归于尽（守方免疫时只有攻方被破坏）
  return {
    atk,
    defenderPower,
    breakDefender: !protect,
    breakAttacker: true,
    damageToDefender: 0,
    damageToAttacker: 0,
    protectedByEffect: protect,
    pierced: false,
    outcome: 'draw',
  };
}
