import React, { useEffect, useRef, useState } from 'react';

import { TUTORIAL_STEPS } from './tutorial.js';

// 高亮区域向外多留一点边，光环不至于贴死元素的边框。
const SPOT_PAD = 6;

// 只取第一个命中的元素：指引每步只讲一块区域，取并集会跨到无关区域去
// （比如第 1 步 `.pane` 上下各一条，取并集就等于整块棋盘都不变暗了）。
function measureSpot(selector) {
  if (typeof document === 'undefined' || !selector) return null;
  const node = document.querySelector(selector);
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  // jsdom / 隐藏元素拿不到布局，rect 全 0 —— 此时退化成整屏变暗，不清空引导。
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

// 遮罩挖洞：外圈整屏 + 内圈目标矩形，交给 clip-path 的 evenodd 规则挖掉内圈。
// 不用「巨大 box-shadow」那招，因为 .board 有 overflow: hidden，阴影会被裁掉。
function veilClip(spot) {
  if (!spot) return undefined;
  const { left: x1, top: y1, width, height } = spot;
  const x2 = x1 + width;
  const y2 = y1 + height;
  return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x1}px ${y1}px, ${x2}px ${y1}px, ${x2}px ${y2}px, ${x1}px ${y2}px, ${x1}px ${y1}px)`;
}

// 新手对战指引：变暗遮罩 + 分步卡片，当前步骤把界面上对应区域「挖亮」并描一圈金光，
// 让新手知道这一步说的是屏幕哪一块。只负责展示与步进；
// 「要不要弹」由 tutorial.js 的 shouldShowTutorial 决定。
export default function Tutorial({ onFinish }) {
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState(null);
  const step = TUTORIAL_STEPS[index];
  const isLast = index === TUTORIAL_STEPS.length - 1;
  const nextRef = useRef(null);

  // 目标区域的位置要实测：窗口尺寸变化或页面滚动后重新量一次。
  useEffect(() => {
    const update = () => setSpot(measureSpot(step.target));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [step]);

  useEffect(() => {
    nextRef.current?.focus();
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

  const goPrev = () => setIndex((i) => Math.max(0, i - 1));
  const goNext = () => {
    if (isLast) {
      onFinish();
      return;
    }
    setIndex((i) => Math.min(TUTORIAL_STEPS.length - 1, i + 1));
  };

  return (
    <div className="tutorial" role="dialog" aria-modal="true" aria-labelledby="tutorial-title">
      {/* 遮罩本身负责变暗与吞掉点击：引导没走完前不误触游戏操作。 */}
      <div className="tutorial-veil" style={{ clipPath: veilClip(spot) }} aria-hidden="true" />
      {spot && (
        <div
          className="tutorial-ring"
          aria-hidden="true"
          style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
        />
      )}
      <div className="tutorial-card" key={step.id}>
        <div className="tutorial-head">
          <span className="tutorial-kicker">新手指引</span>
          <span className="tutorial-progress">
            {index + 1} / {TUTORIAL_STEPS.length}
          </span>
        </div>
        <h2 className="tutorial-title" id="tutorial-title">
          {step.title}
        </h2>
        <ul className="tutorial-body">
          {step.body.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="tutorial-dots" aria-hidden="true">
          {TUTORIAL_STEPS.map((s, i) => (
            <span key={s.id} className={i === index ? 'is-on' : ''} />
          ))}
        </div>
        <div className="tutorial-actions">
          <button type="button" className="tutorial-skip" onClick={onFinish}>
            跳过
          </button>
          <div className="tutorial-nav">
            <button
              type="button"
              className="tutorial-prev"
              onClick={goPrev}
              disabled={index === 0}
            >
              上一步
            </button>
            <button type="button" className="tutorial-next" onClick={goNext} ref={nextRef}>
              {isLast ? '开始对战' : '下一步'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
