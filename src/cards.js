import catalog from './data/duel-pool.json' with { type: 'json' };

// 卡牌资料来自 YGOPRODeck API 的本地快照。
// 规则引擎只依赖这里的稳定字段；完整原始数据保留在 src/data/ 中，
// 通过 npm run cards:import 可重新导入。

export const ATTRIBUTES = {
  LIGHT: { label: '光', glyph: '✧', color: '#f2d98a', edge: '#b8892f' },
  DARK: { label: '暗', glyph: '✦', color: '#c8a6ee', edge: '#6d4a9e' },
  EARTH: { label: '地', glyph: '❖', color: '#9ed4a8', edge: '#3f7a52' },
  WATER: { label: '水', glyph: '◈', color: '#8bc8e8', edge: '#3d7596' },
  FIRE: { label: '炎', glyph: '✹', color: '#f29a78', edge: '#a94d32' },
  WIND: { label: '风', glyph: '◇', color: '#a7dfb5', edge: '#4d8c61' },
  DIVINE: { label: '神', glyph: '☼', color: '#f6d27a', edge: '#a77a22' },
};

export function tributesNeeded(level) {
  if (level >= 7) return 2;
  if (level >= 5) return 1;
  return 0;
}

// 新手对战牌组的中文显示名与效果说明。这些名字/效果现在与权威中文卡库
// ygocdb 对齐，保证对战界面与图鉴显示完全一致；未收录中文的卡牌在图鉴中
// 显示英文原文，绝不把英文冒充中文。
const ZH_CARD_NAMES = {
  'Blue-Eyes White Dragon': '青眼白龙',
  'Dark Magician': '黑魔术师',
  'Red-Eyes Black Dragon': '真红眼黑龙',
  'Tri-Horned Dragon': '三角魔龙',
  'Summoned Skull': '恶魔召唤',
  'Gemini Elf': '双生精灵',
  'Gearfried the Iron Knight': '铁骑士 基亚·弗里德',
  'Celtic Guardian': '精灵剑士',
  'Mystical Elf': '圣精灵',
  'Pot of Greed': '强欲之壶',
  'Graceful Charity': '天使的施舍',
  'Mystical Space Typhoon': '旋风',
  'Monster Reborn': '死者苏生',
  'Swords of Revealing Light': '光之护封剑',
};

const ZH_CARD_DESCRIPTIONS = {
  'Blue-Eyes White Dragon': '以高攻击力著称的传说之龙。任何对手都能粉碎，其破坏力不可估量。',
  'Dark Magician': '作为魔法师，攻击力·守备力都是最高级别。',
  'Red-Eyes Black Dragon': '拥有真红之眼的黑龙。愤怒的黑炎会把映入其眼者全部烧成灰烬。',
  'Tri-Horned Dragon': '以头上生长的3只角为特征的恶魔龙。',
  'Summoned Skull': '使用黑暗力量，迷惑人心的恶魔。在恶魔族中以相当强大的力量著称。',
  'Gemini Elf': '交替发动攻击的精灵双子姐妹。',
  'Gearfried the Iron Knight': '①：这张卡有装备卡被装备的场合发动。那些装备卡破坏。',
  'Celtic Guardian': '学会了剑术的精灵。以快速的攻击作弄敌人。',
  'Mystical Elf': '虽然是纤弱的精灵，但以神圣力量护身有很强的守备。',
  'Pot of Greed': '①：自己抽2张。',
  'Graceful Charity': '①：自己抽3张。',
  'Mystical Space Typhoon': '①：破坏对方场上1只攻击力最高的怪兽。',
  'Monster Reborn': '①：以自己或对方的墓地1只怪兽为对象才能发动。那只怪兽在自己场上特殊召唤。',
  'Swords of Revealing Light': '①：对方下个回合不能攻击。此卡留在场上，于对方回合结束时送入墓地。',
};

export function cardNameForDisplay(card) {
  // 优先级：本地中文卡库(zhName) > 内置 14 张译名 > 卡面自带 cn > 英文原名。
  // 没有中文时回落英文原文，绝不把英文冒充中文。
  if (!card) return '';
  if (typeof card === 'string') return card;
  return card.zhName || ZH_CARD_NAMES[card.name] || card.cn || card.name || '';
}

export function cardDescriptionForDisplay(card) {
  if (!card) return '';
  if (typeof card === 'string') return card;
  return card.zhDesc || ZH_CARD_DESCRIPTIONS[card.name] || card.desc || '';
}

const effectByName = {
  'Pot of Greed': { effect: 'draw2', desc: '①：自己抽2张。' },
  'Graceful Charity': { effect: 'draw3', desc: '①：自己抽3张。' },
  'Mystical Space Typhoon': {
    effect: 'destroyStrongest',
    desc: '①：破坏对方场上1只攻击力最高的怪兽。',
  },
  'Monster Reborn': {
    effect: 'reborn',
    desc: '①：以自己墓地1只怪兽为对象才能发动。那只怪兽在自己场上特殊召唤。',
  },
  'Swords of Revealing Light': {
    effect: 'lockdown',
    desc: '①：对方下个回合不能攻击。此卡留在场上，于对方回合结束时送入墓地。',
    persistence: 'until-opponent-turn-ends',
  },
};

export const CARDS = Object.fromEntries(
  catalog.cards.map((source) => {
    const special = effectByName[source.name];
    return [
      source.key,
      {
        ...source,
        effect: special?.effect ?? null,
        persistence: special?.persistence ?? null,
        // 效果文本提及 special summon 的新怪兽（make-duel-pool.mjs 打标）；
        // 经典卡与无效果文本的卡为 false，引擎据此放行/拒绝特召。
        canSpecialSummon: Boolean(source.canSpecialSummon),
        // 怪兽效果（make-duel-pool.mjs 用「整段锚定」正则打标，见 effects.js）：
        //   monsterEffect  效果类名（directAttack/pierce/battleProtect/
        //                  summonDraw/destroyBurn/battleBoost）
        //   effectParams   数值参数（draw/burn/boost）
        // 打标与文本严格一致，没有该字段的卡就是「无效果」。
        monsterEffect: source.monsterEffect ?? null,
        effectParams: source.effectParams ?? {},
        desc: special?.desc ?? cardDescriptionForDisplay(source),
        cn: cardNameForDisplay(source),
        lore: cardDescriptionForDisplay(source),
      },
    ];
  })
);

export const CARD_CATALOG = Object.values(CARDS);

// 牌组从导入卡库里选取；卡库本身是完整的，牌组仍保持新手局的长度。
// 这样所有牌面基础信息来自 YGOPRODeck，同时不会让一局游戏变成数万张卡的长局。
export const DECK_SIZE = 40;
export const SPELL_TRAP_SLOTS = 3;

const starterCopies = {
  'Blue-Eyes White Dragon': 2,
  'Dark Magician': 3,
  'Red-Eyes Black Dragon': 3,
  'Summoned Skull': 3,
  'Tri-Horned Dragon': 3,
  'Gemini Elf': 3,
  'Gearfried the Iron Knight': 3,
  'Mystical Elf': 3,
  'Celtic Guardian': 3,
  'Pot of Greed': 2,
  'Graceful Charity': 3,
  'Mystical Space Typhoon': 3,
  'Monster Reborn': 3,
  'Swords of Revealing Light': 3,
};

const byName = new Map(CARD_CATALOG.map((card) => [card.name, card]));
export const DECK_LIST = Object.entries(starterCopies).flatMap(([name, count]) => {
  const card = byName.get(name);
  if (!card) throw new Error(`Imported card is missing from starter deck: ${name}`);
  return Array.from({ length: count }, () => card.key);
});

if (DECK_LIST.length !== DECK_SIZE) {
  throw new Error('Starter deck must contain exactly ' + DECK_SIZE + ' cards; found ' + DECK_LIST.length);
}
if (Object.values(starterCopies).some((count) => count > 3)) {
  throw new Error('Starter deck cannot contain more than 3 copies of a card');
}

// 新对局卡组：setup 时按 boardgame.io 注入的 random（种子化、客户端/服务端完全一致）
// 从对局卡池随机抽一套全新卡组，让每局对战的卡牌都「全新不重复」。
// 上面的 DECK_LIST 仍作为「经典新手牌组」保留，供测试引用。
export const MAX_DECK_COPIES = 3;

// 「直击」怪保底（2026-03 用户裁决，量化后定为 2 份）：
// 4 张直击怪在 74 张池里随机抽 40 张时，实测（20000 次）平均只有 2.17 张，
// 8.3% 的牌组一张都没有，起手 5 张含直击只有 24.2% —— 玩家手里没有直击怪时
// 界面上「直接攻击」入口根本不出现，看起来就是「效果没生效」（见 AGENTS.md）。
// 保底 2 份后：起手含直击 38.0%，牌组里 0 张的情况归零，且不干预起手洗牌。
// 注意保底是「在洗牌前占位」，牌组整体仍会被再洗一次，起手依旧随机。
export const DIRECT_ATTACK_RESERVE = 2;

export function buildRandomDeck(random, size = DECK_SIZE, maxCopies = MAX_DECK_COPIES) {
  // 先在直击怪里随机挑卡补足保底份数（单卡份数仍受 maxCopies 约束）。
  const reserved = [];
  let need = Math.min(DIRECT_ATTACK_RESERVE, size);
  if (need > 0) {
    const directPool = CARD_CATALOG.filter((card) => card.monsterEffect === 'directAttack');
    for (const card of random.Shuffle([...directPool])) {
      if (need <= 0) break;
      const take = Math.min(need, maxCopies);
      for (let i = 0; i < take; i++) reserved.push(card.key);
      need -= take;
    }
  }
  // 其余卡位从整池抽；保底卡的 key 整组排除，保证总份数不超过 maxCopies。
  const bag = [];
  for (const card of CARD_CATALOG) {
    for (let i = 0; i < maxCopies; i++) bag.push(card.key);
  }
  const fill = random
    .Shuffle(bag)
    .filter((key) => !reserved.includes(key))
    .slice(0, size - reserved.length);
  return random.Shuffle([...reserved, ...fill]);
}

export const FIELD_SLOTS = 5;
export const START_LP = 4000;
export const START_HAND = 5;
export const LOG_LIMIT = 40;

// 每回合通常召唤上限（含改变表示形式）。2025-06 起限定为 1 只。
export const MAX_NORMAL_SUMMONS = 1;

// 有官方卡图 URL 时显示远程缩略图；网络不可用时 CardFace 会回落到 CSS 卡面。
export const cardArt = (id) => CARDS[id]?.imageUrlSmall ?? '';
