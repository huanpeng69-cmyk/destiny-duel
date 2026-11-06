// 新手对战指引的「数据 + 持久化」部分，与 React 组件分开，便于单测。
//
// 触发条件（决策记录见 AGENTS.md《新手首次对战指引》）：只在本机第一次进入对局时
// 自动弹出；读完/跳过都算「看过」，之后不再打扰。想再看可点对局内的「玩法」按钮。
// 版本号参与判断：以后指引改版时把 TUTORIAL_VERSION +1，老用户会重新看到一次。

export const TUTORIAL_VERSION = 1;
export const TUTORIAL_STORAGE_KEY = 'yugioh-duel.tutorial.seen';

// 6 步覆盖新手最常踩的坑：目标 → 召唤 → 攻击 → 直击/破壁 → 改表示/特召复活 → 结束回合。
// target 是 CSS 选择器，组件只取第一个命中元素实测位置，把它从遮罩里「挖亮」。
// 选选择器时注意：别选会上下各命中一条的那种（如 `.pane` 之外再取并集），
// 一旦挖洞覆盖整块棋盘，高亮就等于没做。
export const TUTORIAL_STEPS = [
  {
    id: 'goal',
    title: '目标：把对手生命打到 0',
    target: '.pane',
    body: [
      '上方是「对手 · 暗之决斗者」，下方是「你 · 光之决斗者」，双方生命各 4000。',
      '谁的生命先归零谁就输；牌组抽干也会判负。',
      '中间两排就是怪兽区，各有 5 个槽位。',
    ],
  },
  {
    id: 'hand',
    title: '抽牌与召唤',
    target: '.my-hand',
    body: [
      '每回合开始自动抽 1 张牌，下方这一排就是你的手牌。',
      '主要阶段点手牌即可召唤，每回合通常召唤只有 1 次。',
      '5-6 星要献祭 1 只场上怪兽，7 星以上要 2 只；召唤时会让你选攻击或守备表示。',
    ],
  },
  {
    id: 'battle',
    title: '攻击：先进入战斗阶段',
    target: '.my-field',
    body: [
      '主要阶段点「进入战斗阶段」后，点自己攻击表示的怪兽，再点对手的怪兽发起攻击。',
      '对手场上没有怪兽时，攻击会直接打玩家。',
      '守备表示的怪兽不能攻击，但被打时按守备力结算，更省血。',
    ],
  },
  {
    id: 'direct',
    title: '「直击」与「破壁」',
    target: '.foe-field',
    body: [
      '带「直击」的怪兽可以越过对方怪兽，直接打对方玩家（对方有怪兽时也能打）。',
      '攻击守备表示的怪兽并把它破坏，叫「破壁」：不扣对方生命。',
      '只有带「贯通」的怪兽，破壁时才按「攻击力 − 守备力」的差值扣血。',
    ],
  },
  {
    id: 'position',
    title: '改表示 · 特殊召唤 · 墓地复活',
    target: '.graveyard-strip',
    body: [
      '主要阶段点自己的怪兽，可在攻击⇄守备之间切换，每只怪兽每回合 1 次，不占通常召唤。',
      '每回合还能特殊召唤 1 次：手牌里写着可特殊召唤的怪兽，或点下方墓地「可复活」的卡。',
      '从墓地复活要付代价：1 张手牌送墓，并且和手牌特召共用同一次配额。',
    ],
  },
  {
    id: 'end',
    title: '结束回合，轮到对手',
    target: '.actions',
    body: [
      '出完牌点「结束回合」，就轮到对手行动。',
      '双方各自的第一个回合不能攻击，先摆好局面。',
      '把鼠标停在任意卡面上可以看它的效果与攻守数值；战斗结果会在屏幕中央演出。',
    ],
  },
];

// 读取/写入全部包在 try/catch 里：隐私模式下 localStorage 可能直接抛错，
// 这种情况下「看过标记」失效也不能让整局游戏崩掉。
export function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function hasSeenTutorial(storage = safeStorage()) {
  if (!storage) return false;
  try {
    const seen = Number(storage.getItem(TUTORIAL_STORAGE_KEY));
    return Number.isFinite(seen) && seen >= TUTORIAL_VERSION;
  } catch {
    return false;
  }
}

export function shouldShowTutorial(storage = safeStorage()) {
  return !hasSeenTutorial(storage);
}

export function markTutorialSeen(storage = safeStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(TUTORIAL_STORAGE_KEY, String(TUTORIAL_VERSION));
    return true;
  } catch {
    return false;
  }
}

export function resetTutorial(storage = safeStorage()) {
  if (!storage) return false;
  try {
    storage.removeItem(TUTORIAL_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
