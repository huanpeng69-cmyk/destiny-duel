// 决斗棋盘。
//
// 交互设计（依据 boardgame-io skill 的 UI 可玩性清单）：
// - 全部一键操作：点手牌直接召唤/发动，不做"先选中再点目标"的两步流程
// - 每个被拒绝的操作都在状态行给出文字理由。INVALID_MOVE 是静默的，
//   新手点了没反应会以为游戏坏了。
// - 所有可交互元素在所有状态下都挂着 handler（空槽位也要能点）
// - 可点击卡牌禁用 hover transform，避免元素在指针下"躲牌"
// - 棋盘内不做游戏逻辑判断，合法性一律问 hints.js

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { CARDS, ATTRIBUTES, cardArt, START_LP } from './cards.js';
import {
  planSummon,
  spellBlocked,
  attackOptions,
  toBattleBlocked,
  changePositionBlocked,
} from './hints.js';
import { specialSummonPlan, graveSummonPlan } from './hints.js';
import { EFFECT_LABELS, canDirectAttack } from './effects.js';
import { sfx, ensureUnlocked } from './sfx.js';
import {
  attackSequence,
  bannerSequence,
  turnTransition,
  translateTo,
  shouldAnimate,
  scheduleFrames,
  ATTACK_DURATION,
  BANNER_MS,
} from './fx.js';
import Tutorial from './tutorial.jsx';
import { shouldShowTutorial, markTutorialSeen, buildTutorialState } from './tutorial.js';

const opponentOf = (id) => (id === '0' ? '1' : '0');

// 演出层：在真实 DOM 里按「卡面 id」反查它挂在哪个槽位。
// 引擎的 fx 事件只带卡面 id（attacker / target / victim），不带槽位号，
// 而动画必须知道「哪一格要飞出去」。data-card 属性由 CardFace 写入。
// 取不到（卡已被破坏、jsdom 无布局）就返回 null，调用方跳过动画。
function findSlotKey(root, role, ev, playerID) {
  if (!root || typeof root.querySelectorAll !== 'function') return null;
  const cardId =
    role === 'attacker' ? ev.attacker : role === 'defender' ? ev.target : ev.victim;
  if (!cardId) return null;
  // 事件发起方决定「我方/对方」视角：ev.who 是发起事件的玩家。
  const side = ev.who === playerID ? 'my' : 'foe';
  // 攻击方在自己这边，守方/受害者在对面场地。
  const wanted = role === 'attacker' ? side : side === 'my' ? 'foe' : 'my';
  const nodes = root.querySelectorAll(`[data-slot^="${wanted}-"] [data-card="${cardId}"]`);
  if (!nodes || nodes.length === 0) return null;
  const slot = nodes[0].closest?.('[data-slot]');
  return slot ? slot.getAttribute('data-slot') : null;
}

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
      // data-card 是演出层的反查锚点：fx 事件只给卡面 id，
      // 动画要靠它找到「这张卡现在挂在哪个槽位」。
      data-card={cardId}
      style={{ '--attr': attr.color, '--edge': attr.edge }}
    >
      <div className="card-name">{card.cn}</div>
      {/* 怪兽效果角标：让玩家一眼看出这张卡带效果（文本见悬停详情） */}
      {card.monsterEffect && (
        <span className={`card-effect eff-${card.monsterEffect}`}>
          {EFFECT_LABELS[card.monsterEffect] || '效果'}
        </span>
      )}
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

// ---- 悬停/聚焦时的卡牌详情（跟随鼠标） ----
// 纯展示层（pointer-events: none），移出卡牌/失焦即消失，不拦截点击。
// 内容来源：CARDS[cardId]（cards.js 的卡库），desc 为效果文本、cn 为中文名。
// 坐标：由触发点上报的鼠标视口坐标 x/y；向右下偏移，越界时自动翻转。
const INSPECT_OFFSET = 16; // 鼠标到浮层边缘的偏移（px）
const INSPECT_MARGIN = 8; // 与视口边缘的最小间距（px）
const INSPECT_MAX_W = 320;
const INSPECT_EST_H = 150; // 预估高度，仅用于判断下方是否放得下

function CardInspect({ cardId, x, y }) {
  const card = CARDS[cardId];
  if (!card) return null;
  const attr = ATTRIBUTES[card.attribute] || ATTRIBUTES.EARTH;
  const isSpell = ['spell', 'trap'].includes(card.type);

  // 默认放在鼠标右下方；右侧/下方空间不足时翻转到左/上侧
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;

  let left = x + INSPECT_OFFSET;
  if (left + INSPECT_MAX_W + INSPECT_MARGIN > vw) {
    left = Math.max(INSPECT_MARGIN, x - INSPECT_OFFSET - INSPECT_MAX_W);
  }

  let top = y + INSPECT_OFFSET;
  if (top + INSPECT_EST_H + INSPECT_MARGIN > vh) {
    top = Math.max(INSPECT_MARGIN, y - INSPECT_OFFSET - INSPECT_EST_H);
  }

  return (
    <div
      className="card-inspect"
      role="tooltip"
      style={{ left: `${left}px`, top: `${top}px`, '--attr': attr.color, '--edge': attr.edge }}
    >
      <div className="card-inspect-head">
        <span className="card-inspect-name">{card.cn}</span>
        <span className="card-inspect-type">{isSpell ? (card.type === 'trap' ? '陷阱' : '魔法') : '怪兽'}</span>
      </div>
      <div className="card-inspect-meta">
        <span className="card-inspect-attr">{attr.glyph} {attr.label}</span>
        {isSpell ? (
          <span>{card.desc ? '效果卡' : '通常魔法'}</span>
        ) : (
          <>
            <span>{card.level ?? '—'} 星</span>
            <span>攻 {card.atk}</span>
            <span>防 {card.def}</span>
          </>
        )}
      </div>
      <p className="card-inspect-text">{card.desc || '暂无效果说明。'}</p>
    </div>
  );
}

// fxClass：演出层临时挂上去的类名（fx-lunge / fx-hit / fx-break），
// 由 board 按帧序列写入，动画结束后自动清空。卡片渲染逻辑本身不变。
function Slot({ entry, side, index = 0, onClick, highlight, onInspect, onInspectMove, fxClass = '' }) {
  const clickable = Boolean(onClick);
  return (
    <button
      type="button"
      // data-slot 是演出层的测量锚点：board 用它定位「哪一张卡要冲向哪一张」，
      // 纯呈现属性，不参与任何游戏判定。
      data-slot={`${side}-${index}`}
      className={[
        'slot',
        `slot-${side}`,
        entry ? 'has-card' : '',
        clickable ? 'is-clickable' : '',
        highlight ? 'is-target' : '',
        fxClass,
      ]
        .join(' ')
        .trim()}
      onClick={clickable ? onClick : undefined}
      aria-disabled={!clickable}
      onMouseEnter={entry && onInspect ? (e) => onInspect(entry.card, e) : undefined}
      onMouseMove={entry && onInspectMove ? (e) => onInspectMove(entry.card, e) : undefined}
      onMouseLeave={entry && onInspect ? () => onInspect(null) : undefined}
      onFocus={entry && onInspect ? (e) => onInspect(entry.card, e) : undefined}
      onBlur={entry && onInspect ? () => onInspect(null) : undefined}
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

// hit：命中瞬间由演出层置为 true，血条闪红一下，让「掉血」和「被打中」
// 在同一帧发生（原来是先飘字、血条滞后改宽度，读起来像两件事）。
function LifeBar({ label, lp, side, float, hit = false }) {
  const pct = Math.max(0, Math.min(100, (lp / START_LP) * 100));
  return (
    <div className={`life life-${side} ${hit ? 'is-hit' : ''}`}>
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
      ev.outcome === 'direct' || ev.outcome === 'win' || ev.outcome === 'wall'
        ? 'is-win'
        : ev.outcome === 'lose'
          ? 'is-lose'
          : 'is-draw';
    const verdict =
      ev.outcome === 'direct'
        ? ev.direct
          ? `直击 -${ev.dmg}（无视对方怪兽）`
          : `直接攻击 -${ev.dmg}`
        : ev.outcome === 'wall'
          ? ev.pierced
            ? `贯通破壁 -${ev.dmg}`
            : '破壁（守备表示怪兽被破坏不造成伤害）'
          : ev.outcome === 'win'
            ? ev.protected
              ? `造成 -${ev.dmg}（对方免疫破坏）`
              : `破坏 -${ev.dmg}`
            : ev.outcome === 'lose'
              ? `被反杀 -${ev.dmg}`
              : '同归于尽';
    // 战斗强化（battleBoost）生效时，在结果旁标出实际攻击力，让数值可解释
    const boostNote = ev.boost ? ` · 攻 ${ev.boost}` : '';
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
        <div className={`stage-outcome ${tone}`}>{verdict}{boostNote}</div>
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
  // 等待选择表示形式的召唤：{ handIdx, slot, name, tributes, mode? }
  // mode === 'special' 时走特殊召唤（不占通常召唤名额）
  const [pendingSummon, setPendingSummon] = useState(null);
  // 等待选择表示形式的墓地复活：{ graveIdx, name }
  const [pendingGrave, setPendingGrave] = useState(null);
  // 悬停查看的卡牌与鼠标坐标：{ id, x, y } | null
  const [inspect, setInspect] = useState(null);
  const [popup, setPopup] = useState(null);
  const [dmgFloat, setDmgFloat] = useState({ '0': 0, '1': 0 });
  const [shake, setShake] = useState(false);
  // 首次进入对局弹一次新手指引；版本号变化后会再弹一次（见 tutorial.js）。
  const [tutorialOpen, setTutorialOpen] = useState(() => shouldShowTutorial());
  const closeTutorial = useCallback(() => {
    // 读完或跳过都算「看过」，避免每次刷新都弹；写失败（隐私模式）不影响关窗。
    markTutorialSeen();
    setTutorialOpen(false);
  }, []);

  // 指引要判断「玩家做到哪一步了」（点过手牌？进战斗阶段了吗？），
  // 判定逻辑放在 tutorial.js 的纯函数里，这里只负责把棋盘状态喂进去。
  const tutorialState = useMemo(
    () => buildTutorialState({ me, foe, myTurn, isActive, step: G.step, turn: ctx.turn, pendingSummon }),
    [me, foe, myTurn, isActive, G.step, ctx.turn, pendingSummon]
  );

  // 悬停查看：鼠标事件里取坐标，键盘聚焦时取元素中心
  const showInspectAt = useCallback((cardId, clientX, clientY) => {
    if (!cardId) return;
    setInspect({ id: cardId, x: clientX, y: clientY });
  }, []);
  const showInspect = useCallback((cardId, event) => {
    if (!cardId) return;
    if (event && typeof event.clientX === 'number') {
      showInspectAt(cardId, event.clientX, event.clientY);
      return;
    }
    // 键盘聚焦（无鼠标坐标）：定位到聚焦元素中心
    const rect = event?.currentTarget?.getBoundingClientRect?.();
    if (rect) showInspectAt(cardId, rect.right, rect.top + rect.height / 2);
    else showInspectAt(cardId, 0, 0);
  }, [showInspectAt]);
  const hideInspect = useCallback(() => setInspect(null), []);
  // 鼠标在卡牌内移动时同步浮层位置
  const trackInspect = useCallback((cardId, event) => {
    if (!cardId || !event) return;
    showInspectAt(cardId, event.clientX, event.clientY);
  }, [showInspectAt]);

  const lastFxId = useRef(0);
  const prevLp = useRef({ '0': me.lp, '1': foe.lp });
  const popupTimer = useRef(null);
  // 演出层的临时状态：哪几张卡在飞/受击/碎裂，谁的回合转场在放。
  // 这些只是 CSS 类名，不参与任何游戏判定。
  const [fxSlots, setFxSlots] = useState({}); // { 'my-0': 'fx-lunge', ... }
  const [lifeHit, setLifeHit] = useState({}); // { '0': true } 血条闪红
  const [turnFx, setTurnFx] = useState(null); // { dir, key }
  const cancelFx = useRef(null); // 当前演出的取消器
  const overSfxDone = useRef(-1); // 终局音效记账（见 ctx.gameover 分支）
  const boardRef = useRef(null); // 测量容器

  const say = useCallback((text) => setMsg(text), []);
  const deny = useCallback((reason) => {
    setMsg(reason);
    sfx.deny();
  }, []);

  // 量取某张卡在屏幕上的真实位置。槽位带了 data-slot="${side}-${index}"，
  // 找不到（卡已被破坏、元素未挂载）就返回 null，调用方跳过动画。
  const rectOf = useCallback((key) => {
    const root = boardRef.current;
    if (!root || !key) return null;
    const el = root.querySelector(`[data-slot="${key}"]`);
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, []);

  // 槽位 key：事件里的 who 是事件类别（attacker/defender），
  // 具体落在哪个槽位要靠引擎在事件里传的 dir 与当前视角换算。
  const slotKeyFor = useCallback(
    (who) => {
      if (!currentFx.current) return null;
      const ev = currentFx.current;
      const side = ev.who === playerID ? 'my' : 'foe';
      if (who === 'attacker') return `${side}-${ev.attackerSlot}`;
      if (who === 'defender') return `${side === 'my' ? 'foe' : 'my'}-${ev.targetSlot}`;
      return null;
    },
    [playerID]
  );
  // 当前正在演的事件：帧回调里要读「最新一次事件」，用 ref 持有。
  const currentFx = useRef(null);
  // 播放一段帧序列：每帧只改 CSS 类名与音效，绝不改游戏状态。
  // 新演出开始前先取消旧演出，避免连续攻击时两套动画打架。
  const playFrames = useCallback((frames, onFrame) => {
    if (cancelFx.current) cancelFx.current();
    cancelFx.current = scheduleFrames(frames, onFrame);
  }, []);

  useEffect(() => () => {
    if (cancelFx.current) cancelFx.current();
    if (popupTimer.current) clearTimeout(popupTimer.current);
  }, []);

  // ---- 演出事件：只演对手的动作与双方的攻击，我方出牌零弹窗 ----
  useEffect(() => {
    const list = G.fx || [];
    const fresh = list.filter((e) => e.id > lastFxId.current);
    if (fresh.length === 0) return;
    lastFxId.current = fresh[fresh.length - 1].id;
    const ev = fresh[fresh.length - 1];
    const mine = ev.who === playerID;

    // 最新事件直接替换当前画面，任何时刻最多一个弹窗（铁律：绝不排队逐个弹出）
    const showStage = (e, ms = 1500) => {
      setPopup(e);
      if (popupTimer.current) clearTimeout(popupTimer.current);
      popupTimer.current = setTimeout(() => setPopup(null), ms);
    };

    // 用户在设置里关掉演出（或系统要求减少动态）：退回改动前的最小行为。
    if (!shouldAnimate()) {
      if (ev.kind === 'summon') {
        sfx.summon();
        if (!mine) showStage(ev);
      } else if (ev.kind === 'spell') {
        sfx.spell();
        if (!mine) showStage(ev);
      } else if (ev.kind === 'effect') {
        if (ev.effect === 'destroyBurn') sfx.hit();
        else if (ev.effect === 'summonDraw') sfx.draw();
        else sfx.spell();
        showStage(ev);
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
      return;
    }

    if (ev.kind === 'attack') {
      currentFx.current = ev;
      // 攻守双方在哪个槽位：引擎事件里没带槽位，用当前视角 + 事件里的
      // attacker/defender 卡面反查 DOM 上的槽位，取不到就跳过冲撞动画。
      const attackerKey = findSlotKey(boardRef.current, 'attacker', ev, playerID);
      const defenderKey =
        ev.target != null ? findSlotKey(boardRef.current, 'defender', ev, playerID) : null;
      const from = rectOf(attackerKey);
      // 直接攻击没有守方卡，就让攻击方冲向对方血条
      const to = defenderKey
        ? rectOf(defenderKey)
        : rectOf(playerID === '0' ? 'foe-panel' : 'my-panel');
      const move = translateTo(from, to);

      const frames = attackSequence(ev);
      // 弹窗比演出多留 600ms：先看完「卡飞过去、对面炸了」，再读「破坏 -1200」。
      showStage(ev, ATTACK_DURATION + 600);
      playFrames(frames, (frame) => {
        if (frame.kind === 'lunge') {
          sfx.attack();
          if (move) {
            setFxSlots({ [attackerKey]: 'fx-lunge' });
            // CSS 变量承载位移量：--fx-dx / --fx-dy / --fx-scale
            const el = boardRef.current?.querySelector(`[data-slot="${attackerKey}"]`);
            if (el) {
              el.style.setProperty('--fx-dx', `${move.dx}px`);
              el.style.setProperty('--fx-dy', `${move.dy}px`);
              el.style.setProperty('--fx-scale', String(move.scale));
            }
          }
        } else if (frame.kind === 'impact') {
          const victimId = ev.who === playerID ? opponentOf(playerID) : playerID;
          setFxSlots((prev) => {
            const next = { ...prev };
            if (defenderKey) next[defenderKey] = 'fx-hit';
            next[attackerKey] = 'fx-lunge fx-done';
            return next;
          });
          if (frame.dmg > 0) {
            sfx.hit();
            setLifeHit((prev) => ({ ...prev, [victimId]: true }));
            setTimeout(() => setLifeHit((prev) => ({ ...prev, [victimId]: false })), 520);
            if (frame.dmg >= 1500) {
              setShake(true);
              setTimeout(() => setShake(false), 320);
            }
          } else {
            // 破壁没扣血也要有「打中了」的手感
            sfx.hit();
          }
        } else if (frame.kind === 'effect') {
          // 效果专属演出：直击砸对方血条，其余叠在交战那张卡上。
          // 用 key 区分「卡上的特效」与「血条上的特效」——
          // 同毫秒可能同时有 fx-hit / fx-break / fx-eff-*，必须追加不能覆盖。
          const targetKey = frame.who === 'panel' ? null : defenderKey;
          setFxSlots((prev) => {
            const next = { ...prev };
            const key = targetKey || attackerKey;
            const cur = next[key] || '';
            const cls = `fx-eff-${frame.visual}`;
            next[key] = cur.includes(cls) ? cur : `${cur} ${cls}`.trim();
            return next;
          });
          if (frame.who === 'panel') {
            // 直击：血条同样闪红（与命中帧可能重合，重复设 true 无害）
            const victimId = ev.who === playerID ? opponentOf(playerID) : playerID;
            setLifeHit((prev) => ({ ...prev, [victimId]: true }));
            setTimeout(() => setLifeHit((prev) => ({ ...prev, [victimId]: false })), 520);
          }
        } else if (frame.kind === 'break') {
          const key = frame.who === 'defender' ? defenderKey : attackerKey;
          const exists = boardRef.current?.querySelector(`[data-slot="${key}"] .card`);
          // 免疫破坏时卡还在场上：这时候不该演碎裂
          if (key && exists) {
            sfx.destroy();
            // 追加而不是覆盖：break 与 impact 是同一毫秒的两帧，
            // 整体覆盖会把刚挂上的 fx-hit 冲掉，受击抖动根本看不见
            // （实测时间线里 foe-1 只有 fx-break，fx-hit 从未出现）。
            setFxSlots((prev) => {
              const cur = prev[key] || '';
              const next = cur.includes('fx-break') ? cur : `${cur} fx-break`.trim();
              return { ...prev, [key]: next };
            });
          }
        } else if (frame.kind === 'retreat') {
          setFxSlots((prev) => {
            const next = { ...prev };
            if (next[attackerKey] === 'fx-lunge fx-done') next[attackerKey] = '';
            return next;
          });
        } else if (frame.kind === 'settle') {
          setFxSlots({});
          currentFx.current = null;
          // 注意：这里不关弹窗。演出负责「动」，弹窗负责「说结果」，
          // 两者时长不同步 —— 曾在 settle 里 setPopup(null)，导致「破坏 -1200」
          // 这类关键结果与演出同帧消失、玩家根本来不及读。
          // 弹窗由 showStage 自己的计时器管（比演出多留 600ms）。
          // 清掉内联的 CSS 变量，免得下一场用旧的位移
          for (const key of [attackerKey, defenderKey]) {
            const el = boardRef.current?.querySelector(`[data-slot="${key}"]`);
            if (el) {
              el.style.removeProperty('--fx-dx');
              el.style.removeProperty('--fx-dy');
              el.style.removeProperty('--fx-scale');
            }
          }
        }
      });
      return;
    }

    // 召唤 / 魔法 / 怪兽效果：弹窗 + 对应特效帧
    if (ev.kind === 'summon') {
      sfx.summon();
      if (!mine) showStage(ev, BANNER_MS);
      return;
    }
    if (ev.kind === 'spell') sfx.spell();
    else if (ev.kind === 'effect') {
      if (ev.effect === 'destroyBurn') sfx.hit();
      else if (ev.effect === 'summonDraw') sfx.draw();
      else sfx.spell();
    }

    const frames = bannerSequence(ev);
    showStage(ev, BANNER_MS);
    playFrames(frames, (frame) => {
      if (frame.kind === 'break') {
        const key = findSlotKey(boardRef.current, 'victim', ev, playerID);
        if (key && boardRef.current?.querySelector(`[data-slot="${key}"] .card`)) {
          setFxSlots((prev) => ({ ...prev, [key]: 'fx-break' }));
        }
      } else if (frame.kind === 'effect') {
        // 灼烧：橙红火花打在对方身上，同时血条闪红。
        // 抽牌：卡组方向飞入的视觉挂在施术者一侧（这里用版面锚点）。
        const key = findSlotKey(boardRef.current, 'victim', ev, playerID) || null;
        if (key) {
          setFxSlots((prev) => {
            const cur = prev[key] || '';
            const cls = `fx-eff-${frame.visual}`;
            return { ...prev, [key]: cur.includes(cls) ? cur : `${cur} ${cls}`.trim() };
          });
        }
        if (frame.effect === 'destroyBurn' && frame.dmg > 0) {
          const victimId = ev.who === playerID ? opponentOf(playerID) : playerID;
          setLifeHit((prev) => ({ ...prev, [victimId]: true }));
          setTimeout(() => setLifeHit((prev) => ({ ...prev, [victimId]: false })), 520);
        }
      } else if (frame.kind === 'settle') {
        setFxSlots({});
        // 同样不关弹窗：由 showStage 的计时器管，否则结果跟动画一起消失。
      }
    });
  }, [G.fx, playerID, playFrames, rectOf]);

  // ---- 回合转场：轮到谁，从哪一侧扫光进来 ----
  const prevTurn = useRef(ctx.turn);
  useEffect(() => {
    if (ctx.turn === prevTurn.current) return;
    prevTurn.current = ctx.turn;
    if (!shouldAnimate()) return;
    sfx.turn();
    const t = turnTransition({ myTurn: ctx.currentPlayer === playerID });
    setTurnFx({ dir: t.dir, key: ctx.turn });
    const timer = setTimeout(() => setTurnFx(null), t.duration);
    return () => clearTimeout(timer);
  }, [ctx.turn, ctx.currentPlayer, playerID]);


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
    if (plan.ok) {
      // 先问表示形式：这是真实的决策，两步比猜更清楚
      setPendingSummon({ handIdx: idx, slot: plan.slot, name: card.cn, tributes: plan.tributes.length });
      say(`选择 ${card.cn} 的表示形式。`);
      return;
    }
    // 通常召唤走不通时，带特召标记的卡给一条特殊召唤路（不占通常召唤名额）
    if (card.canSpecialSummon) {
      const sp = specialSummonPlan(me, cardId);
      if (sp.ok) {
        setPendingSummon({ handIdx: idx, slot: sp.slot, name: card.cn, tributes: sp.tributeSlots.length, mode: 'special' });
        say(`${card.cn} 现在不能通常召唤，可以特殊召唤。选择表示形式。`);
        return;
      }
      deny(sp.reason);
      return;
    }
    deny(plan.reason);
  };

  // 墓地复活：点在墓地里的可特召怪兽 -> 选表示形式（代价 1 张手牌）
  const onGraveClick = (i) => {
    ensureUnlocked();
    if (!isActive || ctx.gameover || G.step !== 'main') return;
    const cardId = me.graveyard[i];
    const plan = graveSummonPlan(me, cardId);
    if (!plan.ok) {
      deny(plan.reason);
      return;
    }
    sfx.click();
    setPendingGrave({ graveIdx: i, name: CARDS[cardId].cn });
    say(`选择 ${CARDS[cardId].cn} 复活的表示形式。`);
  };

  const confirmGraveSummon = (pos) => {
    if (!pendingGrave) return;
    const { graveIdx, name } = pendingGrave;
    setPendingGrave(null);
    sfx.click();
    moves.graveSummon(graveIdx, pos);
    say(`以${pos === 'defense' ? '守备' : '攻击'}表示从墓地复活 ${name}。`);
  };

  const confirmSummon = (pos) => {
    if (!pendingSummon) return;
    const { handIdx, slot, name, mode } = pendingSummon;
    setPendingSummon(null);
    sfx.click();
    if (mode === 'special') {
      moves.specialSummon(handIdx, pos);
      say(`以${pos === 'defense' ? '守备' : '攻击'}表示特殊召唤 ${name}。`);
      return;
    }
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
    const name = CARDS[me.field[slot].card].cn;
    // 对方空场：点自己的怪兽就是直接攻击。
    // 对方有怪且这只带直击：先选中，让玩家选择打怪或打玩家。
    if (opts.canDirect && opts.targets.length === 0) {
      moves.attack(slot, null);
      say(`${name} 直接攻击，伤害 ${CARDS[me.field[slot].card].atk}。`);
      return;
    }
    setSelectedAtk((prev) => (prev === slot ? null : slot));
    say(
      selectedAtk === slot
        ? '已取消选择。'
        : opts.directByEffect
          ? `已选中 ${name}。点对手怪兽攻击，或点「直接攻击」打玩家。`
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

  // 主要阶段点自己的怪兽 = 改变表示形式（不占通常召唤，每只怪兽每回合 1 次）
  const onMySlotMainClick = (slot) => {
    ensureUnlocked();
    if (!isActive || ctx.gameover) return;
    if (!me.field[slot]) {
      deny('这个槽位没有怪兽。');
      return;
    }
    const blocked = changePositionBlocked(me, slot, ctx.turn);
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
    // 胜/败音效只放一次。这个分支会提前 return、挂不了 effect，
    // 所以用 ref 按回合号记账（boardgame.io 换局不重挂组件，必须自己防重复）。
    if (overSfxDone.current !== ctx.turn) {
      overSfxDone.current = ctx.turn;
      if (draw) sfx.deny();
      else if (iWon) sfx.win();
      else sfx.lose();
    }
    const reasonText =
      ctx.gameover.reason === 'deck-out'
        ? '对手卡组抽干，无牌可抽'
        : ctx.gameover.reason === 'both-lose'
          ? '双方同时落败'
          : '生命值归零';
    return (
      <div className={`board is-over ${shouldAnimate() ? 'fx-on' : ''}`}>
        {/* 终局压暗：整块战场慢慢沉下去，胜/败大字砸入（CSS 见 .over）*/}
        <div className={`over ${draw ? 'is-draw' : iWon ? 'is-win' : 'is-lose'}`}>
          <div className="over-title">{draw ? '平局' : iWon ? '胜利' : '败北'}</div>
          <div className="over-reason">{reasonText}</div>
        </div>
      </div>
    );
  }

  const effectDirectReady = me.field.some(
    (e) => e && !e.attacked && e.pos !== 'defense' && canDirectAttack(e.card)
  );
  const canDirect =
    myTurn &&
    G.step === 'battle' &&
    !me.firstTurn &&
    (foe.field.every((e) => !e) || effectDirectReady);

  // 演出层：给每个槽位算出稳定的 key，把 fxSlots 里的类名分发给对应槽位。
  // 这里只读自己维护的呈现状态，不碰 me/foe 的数据。
  const fxClassFor = (side, index) => fxSlots[`${side}-${index}`] || '';
  const meHit = Boolean(lifeHit[playerID]);
  const foeHit = Boolean(lifeHit[foeId]);

  return (
    <div
      ref={boardRef}
      className={['board', shake ? 'is-shake' : '', turnFx ? `is-turn turn-${turnFx.dir}` : '']
        .join(' ')
        .trim()}
      onPointerDown={ensureUnlocked}
    >
      {/* 回合转场：一层扫光 + 回合字，纯装饰，pointer-events: none */}
      {turnFx && (
        <div className="turn-sweep" key={turnFx.key} aria-hidden="true">
          <span className="turn-sweep-label">{myTurn ? '你的回合' : '对手回合'}</span>
        </div>
      )}
      {/* 对手 */}
      <div className="pane" data-slot="foe-panel">
        <LifeBar
          label="对手 · 暗之决斗者"
          lp={foe.lp}
          side="foe"
          float={dmgFloat[foeId]}
          hit={foeHit}
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
            index={i}
            entry={entry}
            side="foe"
            fxClass={fxClassFor('foe', i)}
            highlight={selectedAtk !== null}
            onClick={selectedAtk !== null ? () => onFoeSlotClick(i) : undefined}
            onInspect={showInspect}
            onInspectMove={trackInspect}
          />
        ))}
      </div>

      <SpellTrapRow entries={foe.spellTrapZone ?? []} side="foe" />

      <div className="statusbar">
        <span className={`phase ${myTurn ? 'is-mine' : ''}`}>
          {myTurn ? '你的回合' : '对手回合'} ·{' '}
          {G.step === 'main' ? '主要阶段' : '战斗阶段'}
          {myTurn && me.firstTurn ? ' · 首回合不能攻击' : ''}
        </span>
        <span className="status-msg">{msg}</span>
        {/* 直击提示：只有带直击效果的怪兽能越过对方怪兽打玩家。
            卡池里直击怪稀少（40 张牌组平均约 2 张），不提示玩家根本不知道要点谁。 */}
        {myTurn &&
          G.step === 'battle' &&
          !me.firstTurn &&
          foe.field.some(Boolean) &&
          me.field.some((e) => e && canDirectAttack(e.card)) && (
            <span className="status-hint">有怪兽带「直击」效果：点它 → 点「直接攻击」打玩家</span>
          )}
        {/* 改表示形式提示：主要阶段点自己的怪兽可在攻击⇄守备间切换。
            该入口藏在"点场上怪兽"里，不提示玩家根本发现不了（jsdom 实测）。
            现在不占通常召唤，所以只在真还有怪兽没改过时才提示。 */}
        {myTurn &&
          isActive &&
          G.step === 'main' &&
          me.field.some((e) => e && e.posTurn !== ctx.turn) && (
            <span className="status-hint">点自己的怪兽可改变攻击⇄守备表示（每只怪兽每回合 1 次）</span>
          )}

        {/* 指引重开入口：首次会自动弹出，之后想再看只能从这里进。 */}
        <button
          type="button"
          className="status-help"
          onClick={() => setTutorialOpen(true)}
          aria-label="查看玩法指引"
        >
          玩法
        </button>
      </div>

      {pendingSummon && (
        <div className="summon-choice" role="dialog" aria-label="选择表示形式">
          <div className="summon-choice-copy">
            <strong>
              {pendingSummon.mode === 'special' ? `特殊召唤 ${pendingSummon.name}` : `选择 ${pendingSummon.name} 的表示形式`}
            </strong>
            <span>
              {pendingSummon.mode === 'special'
                ? pendingSummon.tributes > 0
                  ? '没有空位：将自动送 1 只最低攻怪兽入墓腾位。'
                  : '有空位，无需祭品。'
                : pendingSummon.tributes > 0
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
            index={i}
            entry={entry}
            side="my"
            fxClass={fxClassFor('my', i)}
            highlight={selectedAtk === i}
            onClick={
              isActive && G.step === 'battle'
                ? () => onMySlotClick(i)
                : isActive && G.step === 'main'
                  ? () => onMySlotMainClick(i)
                  : undefined
            }
            onInspect={showInspect}
            onInspectMove={trackInspect}
          />
        ))}
      </div>

      <SpellTrapRow entries={me.spellTrapZone ?? []} side="me" />

      <div className="pane" data-slot="my-panel">
        <LifeBar label="你 · 光之决斗者" lp={me.lp} side="me" float={dmgFloat[playerID]} hit={meHit} />
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
              const foeEmpty = foe.field.every((e) => !e);
              const selectedOk =
                selectedAtk !== null &&
                me.field[selectedAtk] &&
                !me.field[selectedAtk].attacked &&
                (foeEmpty || canDirectAttack(me.field[selectedAtk].card));
              const ready = selectedOk
                ? selectedAtk
                : me.field.findIndex(
                    (e) =>
                      e &&
                      !e.attacked &&
                      e.pos !== 'defense' &&
                      (foeEmpty || canDirectAttack(e.card))
                  );
              if (ready < 0) return;
              const name = CARDS[me.field[ready].card].cn;
              const atk = CARDS[me.field[ready].card].atk;
              setSelectedAtk(null);
              moves.attack(ready, null);
              say(`${name} 直接攻击，伤害 ${atk}。`);
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
            className={['hand-card', !isActive || G.step !== 'main' ? 'is-locked' : ''].join(' ').trim()}
            onClick={() => onHandClick(i)}
            aria-disabled={!isActive || G.step !== 'main'}
            onMouseEnter={(e) => showInspect(cardId, e)}
            onMouseMove={(e) => trackInspect(cardId, e)}
            onMouseLeave={hideInspect}
            onFocus={(e) => showInspect(cardId, e)}
            onBlur={hideInspect}
          >
            <CardFace cardId={cardId} size="md" />
          </button>
        ))}
      </div>

      {pendingGrave && (
        <div className="summon-choice" role="dialog" aria-label="选择复活表示形式">
          <div className="summon-choice-copy">
            <strong>从墓地复活 {pendingGrave.name}</strong>
            <span>代价：手牌最左侧 1 张送墓（本回合特殊召唤配额 −1）。</span>
          </div>
          <div className="summon-choice-actions">
            <button type="button" className="stance-btn attack" onClick={() => confirmGraveSummon('attack')}>
              ⚔ 攻击表示
              <small>正面朝上 · 可以攻击</small>
            </button>
            <button type="button" className="stance-btn defense" onClick={() => confirmGraveSummon('defense')}>
              🛡 守备表示
              <small>横置 · 不能攻击</small>
            </button>
            <button type="button" className="stance-cancel" onClick={() => setPendingGrave(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="graveyard-strip" aria-label="墓地（可复活）">
        <span className="graveyard-label">墓地·可复活</span>
        {me.graveyard
          .map((id, i) => ({ id, i, card: CARDS[id] }))
          .filter((x) => x.card?.canSpecialSummon)
          .map((x) => (
            <button
              key={x.i}
              type="button"
              className="grave-card"
              onClick={() => onGraveClick(x.i)}
              aria-disabled={!isActive || G.step !== 'main'}
              onMouseEnter={(e) => showInspect(x.id, e)}
              onMouseMove={(e) => trackInspect(x.id, e)}
              onMouseLeave={hideInspect}
              onFocus={(e) => showInspect(x.id, e)}
              onBlur={hideInspect}
            >
              <CardFace cardId={x.id} size="zone" />
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

      {inspect && <CardInspect cardId={inspect.id} x={inspect.x} y={inspect.y} />}

      {popup && (
        <div className="stage">
          <Stage ev={popup} playerID={playerID} />
        </div>
      )}

      {/* 新手指引：首次进入对局自动弹出（判定见 tutorial.js），读完/跳过都记「看过」。 */}
      {tutorialOpen && <Tutorial state={tutorialState} onFinish={closeTutorial} />}
    </div>
  );
}
