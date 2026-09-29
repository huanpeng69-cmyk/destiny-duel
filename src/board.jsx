// 决斗棋盘。
//
// 交互设计（依据 boardgame-io skill 的 UI 可玩性清单）：
// - 全部一键操作：点手牌直接召唤/发动，不做"先选中再点目标"的两步流程
// - 每个被拒绝的操作都在状态行给出文字理由。INVALID_MOVE 是静默的，
//   新手点了没反应会以为游戏坏了。
// - 所有可交互元素在所有状态下都挂着 handler（空槽位也要能点）
// - 可点击卡牌禁用 hover transform，避免元素在指针下"躲牌"
// - 棋盘内不做游戏逻辑判断，合法性一律问 hints.js

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { CARDS, ATTRIBUTES, cardArt, START_LP } from './cards.js';
import {
  planSummon,
  spellBlocked,
  attackOptions,
  toBattleBlocked,
  changePositionBlocked,
} from './hints.js';
import { sfx, ensureUnlocked } from './sfx.js';

const opponentOf = (id) => (id === '0' ? '1' : '0');

// ---- 卡面 ----
// 图片可选：public/cards/<id>.jpg 存在就盖在 CSS 卡面上，不存在就露出
// CSS 卡面。onError 隐藏 img，因此缺图不影响任何功能。
function CardFace({ cardId, size = 'md' }) {
  const card = CARDS[cardId];
  if (!card) return null;
  const attr = ATTRIBUTES[card.attribute] || ATTRIBUTES.EARTH;
  const isSpell = ['spell', 'trap'].includes(card.type);

  return (
    <div
      className={`card card-${size} ${isSpell ? 'is-spell' : 'is-monster'}`}
      style={{ '--attr': attr.color, '--edge': attr.edge }}
    >
      <div className="card-name">{card.cn}</div>
      <div className="card-art">
        <span className="card-glyph">{attr.glyph}</span>
        <img
          className="card-img"
          src={cardArt(cardId)}
          alt=""
          draggable="false"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      </div>
      {isSpell ? (
        <div className="card-text">{card.desc}</div>
      ) : (
        <>
          <div className="card-stars">{'★'.repeat(card.level)}</div>
          <div className="card-stats">
            <span className="stat stat-atk">攻 {card.atk}</span>
            <span className="stat stat-def">防 {card.def}</span>
          </div>
        </>
      )}
    </div>
  );
}

function CardBack() {
  return <div className="card-back" aria-hidden="true" />;
}

// ---- 场上的一个槽位 ----
function Slot({ entry, side, onClick, highlight }) {
  const clickable = Boolean(onClick);
  return (
    <button
      type="button"
      className={['slot', `slot-${side}`, highlight ? 'is-target' : ''].join(' ')}
      onClick={onClick}
      disabled={!clickable}
    >
      {entry ? (
        <>
          <CardFace cardId={entry.card} size="sm" />
          <span className={`stance ${entry.pos === 'defense' ? 'is-defense' : 'is-attack'}`}>
            {entry.pos === 'defense' ? '守备' : '攻击'}
          </span>
          {entry.attacked && <span className="slot-flag">已攻击</span>}
        </>
      ) : (
        <span className="slot-empty">空</span>
      )}
    </button>
  );
}

// ---- 生命值条 ----
function SpellTrapRow({ entries, side }) {
  const label = side === 'foe' ? '对手魔法/陷阱区' : '我的魔法/陷阱区';
  return (
    <div className={'spell-trap-row spell-trap-' + side} aria-label={label}>
      <span className="spell-trap-label">{label}</span>
      <div className="spell-trap-slots">
        {entries.map((entry, i) => (
          <div className={'spell-trap-slot ' + (entry ? 'is-active' : '')} key={i}>
            {entry ? <CardFace cardId={entry.card} size="zone" /> : <span>空</span>}
            {entry && <small>效果生效中</small>}
          </div>
        ))}
      </div>
    </div>
  );
}

function LifeBar({ label, lp, side, float }) {
  const pct = Math.max(0, Math.min(100, (lp / START_LP) * 100));
  return (
    <div className={`life life-${side}`}>
      <div className="life-head">
        <span className="life-name">{label}</span>
        <span className="life-num">{lp}</span>
      </div>
      <div className="life-track">
        <div className="life-fill" style={{ width: `${pct}%` }} />
        {float > 0 && <span className="life-float">-{float}</span>}
      </div>
    </div>
  );
}

// ---- 战斗演出弹窗 ----
// 锚定棋盘容器而非视口：容器 position:relative + overflow:hidden，
// 弹窗 absolute 四边撑满 + flex 居中（skill 记录的定位做法）。
function Stage({ ev, playerID }) {
  const mine = ev.who === playerID;

  if (ev.kind === 'attack') {
    const tone =
      ev.outcome === 'direct' || ev.outcome === 'win'
        ? 'is-win'
        : ev.outcome === 'lose'
          ? 'is-lose'
          : 'is-draw';
    const verdict =
      ev.outcome === 'direct'
        ? `直接攻击 -${ev.dmg}`
        : ev.outcome === 'win'
          ? `破坏 -${ev.dmg}`
          : ev.outcome === 'lose'
            ? `被反杀 -${ev.dmg}`
            : '同归于尽';
    return (
      <div className="stage-inner">
        <div className="stage-duel">
          <div className="stage-side">
            <div className="stage-tag">{mine ? '我方' : '对手'}</div>
            <CardFace cardId={ev.attacker} size="sm" />
          </div>
          <div className="stage-vs">VS</div>
          <div className="stage-side">
            <div className="stage-tag">守方</div>
            {ev.target ? (
              <CardFace cardId={ev.target} size="sm" />
            ) : (
              <div className="card card-sm is-direct">
                <div className="card-name">直接攻击</div>
              </div>
            )}
          </div>
        </div>
        <div className={`stage-outcome ${tone}`}>{verdict}</div>
      </div>
    );
  }

  return (
    <div className="stage-inner">
      {ev.card && <CardFace cardId={ev.card} size="md" />}
      <div className="stage-banner">
        <b>{mine ? '我方' : '对手'}</b> · {ev.text}
      </div>
    </div>
  );
}

export default function Board({ G, ctx, moves, playerID, isActive }) {
  const me = G.players[playerID];
  const foeId = opponentOf(playerID);
  const foe = G.players[foeId];
  const myTurn = ctx.currentPlayer === playerID;

  const [msg, setMsg] = useState('点手牌召唤怪兽或发动魔法/陷阱。');
  const [selectedAtk, setSelectedAtk] = useState(null);
  // 等待选择表示形式的召唤：{ handIdx, slot }
  const [pendingSummon, setPendingSummon] = useState(null);
  const [popup, setPopup] = useState(null);
  const [dmgFloat, setDmgFloat] = useState({ '0': 0, '1': 0 });
  const [shake, setShake] = useState(false);

  const lastFxId = useRef(0);
  const prevLp = useRef({ '0': me.lp, '1': foe.lp });
  const popupTimer = useRef(null);

  const say = useCallback((text) => setMsg(text), []);
  const deny = useCallback((reason) => {
    setMsg(reason);
    sfx.deny();
  }, []);

  // ---- 演出事件：只演对手的动作与双方的攻击，我方出牌零弹窗 ----
  useEffect(() => {
    const list = G.fx || [];
    const fresh = list.filter((e) => e.id > lastFxId.current);
    if (fresh.length === 0) return;
    lastFxId.current = fresh[fresh.length - 1].id;
    const ev = fresh[fresh.length - 1];
    const mine = ev.who === playerID;

    // 最新事件直接替换当前画面，任何时刻最多一个弹窗（skill 铁律：
    // 绝不排队逐个弹出）
    const showStage = (e) => {
      setPopup(e);
      if (popupTimer.current) clearTimeout(popupTimer.current);
      popupTimer.current = setTimeout(() => setPopup(null), 1500);
    };

    if (ev.kind === 'summon') {
      sfx.summon();
      if (!mine) showStage(ev);
    } else if (ev.kind === 'spell') {
      sfx.spell();
      if (!mine) showStage(ev);
    } else if (ev.kind === 'attack') {
      sfx.attack();
      if (ev.dmg > 0) {
        sfx.hit();
        if (ev.dmg >= 1500) {
          setShake(true);
          setTimeout(() => setShake(false), 320);
        }
      }
      showStage(ev);
    }
  }, [G.fx, playerID]);

  useEffect(() => () => popupTimer.current && clearTimeout(popupTimer.current), []);

  // ---- 生命值飘字 ----
  useEffect(() => {
    const before = prevLp.current;
    let who = null;
    let amount = 0;
    for (const id of ['0', '1']) {
      const now = G.players[id].lp;
      if (now < before[id] && who === null) {
        who = id;
        amount = before[id] - now;
      }
      before[id] = now;
    }
    if (who === null) return;
    setDmgFloat((prev) => ({ ...prev, [who]: amount }));
    const t = setTimeout(() => setDmgFloat({ '0': 0, '1': 0 }), 1100);
    return () => clearTimeout(t);
  }, [G.players['0'].lp, G.players['1'].lp]);

  // 换回合时清掉选择态
  useEffect(() => {
    setSelectedAtk(null);
  }, [ctx.turn, ctx.currentPlayer]);

  // ---- 交互 ----

  const onHandClick = (idx) => {
    ensureUnlocked();
    if (!isActive || ctx.gameover) return;

    if (G.step !== 'main') {
      deny('战斗阶段不能召唤或发动魔法，点「结束回合」后再行动。');
      return;
    }
    const cardId = me.hand[idx];
    if (!cardId) return;
    const card = CARDS[cardId];

    if (['spell', 'trap'].includes(card.type)) {
      const blocked = spellBlocked(me, foe, cardId);
      if (blocked) {
        deny(blocked);
        return;
      }
      sfx.click();
      moves.castSpell(idx);
      say(`${card.cn} 发动成功。`);
      return;
    }

    const plan = planSummon(me, cardId);
    if (!plan.ok) {
      deny(plan.reason);
      return;
    }
    // 先问表示形式：这是真实的决策，两步比猜更清楚
    setPendingSummon({ handIdx: idx, slot: plan.slot, name: card.cn, tributes: plan.tributes.length });
    say(`选择 ${card.cn} 的表示形式。`);
  };

  const confirmSummon = (pos) => {
    if (!pendingSummon) return;
    const { handIdx, slot, name } = pendingSummon;
    setPendingSummon(null);
    sfx.click();
    moves.summon(handIdx, slot, pos);
    say(`以${pos === 'defense' ? '守备' : '攻击'}表示召唤 ${name} 到 ${slot + 1} 号位。`);
  };

  const onMySlotClick = (slot) => {
    ensureUnlocked();
    if (!isActive || ctx.gameover) return;
    if (G.step !== 'battle') {
      deny('还没进入战斗阶段，点「进入战斗阶段」。');
      return;
    }
    const opts = attackOptions(me, foe, slot);
    if (!opts.ok) {
      deny(opts.reason);
      return;
    }
    if (opts.canDirect) {
      const name = CARDS[me.field[slot].card].cn;
      const atk = CARDS[me.field[slot].card].atk;
      moves.attack(slot, null);
      say(`${name} 直接攻击，伤害 ${atk}。`);
      return;
    }
    setSelectedAtk((prev) => (prev === slot ? null : slot));
    say(
      selectedAtk === slot
        ? '已取消选择。'
        : `已选中 ${CARDS[me.field[slot].card].cn}，点对手的怪兽作为攻击目标。`
    );
  };

  const onFoeSlotClick = (slot) => {
    ensureUnlocked();
    if (selectedAtk === null) return;
    if (!isActive || G.step !== 'battle') return;
    if (!foe.field[slot]) {
      deny('这个槽位没有怪兽，不能作为攻击目标。');
      return;
    }
    moves.attack(selectedAtk, slot);
    setSelectedAtk(null);
  };

  const onToBattle = () => {
    ensureUnlocked();
    if (!isActive || G.step !== 'main') return;
    const blocked = toBattleBlocked(me, ctx);
    if (blocked) {
      deny(blocked);
      return;
    }
    sfx.click();
    moves.toBattle();
    say('进入战斗阶段：点自己的怪兽发起攻击。');
  };

  // 主要阶段点自己的怪兽 = 改变表示形式（消耗通常召唤）
  const onMySlotMainClick = (slot) => {
    ensureUnlocked();
    if (!isActive || ctx.gameover) return;
    if (!me.field[slot]) {
      deny('这个槽位没有怪兽。');
      return;
    }
    const blocked = changePositionBlocked(me, slot);
    if (blocked) {
      deny(blocked);
      return;
    }
    const next = me.field[slot].pos === 'defense' ? 'attack' : 'defense';
    sfx.click();
    moves.changePosition(slot);
    say(`${CARDS[me.field[slot].card].cn} 变为${next === 'defense' ? '守备' : '攻击'}表示。`);
  };

  const onEndTurn = () => {
    ensureUnlocked();
    if (!isActive) return;
    setSelectedAtk(null);
    moves.endTurn();
  };

  // 终局：禁止一切交互
  if (ctx.gameover) {
    const iWon = ctx.gameover.winner === playerID;
    const draw = ctx.gameover.winner === null;
    const reasonText =
      ctx.gameover.reason === 'deck-out'
        ? '对手卡组抽干，无牌可抽'
        : ctx.gameover.reason === 'both-lose'
          ? '双方同时落败'
          : '生命值归零';
    return (
      <div className="board">
        <div className={`over ${draw ? 'is-draw' : iWon ? 'is-win' : 'is-lose'}`}>
          <div className="over-title">{draw ? '平局' : iWon ? '胜利' : '败北'}</div>
          <div className="over-reason">{reasonText}</div>
        </div>
      </div>
    );
  }

  const canDirect = myTurn && G.step === 'battle' && !me.firstTurn && foe.field.every((e) => !e);

  return (
    <div className={`board ${shake ? 'is-shake' : ''}`} onPointerDown={ensureUnlocked}>
      {/* 对手 */}
      <div className="pane">
        <LifeBar
          label="对手 · 暗之决斗者"
          lp={foe.lp}
          side="foe"
          float={dmgFloat[foeId]}
        />
        <div className="counts">
          <span>卡组 {foe.deck.length}</span>
          <span>墓地 {foe.graveyard.length}</span>
        </div>
        <div className="foe-hand">
          {Array.from({ length: foe.hand.length }).map((_, i) => (
            <CardBack key={i} />
          ))}
        </div>
      </div>

      <div className="field foe-field">
        {foe.field.map((entry, i) => (
          <Slot
            key={i}
            entry={entry}
            side="foe"
            highlight={selectedAtk !== null}
            onClick={selectedAtk !== null ? () => onFoeSlotClick(i) : undefined}
          />
        ))}
      </div>

      <SpellTrapRow entries={foe.spellTrapZone ?? []} side="foe" />

      <div className="statusbar">
        <span className={`phase ${myTurn ? 'is-mine' : ''}`}>
          {myTurn ? '你的回合' : '对手回合'} ·{' '}
          {G.step === 'main' ? '主要阶段' : '战斗阶段'}
          {myTurn && me.firstTurn ? ' · 首回合不能直接攻击' : ''}
        </span>
        <span className="status-msg">{msg}</span>
      </div>

      {pendingSummon && (
        <div className="summon-choice" role="dialog" aria-label="选择表示形式">
          <div className="summon-choice-copy">
            <strong>选择 {pendingSummon.name} 的表示形式</strong>
            <span>
              {pendingSummon.tributes > 0
                ? `将自动献祭 ${pendingSummon.tributes} 只场上怪兽。`
                : '无需祭品，可以直接召唤。'}
            </span>
          </div>
          <div className="summon-choice-actions">
            <button type="button" className="stance-btn attack" onClick={() => confirmSummon('attack')}>
              ⚔ 攻击表示
              <small>正面朝上 · 可以攻击</small>
            </button>
            <button type="button" className="stance-btn defense" onClick={() => confirmSummon('defense')}>
              🛡 守备表示
              <small>横置 · 不能攻击</small>
            </button>
            <button type="button" className="stance-cancel" onClick={() => setPendingSummon(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="field my-field">
        {me.field.map((entry, i) => (
          <Slot
            key={i}
            entry={entry}
            side="me"
            highlight={selectedAtk === i}
            onClick={isActive && G.step === 'battle' ? () => onMySlotClick(i) : undefined}
          />
        ))}
      </div>

      <SpellTrapRow entries={me.spellTrapZone ?? []} side="me" />

      <div className="pane">
        <LifeBar label="你 · 光之决斗者" lp={me.lp} side="me" float={dmgFloat[playerID]} />
        <div className="counts">
          <span>卡组 {me.deck.length}</span>
          <span>墓地 {me.graveyard.length}</span>
        </div>
      </div>

      <div className="actions">
        {G.step === 'main' && (
          <button
            type="button"
            className="btn btn-battle"
            onClick={onToBattle}
            disabled={!isActive}
          >
            进入战斗阶段
          </button>
        )}
        {canDirect && (
          <button
            type="button"
            className="btn btn-direct"
            onClick={() => {
              const ready = me.field.findIndex((e) => e && !e.attacked);
              if (ready >= 0) onMySlotClick(ready);
            }}
          >
            直接攻击
          </button>
        )}
        <button
          type="button"
          className="btn btn-end"
          onClick={onEndTurn}
          disabled={!isActive}
        >
          {myTurn && me.firstTurn ? '出完牌，结束回合' : '结束回合'}
        </button>
      </div>

      <div className="my-hand">
        {me.hand.map((cardId, i) => (
          <button
            key={`${cardId}-${i}`}
            type="button"
            className="hand-card"
            onClick={() => onHandClick(i)}
            disabled={!isActive || G.step !== 'main'}
          >
            <CardFace cardId={cardId} size="md" />
          </button>
        ))}
      </div>

      <div className="logpanel">
        <div className="log-head">实时战报</div>
        <ol className="log-list">
          {[...(G.log || [])].reverse().map((e, i) => (
            <li
              key={i}
              className={
                e.who === playerID ? 'is-mine' : e.who ? 'is-foe' : 'is-sys'
              }
            >
              <span className="log-turn">T{e.turn}</span>
              <span className="log-text">{e.text}</span>
            </li>
          ))}
        </ol>
      </div>

      {popup && (
        <div className="stage">
          <Stage ev={popup} playerID={playerID} />
        </div>
      )}
    </div>
  );
}
