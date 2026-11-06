// 生成对战卡池：在固定新手牌组之外，从完整卡库里挑选一批「新手友好」的
// 平衡怪兽，让每一局对战都能抽到一套全新的卡组，而不是永远那 14 张。
//
// 为什么单独出一个脚本而不是直接 bundle 完整卡库：
//   cards.catalog.json 有 14586 张（13.9MB），全部塞进游戏包太胖；
//   这里只挑出可玩性高、数值平衡的一小撮（约 74 张），既轻量又多样。
//
// 怪兽效果（2025-06 新增，见 AGENTS.md 决策记录）：
//   本引擎没有连锁/除外/额外卡组/字段系统，所以**不按单卡模拟 OCG 原文**，
//   而是把效果归入 5 个引擎能真实实现的效果类，用确定性正则给卡打标：
//     pierce        贯通：攻击守备怪并将其破坏时，伤害 = 攻击力 - 守备力
//     battleProtect 战斗破坏免疫：被战斗破坏时抵消该次破坏
//     summonDraw    召唤成功时抽 N 张
//     destroyBurn   被战斗破坏送墓时，给对方 N 点伤害
//     battleBoost   与特定属性怪兽战斗时，伤害步骤内攻击力 +N
//   打标的前提是「牌面文本 = 引擎行为」。因此只收「整段文本就是这一条
//   效果」的卡（无 ②③ 多效果、无「字段」引用、无指示物/装备/除外等本引擎
//   做不到的机制），宁缺毋滥——绝不把 OCG 原文硬塞给简化引擎。
//
// 选取规则（确定性，便于提交、便于复现）：
//   - 保留 14 张经典卡（含 5 张已实现效果的魔法，维持玩法不变）。
//   - 带效果的怪兽优先入选（配额 EFFECT_QUOTA），按效果类轮询保证多样性。
//   - 其余名额用普通新手怪按属性 6 路轮询补齐。
//   - 命中本地中文卡库的补 zhName/zhDesc，界面直接显示中文，与图鉴一致。
//
// 运行：node scripts/make-duel-pool.mjs
// 产物：src/data/duel-pool.json（被 cards.js import 进引擎）

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (rel) => JSON.parse(await readFile(resolve(ROOT, rel), 'utf8'));

const catalog = await readJson('public/data/cards.catalog.json');
const starter = await readJson('src/data/starter.cards.json');
const zh = await readJson('public/data/zh-cards.json');

const catalogCards = catalog.cards || [];
const starterCards = starter.cards || [];
const zhMap = zh.cards || {};

// ---- 保留经典卡（原样，不动它们的 key/效果名，保证既有逻辑不漂移） ----
const pool = [...starterCards];
const poolKeys = new Set(pool.map((c) => c.key));
const poolNames = new Set(pool.map((c) => c.name));

// ==================== 怪兽效果打标 ====================

// 文本优先用中文（卡池内只收有中文的卡）
const textOf = (card) => {
  const entry = zhMap[String(card.id)];
  return (entry?.desc || '').replace(/\s+/g, ' ').trim();
};

// 效果类定义：name 写入卡面 monsterEffect 字段。
// rx 用「整段锚定」：整段中文文本必须**恰好**是这一条简单效果，
// 任何额外子句（第二个效果、条件、限制）都会导致不匹配 → 该卡不收效果。
// 这样保证「牌面文本 = 引擎行为」，不会把 OCG 复杂效果硬塞给简化引擎。
// scope: 'self' 只作用于这张卡；'team' 作用于自己全场
const EFFECT_RULES = [
  {
    name: 'directAttack',
    scope: 'self',
    // 可直接攻击对方玩家（无视对方怪兽）
    rx: /^(?:①：)?这张卡可以直接攻击对方玩家。?$/,
  },
  {
    name: 'pierce',
    scope: 'self',
    // 贯通：攻击守备表示怪兽时，伤害取攻击力超过守备力的部分
    rx: /^(?:①：)?(?:这张卡向守备表示怪兽攻击的场合，给与攻击力超过那个守备力的数值的战斗伤害。?|这张卡攻击守备表示怪兽时，若攻击力超过那个守备力，给与对方基本分那个数值的战斗伤害。?|这张卡向守备表示怪兽攻击时，若攻击力超过那个守备力，给与对方基本分那个数值的战斗伤害。?)$/,
  },
  {
    name: 'battleProtect',
    scope: 'self',
    // 不会被战斗破坏（含「手卡为 0 张」「攻击表示」等可判定条件）
    rx: /^(?:①：)?(?:只要自己手卡是0张，)?(?:以?表侧攻击表示存在的)?这张卡不会被战斗破坏(?:（伤害计算适用）)?。?$/,
  },
  {
    name: 'summonDraw',
    scope: 'self',
    // 召唤/特殊召唤成功时抽 N 张
    rx: /^这张卡(?:从墓地的)?(?:召唤|特殊召唤)成功时，?(?:自己)?从?(?:自己)?卡组抽\d+张卡?。?$/,
    params: (t) => {
      const m = t.match(/抽(?:出)?(\d+)张/);
      return { draw: Math.min(3, Number(m?.[1]) || 1) };
    },
  },
  {
    name: 'destroyBurn',
    scope: 'self',
    // 被战斗破坏送墓时，给与对方 N 点伤害
    rx: /^这张卡被战斗破坏送去墓地时，给与对方基本分\d+分?伤害。?$/,
    params: (t) => {
      const m = t.match(/给与对方基本分(\d+)分?伤害/);
      return { burn: Math.min(1500, Number(m?.[1]) || 500) };
    },
  },
  {
    name: 'battleBoost',
    scope: 'self',
    // 与特定属性/类别怪兽战斗时，伤害步骤内攻击力 +N
    rx: /^(?:①：)?(?:这张卡和通常怪兽以外的怪兽进行战斗的伤害步骤内，这张卡的攻击力上升\d+。?|这张卡和光属性怪兽进行战斗的场合，伤害步骤内这张卡的攻击力上升\d+。?)$/,
    params: (t) => {
      const m = t.match(/攻击力上升(\d+)/);
      return { boost: Math.min(1200, Number(m?.[1]) || 300) };
    },
  },
];
// 只认「单条效果」，多条命中时按声明顺序取第一个（顺序即优先级）。
// 根据效果文本判定属于哪个效果类。返回 { name, scope, params } 或 null。
// 严格锚定正则已保证「整段就是这一条效果」，无需再做结构性过滤。
function detectEffect(card) {
  const text = textOf(card);
  if (!text) return null;
  for (const rule of EFFECT_RULES) {
    if (rule.rx.test(text)) {
      return {
        name: rule.name,
        scope: rule.scope,
        params: rule.params ? rule.params(text) : {},
      };
    }
  }
  return null;
}

// ---- 从卡库挑新手友好的怪兽 ----
const ATTRS = ['EARTH', 'WATER', 'DARK', 'FIRE', 'LIGHT', 'WIND'];
const PER_ATTR = 10; // 普通怪每属性取 10 张 -> 60 张
const EFFECT_QUOTA = 14; // 效果怪目标数量（卡库中"整段仅一条简单效果"的卡实际只有 14 张）
const TOTAL_MONSTERS = ATTRS.length * PER_ATTR;

const candidates = catalogCards.filter(
  (c) =>
    c.type === 'monster' &&
    ['Normal Monster', 'Effect Monster', 'Tuner'].includes(c.sourceType) &&
    c.name !== '???' &&
    c.level >= 1 && c.level <= 6 &&
    c.atk >= 400 && c.atk <= 2500 &&
    c.def >= 0 && c.def <= 2500 &&
    !poolKeys.has(c.key) && !poolNames.has(c.name) &&
    // 必须有中文译名：卡池内不允许出现"英文冒充中文"的卡
    Boolean(zhMap[String(c.id)])
);

// 给每张候选卡打标（含 null），后续按效果类分桶
const tagged = candidates.map((c) => ({ card: c, effect: detectEffect(c) }));

// 确定性排序：先种族再名字，让同一输入永远产出同一批卡
const sortDeterministic = (list) =>
  list.sort(
    (x, y) =>
      (x.race || '').localeCompare(y.race || '') ||
      x.name.localeCompare(y.name)
  );

// ---- 1) 先挑效果怪：按效果类轮询，保证每类都有、不扎堆 ----
const effectBuckets = new Map(EFFECT_RULES.map((r) => [r.name, []]));
for (const { card, effect } of tagged) {
  if (effect) effectBuckets.get(effect.name).push(card);
}
for (const list of effectBuckets.values()) sortDeterministic(list);

const chosenEffects = [];
{
  // 轮询各效果类，每轮每类取 1 张，直到达到配额或取尽
  const buckets = [...effectBuckets.entries()].filter(([, list]) => list.length > 0);
  let round = 0;
  let guard = 0;
  while (chosenEffects.length < EFFECT_QUOTA && guard < 10000) {
    let progressed = false;
    for (const [, list] of buckets) {
      if (chosenEffects.length >= EFFECT_QUOTA) break;
      const idx = round % list.length;
      const card = list[idx];
      if (poolKeys.has(card.key) || poolNames.has(card.name)) continue;
      if (chosenEffects.some((x) => x.card.key === card.key)) continue;
      const { effect } = tagged.find((t) => t.card.key === card.key) || {};
      if (!effect) continue;
      chosenEffects.push({ card, effect });
      progressed = true;
    }
    if (!progressed) break;
    round++;
    guard++;
  }
}

// ---- 2) 剩余名额用普通怪按属性轮询补齐 ----
const chosenEffectKeys = new Set(chosenEffects.map((x) => x.card.key));
const normalCandidates = candidates.filter(
  (c) => !chosenEffectKeys.has(c.key) && !detectEffect(c)
);
const byAttr = Object.fromEntries(ATTRS.map((a) => [a, []]));
for (const c of normalCandidates) byAttr[c.attribute || 'EARTH'].push(c);
for (const a of ATTRS) sortDeterministic(byAttr[a]);

const normalNeeded = TOTAL_MONSTERS - chosenEffects.length;
const chosenNormals = [];
{
  let round = 0;
  let guard = 0;
  while (chosenNormals.length < normalNeeded && guard < 10000) {
    let progressed = false;
    for (const a of ATTRS) {
      if (chosenNormals.length >= normalNeeded) break;
      const list = byAttr[a];
      if (list.length === 0) continue;
      const step = Math.max(1, Math.ceil(list.length / PER_ATTR));
      const idx = (round * step) % list.length;
      const card = list[idx];
      if (chosenNormals.some((x) => x.key === card.key)) continue;
      chosenNormals.push(card);
      progressed = true;
    }
    if (!progressed) break;
    round++;
    guard++;
  }
}

// ---- 3) 合并写入卡池 ----
const pushCard = (card, effect) => {
  const zhEntry = zhMap[String(card.id)];
  pool.push({
    ...card,
    zhName: zhEntry?.name || undefined,
    zhDesc: zhEntry?.desc || undefined,
    // 可特殊召唤标记：效果文本提到 special summon 的新怪兽。
    // 引擎按统一简化规则实现；经典 14 张不带该字段。
    canSpecialSummon: /special summon/i.test(card.desc || ''),
    // 怪兽效果：只对通过「单条效果 + 引擎可实现」双重校验的卡写入。
    // 未写入的卡在引擎里没有任何效果，牌面文本也确实是普通/复杂效果，
    // 不会出现"写着能打却打不出来"的错位。
    ...(effect
      ? {
          monsterEffect: effect.name,
          effectScope: effect.scope,
          effectParams: effect.params || {},
        }
      : {}),
  });
  poolKeys.add(card.key);
  poolNames.add(card.name);
};

for (const { card, effect } of chosenEffects) pushCard(card, effect);
for (const card of chosenNormals) pushCard(card, null);

const outPath = resolve(ROOT, 'src/data/duel-pool.json');
await writeFile(
  outPath,
  `${JSON.stringify(
    {
      source: 'generated:make-duel-pool.mjs',
      // count 保留完整卡库规模，图鉴角标仍显示全部张数
      count: catalog.count ?? catalogCards.length,
      cards: pool,
    },
    null,
    2
  )}\n`,
  'utf8'
);

// ---- 统计输出（便于人工核对配额是否达成） ----
const distinct = new Set(pool.map((c) => c.name)).size;
const effectCount = pool.filter((c) => c.monsterEffect).length;
const byEffect = {};
for (const c of pool) {
  if (c.monsterEffect) byEffect[c.monsterEffect] = (byEffect[c.monsterEffect] || 0) + 1;
}

console.log(
  `duel-pool: ${pool.length} cards (${distinct} distinct) written to src/data/duel-pool.json`
);
console.log(`  starter kept: ${starterCards.length}`);
console.log(`  new monsters: ${pool.length - starterCards.length}`);
console.log(`  effect monsters: ${effectCount} / target ${EFFECT_QUOTA}`);
console.log(`  by effect: ${JSON.stringify(byEffect)}`);
if (effectCount < EFFECT_QUOTA) {
  console.warn(
    `  WARN: effect quota not met (${effectCount}/${EFFECT_QUOTA}) — card DB has limited clean single-effect cards`
  );
}
