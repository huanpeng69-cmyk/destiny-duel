// 命运对决 —— 游戏定义（纯逻辑，无 React、无网络依赖）。
//
// 两个关键设计沿用 boardgame-io skill 的实战结论：
//
// 1. 不用 flow phases。boardgame.io 的 phase 结峰会强制结束当前回合，
//    而这里是"一个回合内含 主要阶段 / 战斗阶段 两个子步骤"，所以用
//    单一隐式阶段 + G.step 跟踪子步骤，moves 内做守卫。
//
// 2. 所有随机走注入的 random API（random.Shuffle），因为框架要把
//    move/hook 在客户端和服务端各跑一遍并支持回放；Math.random 会
//    让两端状态分叉。

import { INVALID_MOVE } from 'boardgame.io/dist/esm/core.js';
import {
  CARDS,
  buildRandomDeck,
  FIELD_SLOTS,
  START_LP,
  START_HAND,
  LOG_LIMIT,
  SPELL_TRAP_SLOTS,
  MAX_NORMAL_SUMMONS,
  tributesNeeded,
} from './cards.js';
// 怪兽效果（5 类，纯函数）：效果只在固定锚点被调用，不重写战斗公式。
import {
  MAX_CHAIN_DEPTH,
  canDirectAttack,
  onSummonTriggers,
  onDestroyTriggers,
  resolveBattle,
} from './effects.js';

const opponentOf = (id) => (id === '0' ? '1' : '0');

function makePlayer() {
  return {
    lp: START_LP,
    hand: [],
    deck: [],
    // 槽位: { card, attacked, pos } | null
    // pos: 'attack' | 'defense'。守备表示的怪兽不能发起攻击。
    field: Array(FIELD_SLOTS).fill(null),
    spellTrapZone: Array(SPELL_TRAP_SLOTS).fill(null),
    graveyard: [],
    normalSummons: 0,
    lockedUntil: 0, // 光的护封剑：此回合号之前不能进入战斗阶段
    deckOut: false,  // 抽牌时卡组为空 => 判负
    firstTurn: true, // 每位玩家各自的首个回合：不能发起任何攻击
    specialSummonUsed: false, // 每回合 1 次特殊召唤（手牌/墓地共用配额）
  };
}

// 战报 + 演出事件。
// 两份都放在 G 里：战报供人读，fx 供动画引擎消费。放在 G 而非组件内
// diff，是为了让"攻击者被反杀"这类卡片随攻击者一起消失的场景不会漏掉
// 事件（skill 里记录的 diff 引擎盲区），并且能随状态一起回放。
// fx 是增量字段，不影响 G 的 JSON 可序列化性。
function say(G, who, text, fx) {
  G.log.push({ turn: G.turnNumber, who, text });
  if (G.log.length > LOG_LIMIT) G.log.shift();
  // fx 只服务演出，缺失时按需补齐——展示字段不应有能力弄崩规则引擎
  if (!G.fx) G.fx = [];
  if (!G.fxSeq) G.fxSeq = 0;
  G.fx.push({ id: ++G.fxSeq, turn: G.turnNumber, who, text, ...(fx || {}) });
  if (G.fx.length > LOG_LIMIT) G.fx.shift();
}

function drawCards(G, playerID, n) {
  const p = G.players[playerID];
  for (let i = 0; i < n; i++) {
    if (p.deck.length === 0) {
      p.deckOut = true;
      return;
    }
    p.hand.push(p.deck.shift());
  }
}

function damage(G, playerID, amount) {
  const p = G.players[playerID];
  p.lp = Math.max(0, p.lp - amount);
}

// 送墓（不触发任何「被破坏」效果）。
// 祭品、代价这类「主动送墓」必须走这里 —— 它们不是"被破坏"，
// 误用 destroyMonster 会让 destroyBurn 之类效果在不该触发时触发。
function sendToGrave(G, playerID, slotIdx) {
  const p = G.players[playerID];
  if (p.field[slotIdx]) {
    p.graveyard.push(p.field[slotIdx].card);
    p.field[slotIdx] = null;
  }
}

// 破坏场上的怪兽：送墓 + 触发「被破坏时」效果（destroyBurn 等）。
// 返回被破坏的卡 id（无怪兽时返回 null），供日志与演出使用。
function destroyMonster(G, playerID, slotIdx, ctx) {
  const p = G.players[playerID];
  const entry = p.field[slotIdx];
  if (!entry) return null;
  const cardId = entry.card;
  p.graveyard.push(cardId);
  p.field[slotIdx] = null;
  // 被破坏 → 触发效果（链深由调用方通过 ctx.__chain 传递，超限即停）
  triggerOnDestroy(G, playerID, cardId, ctx);
  return cardId;
}

// 触发「被破坏送墓」类效果：destroyBurn 给对方（被破坏者的对手）伤害。
// 效果可能连锁（burn 不造成破坏，故 v1 实际只有一层），仍走链深保护。
function triggerOnDestroy(G, ownerId, cardId, ctx) {
  const depth = (ctx && ctx.__chain) || 0;
  if (depth >= MAX_CHAIN_DEPTH) {
    say(G, null, '效果连锁过深，已停止结算。');
    return;
  }
  const { burn } = onDestroyTriggers(cardId);
  if (!burn) return;
  const victimId = opponentOf(ownerId);
  damage(G, victimId, burn);
  say(G, ownerId, `${CARDS[cardId].cn} 被破坏，效果给与对手 ${burn} 点伤害。`, {
    kind: 'effect', card: cardId, effect: 'destroyBurn', dmg: burn, dir: ownerId,
  });
}

// 触发「召唤成功」类效果：summonDraw 抽牌。
// summonedFrom: 'hand' | 'grave' | 'spell'（死者苏生等）
function triggerOnSummon(G, playerID, cardId, summonedFrom) {
  const { draws } = onSummonTriggers(cardId, summonedFrom);
  if (!draws) return;
  drawCards(G, playerID, draws);
  const p = G.players[playerID];
  say(G, playerID, `${CARDS[cardId].cn} 召唤成功，效果抽 ${draws} 张牌。`, {
    kind: 'effect', card: cardId, effect: 'summonDraw', draw: draws,
  });
  if (p.deckOut) say(G, playerID, '卡组已空，无法抽牌。');
}

// 祭品自动选择：优先送走场上攻击力最低的怪兽，让新手不用做这个决策。
function pickTributes(p, count) {
  const occupied = p.field
    .map((entry, idx) => ({ idx, entry }))
    .filter((s) => s.entry);
  occupied.sort(
    (a, b) => CARDS[a.entry.card].atk - CARDS[b.entry.card].atk
  );
  return occupied.slice(0, count).map((s) => s.idx);
}

function firstEmptySlot(p) {
  return p.field.findIndex((s) => s === null);
}

function firstEmptySpellTrapSlot(p) {
  return (p.spellTrapZone ?? []).findIndex((slot) => slot === null);
}

function highestAtkSlot(p) {
  let best = -1;
  let bestAtk = -1;
  p.field.forEach((entry, i) => {
    if (entry && CARDS[entry.card].atk > bestAtk) {
      bestAtk = CARDS[entry.card].atk;
      best = i;
    }
  });
  return best;
}

export const DestinyDuel = {
  name: 'destiny-duel',
  setup: ({ random }) => {
    const G = {
      players: { 0: makePlayer(), 1: makePlayer() },
      step: 'main',
      turnNumber: 0,
      log: [],
      fx: [],
      fxSeq: 0,
    };
    for (const id of ['0', '1']) {
      G.players[id].deck = buildRandomDeck(random);
      drawCards(G, id, START_HAND);
    }
    say(G, null, '决斗开始：双方 4000 生命、起手 5 张，本局卡组从卡池随机抽得。');
    return G;
  },

  // 每回合开始（只在服务端运行）：抽 1 张、重置回合内标记。
  turn: {
    // 随机先后手：开局时用种子化 RNG 洗牌决定先发位置（0 或 1）。
    // 客户端/服务端/回放结果完全一致；每局新 matchID = 新种子 = 新的一手。
    order: {
      first: ({ random }) => random.Shuffle([0, 1])[0],
      // next 与框架 DEFAULT 一致：随机只决定先发，之后仍按 0→1→0 轮流
      next: ({ ctx }) => (ctx.playOrderPos + 1) % ctx.playOrder.length,
    },
    onBegin: ({ G, ctx }) => {
      const p = G.players[ctx.currentPlayer];
      G.turnNumber = ctx.turn;
      G.step = 'main';
      p.normalSummons = 0;
      p.specialSummonUsed = false;
      for (const entry of p.field) {
        if (entry) entry.attacked = false;
      }
      drawCards(G, ctx.currentPlayer, 1);
      if (p.deckOut) {
        say(G, ctx.currentPlayer, '卡组已空，无法抽牌。');
      } else {
        say(G, ctx.currentPlayer, '回合开始，抽 1 张牌。');
      }
    },
    onEnd: ({ G, ctx }) => {
      for (const ownerId of ['0', '1']) {
        const owner = G.players[ownerId];
        const zone = owner.spellTrapZone ?? [];
        owner.spellTrapZone = zone.map((entry) => {
          if (!entry || entry.expiresAfterPlayer !== ctx.currentPlayer) return entry;
          owner.graveyard.push(entry.card);
          say(G, ownerId, CARDS[entry.card].cn + ' 的效果结束，送入墓地。', {
            kind: 'spell-expire', card: entry.card,
          });
          return null;
        });
      }
    },
  },

  moves: {
    // ---- 主要阶段 ----

    // 通常召唤。祭品数量由卡的等级决定，祭品自动选场上最弱的怪兽。
    // pos 决定表示形式：'attack' 攻击表示 / 'defense' 守备表示。
    summon: ({ G, ctx, playerID }, handIdx, slotIdx, pos = 'attack') => {
      if (G.step !== 'main') return INVALID_MOVE;
      if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
      const p = G.players[playerID];
      if (p.normalSummons >= MAX_NORMAL_SUMMONS) return INVALID_MOVE;
      if (!Number.isInteger(handIdx) || handIdx < 0 || handIdx >= p.hand.length) {
        return INVALID_MOVE;
      }
      if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= FIELD_SLOTS) {
        return INVALID_MOVE;
      }

      const cardId = p.hand[handIdx];
      const card = CARDS[cardId];
      if (!card || card.type !== 'monster') return INVALID_MOVE;

      const need = tributesNeeded(card.level);
      const onField = p.field.filter(Boolean).length;
      if (onField < need) return INVALID_MOVE;

      // 先选祭品，再判断目标槽位是否可用（允许放进刚腾出的槽位）。
      const tributeSlots = need > 0 ? pickTributes(p, need) : [];
      const destOk = p.field[slotIdx] === null || tributeSlots.includes(slotIdx);
      if (!destOk) return INVALID_MOVE;

      const tributed = tributeSlots.map((i) => CARDS[p.field[i].card].cn);
      for (const slot of tributeSlots) sendToGrave(G, playerID, slot);

      p.hand.splice(handIdx, 1);
      p.field[slotIdx] = { card: cardId, attacked: false, pos };
      p.normalSummons += 1;

      const mode = pos === 'defense' ? '守备表示' : '攻击表示';
      const lead = tributed.length > 0
        ? `献祭 ${tributed.join('、')}，召唤 ${card.cn}（${mode}）。`
        : `召唤 ${card.cn}（${mode}，攻 ${card.atk} / 防 ${card.def}）。`;
      say(G, playerID, lead, {
        kind: 'summon', card: cardId, tributes: tributed.length, pos,
      });
      // 召唤成功 → 触发召唤类效果（summonDraw 等）
      triggerOnSummon(G, playerID, cardId, 'hand');
    },

    // 改变表示形式。规则（用户 2026-03 选定，贴近原作）：
    //   · 不消耗通常召唤；
    //   · 每只怪兽每回合只能改 1 次。
    // 实现上用 entry.posTurn 记住「这只怪兽在哪一回合改过」，而不是加布尔标志：
    // 标志位要在 summon / specialSummon / graveSummon / 死者苏生 每条建场路径
    // 都初始化，漏一处就变成「永远能改」；记回合号则不需要建场路径配合。
    changePosition: ({ G, ctx, playerID }, slotIdx) => {
      if (G.step !== 'main') return INVALID_MOVE;
      if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
      const p = G.players[playerID];
      if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= FIELD_SLOTS) {
        return INVALID_MOVE;
      }
      const entry = p.field[slotIdx];
      if (!entry) return INVALID_MOVE;
      if (entry.posTurn === ctx.turn) return INVALID_MOVE; // 本回合已经改过
      const next = entry.pos === 'defense' ? 'attack' : 'defense';
      entry.pos = next;
      entry.posTurn = ctx.turn;
      const cn = CARDS[entry.card].cn;
      const mode = next === 'defense' ? '守备表示' : '攻击表示';
      say(G, playerID, `改变表示形式：${cn} 变为${mode}。`, {
        kind: 'position', card: entry.card, pos: next,
      });
    },

    // 特殊召唤 v1（简化规则，不按单卡模拟精确文本）：
    // 每回合 1 次（specialSummonUsed 标志），两个来源共用配额：
    //   1) specialSummon：把 canSpecialSummon 标记的手牌怪召唤到场上。
    //      代价：场上无空位时送 1 只己方最低攻怪兽入墓（复用祭品逻辑），
    //      有空位则免费。不消耗通常召唤名额。
    //   2) graveSummon：把自己墓地里的 canSpecialSummon 怪复活到空槽，
    //      代价：手牌最左侧 1 张送墓（需有手牌）。
    specialSummon: ({ G, ctx, playerID }, handIdx, pos = 'attack') => {
      if (G.step !== 'main') return INVALID_MOVE;
      if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
      const p = G.players[playerID];
      if (p.specialSummonUsed) return INVALID_MOVE;
      if (!Number.isInteger(handIdx) || handIdx < 0 || handIdx >= p.hand.length) {
        return INVALID_MOVE;
      }
      if (!['attack', 'defense'].includes(pos)) return INVALID_MOVE;
      const cardId = p.hand[handIdx];
      const card = CARDS[cardId];
      if (!card || card.type !== 'monster' || !card.canSpecialSummon) {
        return INVALID_MOVE; // 无特召标记的卡（经典卡/普通文本）不能走这条路
      }

      const empty = p.field.indexOf(null);
      // 场满时靠"送最低攻入墓"腾出槽位；场上无怪（不可能场满）时无代价
      const tributeSlot = empty === -1 ? pickTributes(p, 1)[0] : null;
      if (empty === -1 && tributeSlot === undefined) return INVALID_MOVE;
      const destSlot = empty !== -1 ? empty : tributeSlot;
      const tributeName = tributeSlot !== null
        ? CARDS[p.field[tributeSlot].card].cn
        : '';

      p.hand.splice(handIdx, 1);
      if (tributeSlot !== null) sendToGrave(G, playerID, tributeSlot);
      p.field[destSlot] = { card: cardId, attacked: false, pos };
      p.specialSummonUsed = true;

      const mode = pos === 'defense' ? '守备表示' : '攻击表示';
      say(G, playerID, tributeName
        ? `特殊召唤：送 ${tributeName} 入墓，从手牌特殊召唤 ${card.cn}（${mode}）。`
        : `特殊召唤：从手牌特殊召唤 ${card.cn}（${mode}）。`,
        { kind: 'summon', card: cardId, pos, special: true, cost: tributeName || null });
      // 特殊召唤成功 → 触发召唤类效果（来源是手牌）
      triggerOnSummon(G, playerID, cardId, 'hand');
    },

    graveSummon: ({ G, ctx, playerID }, graveIdx, pos = 'attack') => {
      if (G.step !== 'main') return INVALID_MOVE;
      if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
      const p = G.players[playerID];
      if (p.specialSummonUsed) return INVALID_MOVE; // 与手牌特召共用每回合 1 次
      if (!Number.isInteger(graveIdx) || graveIdx < 0 || graveIdx >= p.graveyard.length) {
        return INVALID_MOVE;
      }
      if (!['attack', 'defense'].includes(pos)) return INVALID_MOVE;
      const cardId = p.graveyard[graveIdx];
      const card = CARDS[cardId];
      if (!card || card.type !== 'monster' || !card.canSpecialSummon) {
        return INVALID_MOVE;
      }
      if (p.hand.length === 0) return INVALID_MOVE; // 代价：1 张手牌
      const empty = p.field.indexOf(null);
      if (empty === -1) return INVALID_MOVE;

      p.graveyard.splice(graveIdx, 1);
      const costCard = p.hand.shift();
      p.graveyard.push(costCard);
      p.field[empty] = { card: cardId, attacked: false, pos };
      p.specialSummonUsed = true;

      const mode = pos === 'defense' ? '守备表示' : '攻击表示';
      say(G, playerID,
        `特殊召唤：手牌的 ${CARDS[costCard].cn} 送入墓地，从墓地复活 ${card.cn}（${mode}）。`,
        { kind: 'summon', card: cardId, pos, special: true, cost: CARDS[costCard].cn });
      // 从墓地复活 → 触发「从墓地的特殊召唤成功时」类效果（summonDraw）
      triggerOnSummon(G, playerID, cardId, 'grave');
    },
    // 发动魔法。client:false —— 抽牌会摸到隐藏卡组，禁止客户端乐观执行。
    castSpell: {
      move: ({ G, ctx, playerID }, handIdx) => {
        if (G.step !== 'main') return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        const p = G.players[playerID];
        const oppId = opponentOf(playerID);
        const opp = G.players[oppId];
        if (!Number.isInteger(handIdx) || handIdx < 0 || handIdx >= p.hand.length) {
          return INVALID_MOVE;
        }

        const cardId = p.hand[handIdx];
        const card = CARDS[cardId];
        if (!card || !['spell', 'trap'].includes(card.type)) return INVALID_MOVE;

        const persistsOnField = card.persistence === 'until-opponent-turn-ends';
        const zoneSlot = persistsOnField ? firstEmptySpellTrapSlot(p) : -1;
        if (persistsOnField && zoneSlot === -1) return INVALID_MOVE;

        switch (card.effect) {
          case 'draw2':
            drawCards(G, playerID, 2);
            say(G, playerID, '发动贪杯之瓶，抽 2 张牌。', {
              kind: 'spell', card: cardId, effect: 'draw2',
            });
            break;

          case 'draw3':
            drawCards(G, playerID, 3);
            say(G, playerID, '发动恩惠的抽卡，抽 3 张牌。', {
              kind: 'spell', card: cardId, effect: 'draw3',
            });
            break;

          case 'destroyStrongest': {
            const slot = highestAtkSlot(opp);
            if (slot === -1) return INVALID_MOVE; // 对方场上没有怪兽
            const victim = CARDS[opp.field[slot].card].cn;
            const victimId = opp.field[slot].card;
            destroyMonster(G, oppId, slot);
            say(G, playerID, `发动银河旋风，破坏 ${victim}。`, {
              kind: 'spell', card: cardId, effect: 'destroy', victim: victimId,
            });
            break;
          }

          case 'reborn': {
            const slot = firstEmptySlot(p);
            if (slot === -1) return INVALID_MOVE; // 场上没空位
            const gi = p.graveyard.findIndex(
              (id) => CARDS[id].type === 'monster'
            );
            if (gi === -1) return INVALID_MOVE; // 墓地里没有怪兽
            const revived = p.graveyard.splice(gi, 1)[0];
            p.field[slot] = { card: revived, attacked: false, pos: 'attack' };
            say(G, playerID, `发动死者苏生，特殊召唤 ${CARDS[revived].cn}。`, {
              kind: 'spell', card: cardId, effect: 'reborn', victim: revived,
            });
            // 死者苏生也是「从墓地的特殊召唤」→ 同样触发 summonDraw
            triggerOnSummon(G, playerID, revived, 'grave');
            break;
          }

          case 'lockdown':
            opp.lockedUntil = ctx.turn + 2;
            say(G, playerID, '发动光之护封剑，对手下个回合无法攻击。', {
              kind: 'spell', card: cardId, effect: 'lockdown',
            });
            break;

          default:
            return INVALID_MOVE;
        }

        p.hand.splice(handIdx, 1);
        if (persistsOnField) {
          p.spellTrapZone[zoneSlot] = {
            card: cardId,
            expiresAfterPlayer: oppId,
          };
        } else {
          p.graveyard.push(cardId);
        }
      },
      client: false,
    },

    // 进入战斗阶段。光の护封剑生效时禁止进入。
    toBattle: ({ G, ctx, playerID }) => {
      if (G.step !== 'main') return INVALID_MOVE;
      if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
      const p = G.players[playerID];
      if (ctx.turn < p.lockedUntil) return INVALID_MOVE;
      G.step = 'battle';
      say(G, playerID, '进入战斗阶段。');
    },

    // ---- 战斗阶段 ----
    // 伤害公式沿用原作：攻击力 > 对方攻击力时，伤害 = 攻击力 - 防御力。
    // targetSlot 为 null 表示直接攻击（对方场上无怪兽时才允许）。
    attack: ({ G, ctx, playerID }, attackerSlot, targetSlot) => {
      if (G.step !== 'battle') return INVALID_MOVE;
      if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
      const p = G.players[playerID];
      const oppId = opponentOf(playerID);
      const opp = G.players[oppId];

      if (!Number.isInteger(attackerSlot) || attackerSlot < 0 || attackerSlot >= FIELD_SLOTS) {
        return INVALID_MOVE;
      }
      if (p.firstTurn) return INVALID_MOVE; // 首回合不能发起任何攻击（原作首回合限制加强版）
      const attacker = p.field[attackerSlot];
      if (!attacker || attacker.attacked) return INVALID_MOVE;
      // 守备表示的怪兽不能发起攻击
      if (attacker.pos === 'defense') return INVALID_MOVE;
      const a = CARDS[attacker.card];
      const oppHasMonster = opp.field.some(Boolean);
      // 直击效果：带 directAttack 的怪兽无视对方怪兽，可直接打玩家
      const directByEffect = canDirectAttack(attacker.card);

      // 直接攻击
      if (targetSlot === null || targetSlot === undefined) {
        // 对方有怪兽时，只有带「直击」效果的怪兽才能直接攻击玩家
        if (oppHasMonster && !directByEffect) return INVALID_MOVE;
        attacker.attacked = true;
        const dmg = a.atk;
        damage(G, oppId, dmg);
        say(G, playerID,
          directByEffect && oppHasMonster
            ? `${a.cn}（直击效果）越过对方怪兽直接攻击，造成 ${dmg} 伤害。`
            : `${a.cn} 直接攻击，造成 ${dmg} 伤害。`,
          {
            kind: 'attack', attacker: attacker.card, target: null,
            outcome: 'direct', dmg, dir: playerID, direct: directByEffect || undefined,
          });
        return;
      }

      if (!Number.isInteger(targetSlot) || targetSlot < 0 || targetSlot >= FIELD_SLOTS) {
        return INVALID_MOVE;
      }
      const defender = opp.field[targetSlot];
      if (!defender) return INVALID_MOVE;
      const d = CARDS[defender.card];
      const dMode = defender.pos === 'defense' ? '（守备表示）' : '';

      attacker.attacked = true;

      // 战斗结算交给 effects.resolveBattle（纯函数）：
      // 它统一处理 battleBoost 加攻、pierce 穿透、battleProtect 免破坏，
      // 并保持原有「守备被破不扣血」规则（pierce 是唯一例外）。
      // 注意：p.ctx 传给破坏流程用于链深统计。
      const result = resolveBattle({
        attackerCardId: attacker.card,
        defenderCardId: defender.card,
        defenderPos: defender.pos,
      });
      if (!result) return INVALID_MOVE;

      // 1) 破坏判定（免疫时保留）
      if (result.breakDefender) destroyMonster(G, oppId, targetSlot);
      if (result.breakAttacker) destroyMonster(G, playerID, attackerSlot);

      // 2) 伤害结算
      if (result.damageToDefender > 0) damage(G, oppId, result.damageToDefender);
      if (result.damageToAttacker > 0) damage(G, playerID, result.damageToAttacker);

      // 3) 演出文案：把效果参与的部分讲清楚，避免玩家觉得"数值不对"
      const boostNote = result.atk !== a.atk ? `（战斗中攻击力 ${a.atk}→${result.atk}）` : '';
      const pierceNote = result.pierced ? '（贯通）' : '';
      const protectNote = result.protectedByEffect ? '（战斗破坏免疫，未被破坏）' : '';

      if (result.outcome === 'win') {
        say(G, playerID,
          result.protectedByEffect
            ? `${a.cn}${boostNote} 攻击 ${d.cn}${dMode}，造成 ${result.damageToDefender} 伤害，但对方${protectNote}。`
            : `${a.cn}${boostNote} 攻击 ${d.cn}，破坏并造成 ${result.damageToDefender} 伤害。`,
          {
            kind: 'attack', attacker: attacker.card, target: defender.card,
            outcome: 'win', dmg: result.damageToDefender, dir: playerID,
            protected: result.protectedByEffect || undefined,
            boost: result.atk !== a.atk ? result.atk : undefined,
            pierced: result.pierced || undefined,
          });
      } else if (result.outcome === 'wall') {
        say(G, playerID,
          result.pierced
            ? `${a.cn}${boostNote} 贯通攻击 ${d.cn}${dMode}，破坏并造成 ${result.damageToDefender} 伤害${pierceNote}。`
            : `${a.cn} 攻击 ${d.cn}（守备表示），破壁无伤害。`,
          {
            kind: 'attack', attacker: attacker.card, target: defender.card,
            outcome: 'wall', dmg: result.damageToDefender, dir: playerID,
            pierced: result.pierced || undefined,
          });
      } else if (result.outcome === 'lose') {
        say(G, playerID,
          `${a.cn}${boostNote} 攻击 ${d.cn}${dMode} 失败被反杀，受到 ${result.damageToAttacker} 伤害。`,
          {
            kind: 'attack', attacker: attacker.card, target: defender.card,
            outcome: 'lose', dmg: result.damageToAttacker, dir: playerID,
            boost: result.atk !== a.atk ? result.atk : undefined,
          });
      } else {
        say(G, playerID,
          result.protectedByEffect
            ? `${a.cn}${boostNote} 与 ${d.cn}${dMode} 同归于尽；对方${protectNote}。`
            : `${a.cn}${boostNote} 与 ${d.cn}${dMode} 同归于尽。`,
          {
            kind: 'attack', attacker: attacker.card, target: defender.card,
            outcome: 'draw', dmg: 0, dir: playerID,
            protected: result.protectedByEffect || undefined,
            boost: result.atk !== a.atk ? result.atk : undefined,
          });
      }
    },

    endTurn: ({ G, ctx, playerID, events }) => {
      if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
      G.players[playerID].firstTurn = false;
      events.endTurn();
    },
  },

  // 胜负判定：生命值归零 或 卡组抽干者输。每步操作后框架都会检查。
  endIf: ({ G }) => {
    const p0 = G.players['0'];
    const p1 = G.players['1'];
    const loses = (p) => p.lp <= 0 || p.deckOut;
    if (loses(p0) && loses(p1)) return { winner: null, reason: 'both-lose' };
    if (loses(p1)) return { winner: '0', reason: p1.deckOut ? 'deck-out' : 'life' };
    if (loses(p0)) return { winner: '1', reason: p0.deckOut ? 'deck-out' : 'life' };
  },

  // 秘密状态：双方手牌互相隐藏（对方只显示牌背），卡组内容全部隐藏。
  playerView: ({ G, playerID }) => {
    const hide = (arr) => arr.map(() => null);
    const players = {};
    for (const id of ['0', '1']) {
      const p = G.players[id];
      players[id] = {
        ...p,
        hand: id === playerID ? p.hand : hide(p.hand),
        deck: hide(p.deck),
      };
    }
    return { ...G, players };
  },
};

export default DestinyDuel;
