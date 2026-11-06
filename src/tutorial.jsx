import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { TUTORIAL_STEPS, placeBubble, stepActionLabel, stepHint } from './tutorial.js';

// 金圈向外多留一点边，不至于贴死控件的边框。
const SPOT_PAD = 6;
// 目标控件会因为游戏状态变化而移动（召唤弹窗出现/消失、按钮切换……），
// 没有 ResizeObserver 也要跟上，所以低频轮询 + 只在真的变了才重渲染。
const POLL_MS = 400;

function viewportSize() {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  return { width: window.innerWidth || 0, height: window.innerHeight || 0 };
}

// 只取第一个命中的元素：一步只讲一个控件，取并集会框住无关区域。
function measureSpot(selector) {
  if (typeof document === 'undefined' || !selector) return null;
  const node = document.querySelector(selector);
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  // jsdom / 隐藏元素拿不到布局，rect 全 0 —— 退回「没有金圈」的降级形态，指引照常可点。
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const viewportW = window.innerWidth || rect.width;
  const viewportH = window.innerHeight || rect.height;
  const left = Math.max(0, rect.left - SPOT_PAD);
  const top = Math.max(0, rect.top - SPOT_PAD);
  const right = Math.min(viewportW, rect.right + SPOT_PAD);
  const bottom = Math.min(viewportH, rect.bottom + SPOT_PAD);
  if (right <= left || bottom <= top) return null;
  return { top, left, width: right - left, height: bottom - top };
}

const sameRect = (a, b) =>
  Boolean(a && b) &&
  Math.abs(a.top - b.top) < 0.5 &&
  Math.abs(a.left - b.left) < 0.5 &&
  Math.abs(a.width - b.width) < 0.5 &&
  Math.abs(a.height - b.height) < 0.5;

// 暗底只在目标矩形处挖个洞做焦点，本身 pointer-events: none —— 点击照常穿透，
// 玩家可以一边看气泡一边点真实按钮（这是「能在现场直接打完一轮」的前提）。
// 不用「巨大 box-shadow」那招：.board 有 overflow: hidden，阴影会被裁掉。
function veilClip(spot) {
  if (!spot) return undefined;
  const { left: x1, top: y1, width, height } = spot;
  const x2 = x1 + width;
  const y2 = y1 + height;
  return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x1}px ${y1}px, ${x2}px ${y1}px, ${x2}px ${y2}px, ${x1}px ${y2}px, ${x1}px ${y1}px)`;
}

// 就地标注式新手指引：气泡贴在被说明的那个控件旁边，金圈框住控件。
// 「要不要弹」由 tutorial.js 的 shouldShowTutorial 决定，组件只管展示与推进。
export default function Tutorial({ state = {}, onFinish }) {
  const [index, setIndex] = useState(0);
  const step = TUTORIAL_STEPS[index];
  const isLast = index === TUTORIAL_STEPS.length - 1;
  const [spot, setSpot] = useState(null);
  const [bubbleSize, setBubbleSize] = useState(null);
  const [viewport, setViewport] = useState(viewportSize);
  const bubbleRef = useRef(null);
  const nextRef = useRef(null);
  // 记住「进入这一步的那一刻是否已经满足完成条件」：满足过就不再自动前进，
  // 否则中途打开指引（早就召唤完了）会被一路静默跳到底。
  const enteredRef = useRef(-1);
  const enteredDoneRef = useRef(false);

  // 跟随控件位置：窗口尺寸变化、滚动、控件因状态变化而出现/消失都要重新量。
  useEffect(() => {
    const update = () => {
      const nextViewport = viewportSize();
      setViewport((prev) => (sameRect({ ...prev, top: 0, left: 0 }, { ...nextViewport, top: 0, left: 0 }) ? prev : nextViewport));
      const nextSpot = measureSpot(step.target) || measureSpot(step.fallbackTarget);
      setSpot((prev) => (sameRect(prev, nextSpot) ? prev : nextSpot));
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const timer = typeof setInterval === 'function' ? setInterval(update, POLL_MS) : null;
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      if (timer) clearInterval(timer);
    };
  }, [step, state]);

  // 气泡大小随文案变化，量一次给定位算法用（只在真的变了才更新，避免抖动）。
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    setBubbleSize((prev) =>
      sameRect({ ...prev, top: 0, left: 0 }, { width: rect.width, height: rect.height, top: 0, left: 0 })
        ? prev
        : { width: rect.width, height: rect.height }
    );
  }, [index, state]);

  useEffect(() => {
    if (enteredRef.current === index) return;
    enteredRef.current = index;
    enteredDoneRef.current = Boolean(step.done && step.done(state));
  }, [index, step, state]);

  // 操作完成自动前进（只前进，不后退）：玩家点了手牌召唤，气泡就自己跳到下一步。
  useEffect(() => {
    if (enteredRef.current !== index) return;
    if (enteredDoneRef.current) return;
    if (step.done && step.done(state)) {
      setIndex((i) => Math.min(TUTORIAL_STEPS.length - 1, i + 1));
    }
  }, [state, index, step]);

  useEffect(() => {
    nextRef.current?.focus?.();
  }, [index]);

  // Esc 等同于「跳过」，符合弹窗习惯。
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onFinish();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onFinish]);

  const goPrev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(() => {
    if (isLast) {
      onFinish();
      return;
    }
    setIndex((i) => Math.min(TUTORIAL_STEPS.length - 1, i + 1));
  }, [isLast, onFinish]);

  const pos = placeBubble(spot, bubbleSize, step.anchor, viewport);
  const hint = stepHint(step, state) || step.hint || null;
  const bubbleStyle = pos
    ? { top: `${pos.top}px`, left: `${pos.left}px`, '--arrow': `${pos.arrow.offset}px` }
    : { bottom: '24px', left: '50%', transform: 'translateX(-50%)', '--arrow': '50%' };

  const tree = (
    <div className="tutorial" data-step={step.id}>
      <div className="tutorial-veil" style={{ clipPath: veilClip(spot) }} aria-hidden="true" />
      {spot && (
        <div
          className="tutorial-ring"
          aria-hidden="true"
          style={{ top: `${spot.top}px`, left: `${spot.left}px`, width: `${spot.width}px`, height: `${spot.height}px` }}
        />
      )}
      <div
        className="tutorial-bubble"
        data-placement={pos ? pos.placement : 'top'}
        style={bubbleStyle}
        ref={bubbleRef}
        role="dialog"
        aria-labelledby="tutorial-title"
      >
        <div className="tutorial-head">
          <span className="tutorial-kicker">新手指引 · 就地操作</span>
          <span className="tutorial-progress">
            {index + 1} / {TUTORIAL_STEPS.length}
          </span>
        </div>
        <h2 className="tutorial-title" id="tutorial-title">
          {step.title}
        </h2>
        <p className="tutorial-where">
          <span className="tutorial-tag" aria-hidden="true">
            📍 位置
          </span>
          {step.where}
        </p>
        <p className="tutorial-how">
          <span className="tutorial-tag" aria-hidden="true">
            👉 怎么用
          </span>
          {step.how}
        </p>
        {hint && <p className="tutorial-hint">{hint}</p>}
        <div className="tutorial-dots" aria-hidden="true">
          {TUTORIAL_STEPS.map((s, i) => (
            <span key={s.id} className={i === index ? 'is-on' : ''} />
          ))}
        </div>
        <div className="tutorial-actions">
          <button type="button" className="tutorial-skip" onClick={onFinish}>
            跳过指引
          </button>
          <div className="tutorial-nav">
            <button type="button" className="tutorial-prev" onClick={goPrev} disabled={index === 0}>
              上一步
            </button>
            <button type="button" className="tutorial-next" onClick={goNext} ref={nextRef}>
              {stepActionLabel(step, isLast)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // 挂到 body：.board 是 overflow: hidden 且可能有 stacking context，
  // 气泡要在整页范围内定位，不能被棋盘裁掉。
  if (typeof document === 'undefined' || !document.body) return tree;
  return createPortal(tree, document.body);
}
