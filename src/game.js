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
  DECK_LIST,
  FIELD_SLOTS,
  START_LP,
  START_HAND,
  LOG_LIMIT,
  SPELL_TRAP_SLOTS,
  tributesNeeded,
} from './cards.js';

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
    normalSummonUsed: false,
    lockedUntil: 0, // 光的护封剑：此回合号之前不能进入战斗阶段
    deckOut: false,  // 抽牌时卡组为空 => 判负
    firstTurn: true, // 每位玩家各自的首次回合：不能直接攻击
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

function destroySlot(G, playerID, slotIdx) {
  const p = G.players[playerID];
  if (p.field[slotIdx]) {
    p.graveyard.push(p.field[slotIdx].card);
    p.field[slotIdx] = null;
  }
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
      G.players[id].deck = random.Shuffle([...DECK_LIST]);
      drawCards(G, id, START_HAND);
    }
    say(G, null, '决斗开始，双方各 4000 生命值，起手 5 张。');
    return G;
  },

  // 每回合开始（只在服务端运行）：抽 1 张、重置回合内标记。
  turn: {
    onBegin: ({ G, ctx }) => {
      const p = G.players[ctx.currentPlayer];
      G.turnNumber = ctx.turn;
      G.step = 'main';
      p.normalSummonUsed = false;
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
      if (p.normalSummonUsed) return INVALID_MOVE;
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
      for (const slot of tributeSlots) destroySlot(G, playerID, slot);

      p.hand.splice(handIdx, 1);
      p.field[slotIdx] = { card: cardId, attacked: false, pos };
      p.normalSummonUsed = true;

      const mode = pos === 'defense' ? '守备表示' : '攻击表示';
      const lead = tributed.length > 0
        ? `献祭 ${tributed.join('、')}，召唤 ${card.cn}（${mode}）。`
        : `召唤 ${card.cn}（${mode}，攻 ${card.atk} / 防 ${card.def}）。`;
      say(G, playerID, lead, {
        kind: 'summon', card: cardId, tributes: tributed.length, pos,
      });
    },

    // 改变表示形式。消耗本次通常召唤（原作规则）。
    // 简化版只允许改变场上已有怪兽的表示形式，且必须在主要阶段。
    changePosition: ({ G, ctx, playerID }, slotIdx) => {
      if (G.step !== 'main') return INVALID_MOVE;
      if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
      const p = G.players[playerID];
      if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= FIELD_SLOTS) {
        return INVALID_MOVE;
      }
      if (p.normalSummonUsed) return INVALID_MOVE;
      const entry = p.field[slotIdx];
      if (!entry) return INVALID_MOVE;
      const next = entry.pos === 'defense' ? 'attack' : 'defense';
      entry.pos = next;
      p.normalSummonUsed = true;
      const cn = CARDS[entry.card].cn;
      const mode = next === 'defense' ? '守备表示' : '攻击表示';
      say(G, playerID, `改变表示形式：${cn} 变为${mode}。`, {
        kind: 'position', card: entry.card, pos: next,
      });
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
            destroySlot(G, oppId, slot);
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
      const attacker = p.field[attackerSlot];
      if (!attacker || attacker.attacked) return INVALID_MOVE;
      // 守备表示的怪兽不能发起攻击
      if (attacker.pos === 'defense') return INVALID_MOVE;
      const a = CARDS[attacker.card];
      const oppHasMonster = opp.field.some(Boolean);

      // 直接攻击
      if (targetSlot === null || targetSlot === undefined) {
        if (oppHasMonster) return INVALID_MOVE; // 对方有怪兽时不能直接攻击
        if (p.firstTurn) return INVALID_MOVE; // 各玩家首次回合不能直接攻击
        attacker.attacked = true;
        damage(G, oppId, a.atk);
        say(G, playerID, `${a.cn} 直接攻击，造成 ${a.atk} 伤害。`, {
          kind: 'attack', attacker: attacker.card, target: null,
          outcome: 'direct', dmg: a.atk, dir: playerID,
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
      // 攻击表示用攻击力对攻击力，守备表示用攻击力对防守力。
      // 这是新手版最容易混淆的战斗计算，必须先确定守方本次使用的数值。
      const defenderPower = defender.pos === 'defense' ? d.def : d.atk;

      attacker.attacked = true;

      if (a.atk > defenderPower) {
        // 打破守方，伤害 = 我方攻击力 - 守方本次使用的数值。
        const dmg = Math.max(0, a.atk - defenderPower);
        destroySlot(G, oppId, targetSlot);
        damage(G, oppId, dmg);
        say(G, playerID, `${a.cn} 攻击 ${d.cn}${dMode}，破坏并造成 ${dmg} 伤害。`, {
          kind: 'attack', attacker: attacker.card, target: defender.card,
          outcome: 'win', dmg, dir: playerID,
        });
      } else if (a.atk < defenderPower) {
        // 攻击方被反杀，伤害 = 守方本次使用的数值 - 我方攻击力。
        const dmg = Math.max(0, defenderPower - a.atk);
        destroySlot(G, playerID, attackerSlot);
        damage(G, playerID, dmg);
        say(G, playerID, `${a.cn} 攻击 ${d.cn}${dMode} 失败被反杀，受到 ${dmg} 伤害。`, {
          kind: 'attack', attacker: attacker.card, target: defender.card,
          outcome: 'lose', dmg, dir: playerID,
        });
      } else {
        // 攻击力相同：同归于尽，双方无伤害
        destroySlot(G, oppId, targetSlot);
        destroySlot(G, playerID, attackerSlot);
        say(G, playerID, `${a.cn} 与 ${d.cn}${dMode} 同归于尽。`, {
          kind: 'attack', attacker: attacker.card, target: defender.card,
          outcome: 'draw', dmg: 0, dir: playerID,
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
