// 命运对决 —— 人机对战。
// 你执「光之决斗者」（玩家 0），AI 执「暗之决斗者」（玩家 1）。
//
// 注意：multiplayer: Local() 必须保留。它不是网络联机，而是让 AI 客户端
// 和人类客户端共享同一局游戏——去掉它 AI 对手就会消失（skill 记录的坑：
// 曾有人为了"修点击问题"删掉它，结果 AI 没了而点击问题依旧）。

import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Client } from 'boardgame.io/react';
import { Local } from 'boardgame.io/multiplayer';
import { DestinyDuel } from './game.js';
import Board from './board.jsx';
import { createBotClient } from './bot.js';
import { CARD_CATALOG, cardDescriptionForDisplay, cardNameForDisplay } from './cards.js';
import { setSfx, sfxEnabled, ensureUnlocked } from './sfx.js';
import './app.css';

// 页面加载时间戳：保证每次刷新都拿到全新的 matchID。
// 没有它，刷新页面会复用 'duel-0' 这一旧棋局，随机种子不变，
// 玩家会看到同样的卡组和同样的先手（AGENTS.md 踩坑记录）。
const LOAD_STAMP = Date.now().toString(36);

// 客户端与 AI 共享同一个 multiplayer 实例
const mp = Local();

const App = Client({
  game: DestinyDuel,
  board: Board,
  multiplayer: mp,
  debug: false, // 调试面板会浮在棋盘上方拦截点击
});

function CardLibrary({ onClose }) {
  const [cards, setCards] = useState(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    // 图鉴与中文卡库并行加载：中文数据按密码对齐，命中则补 zhName/zhDesc。
    Promise.all([
      fetch('/data/cards.catalog.json').then((r) => {
        if (!r.ok) throw new Error(`catalog ${r.status}`);
        return r.json();
      }),
      fetch('/data/zh-cards.json')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([payload, zh]) => {
        const map = zh?.cards || {};
        const merged = (payload.cards || []).map((card) => {
          const t = map[String(card.id)];
          return t
            ? { ...card, zhName: t.name || undefined, zhDesc: t.desc || undefined }
            : card;
        });
        setCards(merged);
      })
      .catch(() => setCards([]));
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = (cards || []).filter((card) => {
    const typeOk = kind === 'all' || card.type === kind;
    const textOk = !normalizedQuery ||
      `${cardNameForDisplay(card)} ${card.name} ${cardDescriptionForDisplay(card)} ${card.desc} ${card.race || ''}`
        .toLowerCase()
        .includes(normalizedQuery);
    return typeOk && textOk;
  });
  const visible = filtered.slice(0, 96);

  return (
    <div className="library-backdrop" role="dialog" aria-modal="true" aria-label="卡牌图鉴">
      <section className="library-panel">
        <div className="library-head">
          <div>
            <div className="library-kicker">YGOPRODECK CARD DATABASE</div>
            <h2>卡牌图鉴 <span>{CARD_CATALOG.length.toLocaleString()} 张</span></h2>
          </div>
          <button type="button" className="library-close" onClick={onClose}>关闭 ×</button>
        </div>

        <div className="library-tools">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索卡名、效果或种族…"
            aria-label="搜索卡牌"
          />
          <div className="library-filters">
            {[
              ['all', '全部'],
              ['monster', '怪兽'],
              ['spell', '魔法'],
              ['other', '陷阱 / 其他'],
            ].map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={kind === value ? 'is-on' : ''}
                onClick={() => setKind(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {cards === null ? (
          <div className="library-empty">正在载入完整卡库…</div>
        ) : cards.length === 0 ? (
          <div className="library-empty">卡库加载失败，请确认开发服务器正在运行。</div>
        ) : (
          <>
            <div className="library-result">显示 {visible.length} / {filtered.length} 张（最多展示 96 张）</div>
            <div className="library-grid">
              {visible.map((card) => (
                <button type="button" className="library-card" key={card.id} onClick={() => setSelected(card)}>
                  <img src={card.imageUrlSmall || ''} alt="" loading="lazy" />
                  <span>{cardNameForDisplay(card)}</span>
                  {card.zhName && card.name && card.name !== card.zhName && (
                    <small className="library-en">{card.name}</small>
                  )}
                  <small>{card.type === 'monster' ? `★${card.level} · 攻 ${card.atk}` : card.sourceType}</small>
                </button>
              ))}
            </div>
          </>
        )}

        {selected && (
          <div className="card-detail">
            <div className="card-detail-top">
              <strong>{cardNameForDisplay(selected)}</strong>
              {selected.zhName && selected.name && selected.name !== selected.zhName && (
                <span className="card-detail-en">{selected.name}</span>
              )}
              <button type="button" onClick={() => setSelected(null)}>收起</button>
            </div>
            <div className="card-detail-meta">
              {selected.sourceType} · {selected.attribute || '—'} · {selected.race || '—'}
              {selected.type === 'monster' && ` · 攻 ${selected.atk} / 防 ${selected.def}`}
            </div>
            <p>{cardDescriptionForDisplay(selected) || '暂无效果文本。'}</p>
            {selected.url && <a href={selected.url} target="_blank" rel="noreferrer">在 YGOPRODeck 查看原卡资料 ↗</a>}
          </div>
        )}
      </section>
    </div>
  );
}

function Page() {
  const [matchN, setMatchN] = useState(0);
  const [sndOn, setSndOn] = useState(sfxEnabled());
  const [musicOn, setMusicOn] = useState(true);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const musicRef = useRef(null);
  // 每局唯一 matchID：必须带页面加载时的时间戳。
  // Local() 在同一进程内按 matchID 缓存棋局——若只用 'duel-0'，
  // 刷新页面会命中旧棋局，seed 不变、先后手与卡组都固定，
  // 玩家看到的永远是同一局（AGENTS.md 踩坑记录）。
  const matchID = `duel-${matchN}-${LOAD_STAMP}`;

  useEffect(() => {
    const audio = musicRef.current;
    if (!audio) return;
    audio.volume = 0.24;
    if (musicOn) {
      audio.play().catch(() => {
        // 浏览器会拦截首次自动播放，首次点击页面时再尝试解锁。
      });
    } else {
      audio.pause();
    }
  }, [musicOn]);

  // 每局创建一个 AI 客户端；换局时停掉旧的
  useEffect(() => {
    const bot = createBotClient({
      game: DestinyDuel,
      multiplayer: mp,
      matchID,
      playerID: '1',
      delayMs: 1100, // 与演出时长匹配：看清一步再走下一步
    });
    return () => bot.stop();
  }, [matchID]);

  const toggleSnd = () => {
    const next = !sndOn;
    setSndOn(next);
    setSfx(next);
  };

  const unlockAudio = () => {
    ensureUnlocked();
    if (musicOn) musicRef.current?.play().catch(() => {});
  };

  return (
    <main onPointerDown={unlockAudio}>
      <audio ref={musicRef} src="/audio/destiny-duel.flac" loop preload="metadata" />
      <header className="hero-header">
        <div className="hero-kicker"><span className="kicker-line" /> BEGINNER DUEL PROTOCOL <span className="kicker-line" /></div>
        <h1><span className="title-mark">✦</span> 命运对决 <em>DESTINY DUEL</em></h1>
        <div className="hero-subline"><span /> 光之决斗者 <b>VS</b> 暗之决斗者 <span /></div>
      </header>
      <p className="sub">
        新手简化版 · 生命值 4000 · 起手 5 张 · 每回合抽 1 张 · 场上 5 个位置 ·
        每回合 1 次通常召唤（5-6 星需 1 祭品 / 7 星以上需 2 祭品） ·
        生命值归零或卡组抽干判负
      </p>
      <div className="toolbar">
        <button
          type="button"
          className="btn"
          onClick={() => setMatchN((n) => n + 1)}
        >
          重新开局
        </button>
        <button
          type="button"
          className={`toggle ${sndOn ? 'on' : ''}`}
          onClick={toggleSnd}
        >
          {sndOn ? '音效开' : '音效关'}
        </button>
        <button
          type="button"
          className={`toggle ${musicOn ? 'on' : ''}`}
          onClick={() => setMusicOn((on) => !on)}
        >
          {musicOn ? '背景音乐开' : '背景音乐关'}
        </button>
        <button type="button" className="toggle catalog-toggle" onClick={() => setLibraryOpen(true)}>
          卡牌图鉴 · {CARD_CATALOG.length.toLocaleString()}
        </button>
        <span className="toolbar-hint">对手为 AI，回合内自动行动，稍候片刻</span>
      </div>
      <App key={`p0-${matchN}`} matchID={matchID} playerID="0" debug={false} />
      {libraryOpen && <CardLibrary onClose={() => setLibraryOpen(false)} />}
      <div className="version-badge">
        v1 · 非官方 fan project · 卡牌数据来自 ygoprodeck.com，中文译名来自 ygocdb.com，卡面为 CSS 绘制
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Page />);
