import catalog from './data/starter.cards.json' with { type: 'json' };

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
  'Graceful Charity': '①：自己抽3张。那之后，选自己2张手卡丢弃。',
  'Mystical Space Typhoon': '①：以场上1张魔法·陷阱卡为对象才能发动。那张卡破坏。',
  'Monster Reborn': '①：以自己或对方的墓地1只怪兽为对象才能发动。那只怪兽在自己场上特殊召唤。',
  'Swords of Revealing Light': '这张卡发动后继续留在场上，用对方回合计算的3回合后的对方结束阶段破坏。\n①：作为这张卡的发动时的效果处理，对方场上有里侧表示怪兽存在的场合，那些全部变成表侧表示。\n②：只要这张卡在魔法与陷阱区域存在，对方怪兽不能攻击宣言。',
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
  'Graceful Charity': { effect: 'draw3', desc: '①：自己抽3张。那之后，选自己2张手卡丢弃。' },
  'Mystical Space Typhoon': {
    effect: 'destroyStrongest',
    desc: '①：以场上1张魔法·陷阱卡为对象才能发动。那张卡破坏。',
  },
  'Monster Reborn': {
    effect: 'reborn',
    desc: '①：以自己或对方的墓地1只怪兽为对象才能发动。那只怪兽在自己场上特殊召唤。',
  },
  'Swords of Revealing Light': {
    effect: 'lockdown',
    desc: '这张卡发动后继续留在场上，用对方回合计算的3回合后的对方结束阶段破坏。①：作为这张卡的发动时的效果处理，对方场上有里侧表示怪兽存在的场合，那些全部变成表侧表示。②：只要这张卡在魔法与陷阱区域存在，对方怪兽不能攻击宣言。',
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
        desc: special?.desc ?? cardDescriptionForDisplay(source),
        cn: cardNameForDisplay(source),
        lore: cardDescriptionForDisplay(source),
      },
    ];
  })
);

export const CARD_CATALOG = Object.values(CARDS);
export const CARD_CATALOG_COUNT = catalog.count;

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

export const FIELD_SLOTS = 3;
export const START_LP = 4000;
export const START_HAND = 5;
export const LOG_LIMIT = 40;

// 有官方卡图 URL 时显示远程缩略图；网络不可用时 CardFace 会回落到 CSS 卡面。
export const cardArt = (id) => CARDS[id]?.imageUrlSmall ?? '';
