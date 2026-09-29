import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_URL = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
const rawPath = resolve(ROOT, 'src/data/ygoprodeck.cards.json');
const catalogPath = resolve(ROOT, 'public/data/cards.catalog.json');
const starterPath = resolve(ROOT, 'src/data/starter.cards.json');

const legacyKeys = {
  'Blue-Eyes White Dragon': 'blueEyes',
  'Dark Magician': 'darkMagician',
  'Red-Eyes Black Dragon': 'redEyes',
  'Tri-Horned Dragon': 'triHorned',
  'Summoned Skull': 'summonedSkull',
  'Gemini Elf': 'geminiElf',
  'Gearfried the Iron Knight': 'gearfried',
  'Celtic Guardian': 'celticGuardian',
  'Mystical Elf': 'mysticalElf',
  'Pot of Greed': 'potOfGreed',
  'Graceful Charity': 'gracefulCharity',
  'Mystical Space Typhoon': 'typhoon',
  'Monster Reborn': 'monsterReborn',
  'Swords of Revealing Light': 'swordsOfLight',
};

const starterNames = [
  'Blue-Eyes White Dragon',
  'Dark Magician',
  'Red-Eyes Black Dragon',
  'Summoned Skull',
  'Tri-Horned Dragon',
  'Gemini Elf',
  'Gearfried the Iron Knight',
  'Mystical Elf',
  'Celtic Guardian',
  'Pot of Greed',
  'Graceful Charity',
  'Mystical Space Typhoon',
  'Monster Reborn',
  'Swords of Revealing Light',
];

function toKey(name, id) {
  if (legacyKeys[name]) return legacyKeys[name];
  const words = name
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const key = words
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : lower[0].toUpperCase() + lower.slice(1);
    })
    .join('');
  return /^[a-z]/.test(key) ? key : `card${id}`;
}

function normalizeCard(card) {
  const monster = card.type.includes('Monster');
  const spell = card.type === 'Spell Card';
  const image = card.card_images?.[0];
  return {
    id: String(card.id),
    key: toKey(card.name, card.id),
    name: card.name,
    cn: card.name,
    type: monster ? 'monster' : spell ? 'spell' : 'other',
    sourceType: card.type,
    frameType: card.frameType ?? null,
    level: monster && Number.isInteger(card.level) ? card.level : 0,
    atk: monster && Number.isInteger(card.atk) ? card.atk : 0,
    def: monster && Number.isInteger(card.def) ? card.def : 0,
    race: card.race ?? null,
    attribute: card.attribute ?? null,
    desc: card.desc ?? '',
    imageUrl: image?.image_url ?? null,
    imageUrlSmall: image?.image_url_small ?? null,
    imageUrlCropped: image?.image_url_cropped ?? null,
    url: card.ygoprodeck_url ?? null,
  };
}

async function loadPayload(inputPath) {
  if (inputPath) {
    return JSON.parse(await readFile(resolve(process.cwd(), inputPath), 'utf8'));
  }
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`YGOPRODeck API failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

const inputArg = process.argv.indexOf('--input');
const inputPath = inputArg === -1 ? null : process.argv[inputArg + 1];
if (inputArg !== -1 && !inputPath) throw new Error('--input requires a file path');

const payload = await loadPayload(inputPath);
const sourceCards = Array.isArray(payload) ? payload : (payload.data ?? []);
const cards = sourceCards.map(normalizeCard);
const keys = new Set();
for (const card of cards) {
  if (keys.has(card.key)) card.key = `${card.key}_${card.id}`;
  keys.add(card.key);
}

await mkdir(dirname(rawPath), { recursive: true });
await mkdir(dirname(catalogPath), { recursive: true });
if (!inputPath) {
  await writeFile(rawPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
await writeFile(
  catalogPath,
  `${JSON.stringify({ source: SOURCE_URL, count: cards.length, cards }, null, 2)}\n`,
  'utf8'
);
const starterCards = cards.filter((card) => starterNames.includes(card.name));
await writeFile(
  starterPath,
  `${JSON.stringify({ source: SOURCE_URL, count: cards.length, cards: starterCards }, null, 2)}\n`,
  'utf8'
);

console.log(`Imported ${cards.length} cards from ${inputPath ?? SOURCE_URL}`);
console.log(`Catalog: ${catalogPath}`);
console.log(`Starter data: ${starterPath} (${starterCards.length} cards)`);
