// 新手指引的「数据 + 判定 + 气泡定位 + 持久化」部分，与 React 组件分开，便于单测。
//
// 形态（2026-03 用户裁决重做，v2）：不再居中讲解，改为**就地标注**——
// 每一步的气泡贴在被说明的那个控件旁边，金光框住控件本身，气泡里只讲两件事：
//   where —— 这个按钮在屏幕的哪个位置
//   how   —— 怎么点、点完会发生什么、接下来点哪里
// 指引期间页面照常可以操作（暗底 pointer-events: none，不拦点击），
// 玩家可以边看边点真实按钮；做完对应操作气泡自动前进到下一步（`done` 谓词），
// 因此能凭现场指引直接走完一整轮：召唤 → 进战斗阶段 → 攻击 → 结束回合。
//
// 触发条件：只在本机第一次进入对局时自动弹出；走完/跳过都算「看过」。
// 想再看可点状态栏的「玩法」按钮。

// v2 = 就地标注版。改版本号会让看过 v1 的用户重新看到一次（用户要求重做，理应重看）。
export const TUTORIAL_VERSION = 2;
export const TUTORIAL_STORAGE_KEY = 'yugioh-duel.tutorial.seen';

// 气泡与目标控件之间的空隙、气泡离视口边缘的最小留白。
export const BUBBLE_GAP = 14;
export const BUBBLE_MARGIN = 12;

// 每步：target 定位真实控件（只用 board.jsx 里真实存在的 class），
// fallbackTarget 是该控件当前没渲染时的替代锚点（例如召唤弹窗已关掉）。
// done 是「玩家已经做完这一步」的纯谓词，返回 true 即自动前进；
// optional 的步骤不自动推进（可做可不做），按钮显示「继续」。
export const TUTORIAL_STEPS = [
  {
    id: 'hand',
    target: '.my-hand',
    anchor: 'top',
    title: '① 点手牌召唤怪兽',
    where: '屏幕最下面那一排卡就是你的手牌。',
    how: '点一张怪兽卡就会召唤它；点魔法卡是发动效果。',
    done: (s) => s.askingSummon || s.myMonsters > 0,
  },
  {
    id: 'stance',
    target: '.summon-choice',
    fallbackTarget: '.my-field',
    anchor: 'bottom',
    title: '② 选攻击表示还是守备表示',
    where: '刚弹出的这条提示栏在状态行下面（写着「选择 ×× 的表示形式」）。',
    how: '点「⚔ 攻击表示」它正面朝上、能攻击；点「🛡 守备表示」它横过来，不能攻击但被打时按守备力算。',
    done: (s) => !s.askingSummon && s.myMonsters > 0,
  },
  {
    id: 'position',
    target: '.my-field',
    anchor: 'bottom',
    optional: true,
    title: '③（可选）主阶段还能做两件事',
    where: '中间靠下这一排方框，是你自己的怪兽区。',
    how: '点自己的怪兽可在攻击⇄守备之间切换（每只每回合 1 次，不占召唤名额）；想复活怪兽就点最下面「墓地·可复活」那张卡。',
    hint: '这一步不做也能打完，不想看就点「继续」。',
  },
  {
    id: 'battle',
    target: '.btn-battle',
    fallbackTarget: '.actions',
    anchor: 'top',
    title: '④ 点「进入战斗阶段」',
    where: '怪兽区和手牌之间那一排按钮，最左边的就是它。',
    how: '点它才会切到战斗阶段；主要阶段点怪兽只能改表示，打不到人。',
    done: (s) => s.battleEntered,
  },
  {
    id: 'attack',
    target: '.foe-field',
    anchor: 'top',
    title: '⑤ 攻击：点自己的怪兽 → 再点对手这只',
    where: '上方这一排是对方的怪兽区，要打哪只就点哪只。',
    how: '先点自己攻击表示的怪兽（它会亮起来），再点对手的怪兽就开打；对手空场时点自己的怪兽就是直接打玩家。',
    done: (s) => s.attacked,
  },
  {
    id: 'end',
    target: '.btn-end',
    fallbackTarget: '.actions',
    anchor: 'top',
    title: '⑥ 点「结束回合」把回合交给对手',
    where: '同一排按钮里最右边的「结束回合」。',
    how: '点它就轮到对手行动；对手打完又回到你（每回合开始自动抽 1 张）。',
    done: (s) => !s.myTurn,
  },
  {
    id: 'finish',
    target: '.status-help',
    fallbackTarget: '.statusbar',
    anchor: 'top',
    title: '⑦ 一轮打完了，就按这个节奏继续',
    where: '状态行最右边这个「玩法」小按钮，随时能重新打开这份指引。',
    how: '点「开始对战」关掉指引；之后把鼠标停在任意卡面上，可以看它的效果与攻守数值。',
  },
];

// 把棋盘状态压成指引需要的几个判断量。纯函数：move 后 board 重渲染就会重算。
export function buildTutorialState({ me, foe, myTurn, isActive, step, turn, pendingSummon } = {}) {
  const myField = Array.isArray(me?.field) ? me.field : [];
  const foeField = Array.isArray(foe?.field) ? foe.field : [];
  return {
    myTurn: Boolean(myTurn),
    isActive: Boolean(isActive),
    battleEntered: step === 'battle',
    firstTurn: Boolean(me?.firstTurn),
    handCount: Array.isArray(me?.hand) ? me.hand.length : 0,
    myMonsters: myField.filter(Boolean).length,
    foeMonsters: foeField.filter(Boolean).length,
    attacked: myField.some((entry) => entry && entry.attacked),
    askingSummon: Boolean(pendingSummon),
    turn: Number.isFinite(turn) ? turn : 1,
  };
}

// 现场提示：只在「照现在这样点下去会卡住或理解错」时给一句额外说明，
// 免得每步都堆一堆废话。
export function stepHint(stepOrId, state = {}) {
  const id = typeof stepOrId === 'string' ? stepOrId : stepOrId?.id;
  if (id === 'hand' && state.myTurn === false) {
    return '现在是对手回合：等它出完牌轮到你，气泡会在这儿一直等你。';
  }
  if (id === 'battle' && state.myTurn === false) {
    return '还没轮到你：先在对手回合看它怎么打，轮到你再点这个按钮。';
  }
  if (id === 'attack') {
    if (state.firstTurn) {
      return '双方第一回合不能攻击：这一回合直接点「下一步」→ 再点「结束回合」，下一回合再打。';
    }
    if (!state.battleEntered) return '先点「进入战斗阶段」，攻击入口才会出现。';
    if (state.foeMonsters === 0) return '对手场上没有怪兽：这时点自己的怪兽就是直接打对手玩家。';
  }
  if (id === 'end' && state.myTurn === false) {
    return '现在是对手回合，等它结束回合才轮到你。';
  }
  return null;
}

// 主按钮文案：可选步骤说「继续」，最后一步说「开始对战」。
export function stepActionLabel(step, isLast) {
  if (isLast) return '开始对战';
  return step?.optional ? '继续' : '下一步';
}

// 方位候选顺序：优先用数据里指定的方位，放不下就按这个顺序翻转。
const FALLBACK_ORDER = {
  top: ['top', 'bottom', 'right', 'left'],
  bottom: ['bottom', 'top', 'right', 'left'],
  left: ['left', 'right', 'top', 'bottom'],
  right: ['right', 'left', 'top', 'bottom'],
};

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

// 某个方位下气泡左上角坐标 + 箭头指向目标的偏移。
function candidatePosition(placement, spot, size) {
  const centerX = spot.left + spot.width / 2;
  const centerY = spot.top + spot.height / 2;
  if (placement === 'bottom') {
    return {
      placement,
      axis: 'x',
      center: centerX,
      left: centerX - size.width / 2,
      top: spot.top + spot.height + BUBBLE_GAP,
    };
  }
  if (placement === 'right') {
    return {
      placement,
      axis: 'y',
      center: centerY,
      left: spot.left + spot.width + BUBBLE_GAP,
      top: centerY - size.height / 2,
    };
  }
  if (placement === 'left') {
    return {
      placement,
      axis: 'y',
      center: centerY,
      left: spot.left - BUBBLE_GAP - size.width,
      top: centerY - size.height / 2,
    };
  }
  return {
    placement: 'top',
    axis: 'x',
    center: centerX,
    left: centerX - size.width / 2,
    top: spot.top - BUBBLE_GAP - size.height,
  };
}

// 计算气泡落点：挑第一个「完整落在视口里」的方位，都不行就用优先方位再夹进视口。
// 返回 { top, left, placement, arrow: { axis, offset } }，offset 是箭头相对气泡边的位置。
export function placeBubble(spot, size, preferred = 'top', viewport = {}) {
  if (!spot || !size) return null;
  const width = Number(size.width);
  const height = Number(size.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const vw = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : 1280;
  const vh = Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : 800;
  const order = FALLBACK_ORDER[preferred] || FALLBACK_ORDER.top;

  let fit = null;
  let first = null;
  for (const placement of order) {
    const candidate = candidatePosition(placement, spot, size);
    if (!first) first = candidate;
    const inside =
      candidate.left >= BUBBLE_MARGIN &&
      candidate.top >= BUBBLE_MARGIN &&
      candidate.left + width <= vw - BUBBLE_MARGIN &&
      candidate.top + height <= vh - BUBBLE_MARGIN;
    if (inside) {
      fit = candidate;
      break;
    }
  }

  const base = fit || first;
  const left = clamp(base.left, BUBBLE_MARGIN, vw - width - BUBBLE_MARGIN);
  const top = clamp(base.top, BUBBLE_MARGIN, vh - height - BUBBLE_MARGIN);
  const offset =
    base.axis === 'x'
      ? clamp(base.center - left, 18, Math.max(18, width - 18))
      : clamp(base.center - top, 18, Math.max(18, height - 18));
  return { top, left, placement: base.placement, arrow: { axis: base.axis, offset } };
}

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
