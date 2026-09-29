// 导入并校验「中文卡库」，按卡片密码（passcode）匹配现有图鉴。
//
// 数据源：百鸽 ygocdb.com 的 /api/v0/cards.zip（一次性返回全部卡牌的中文
// 译名与效果文本）。每张卡含：
//   - id        8 位密码，与 YGOPRODeck 图鉴的 id 同码，可据此对齐
//   - cn_name   官方 YGOPro 简体中文名（首选）
//   - sc_name   官方 Master Duel 简体中文名（cn_name 缺失时回落）
//   - text.desc 中文效果/描述文本
//
// 产出：public/data/zh-cards.json —— { source, generated, count, cards }
//   其中 cards 是 { passcode: { name, desc } } 的精简映射，只包含现有图鉴里
//   确实存在的卡。绝不把英文 name/desc 写进中文翻译字段。
//
// 用法：
//   node scripts/import-zh-cards.mjs            # 用 .cache 里的源，没有就自动下载
//   node scripts/import-zh-cards.mjs --input x.json   # 指定已下载的 ygocdb cards.json
//   node scripts/import-zh-cards.mjs --no-download     # 禁止自动下载（仅用本地缓存）

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZH_URL = 'https://ygocdb.com/api/v0/cards.zip';
const ZH_ZIP = resolve(ROOT, '.cache/ygocdb-cards.zip');
const ZH_SOURCE = resolve(ROOT, '.cache/ygocdb/cards.json');
const CATALOG_PATH = resolve(ROOT, 'public/data/cards.catalog.json');
const OUT_PATH = resolve(ROOT, 'public/data/zh-cards.json');

const args = process.argv.slice(2);
const inputArg = args.indexOf('--input');
const inputPath = inputArg === -1 ? null : args[inputArg + 1];
const allowDownload = !args.includes('--no-download');

function pickName(entry) {
  return (entry.cn_name || entry.sc_name || '').trim();
}

function pickDesc(entry) {
  const raw = entry.text?.desc ?? '';
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

async function ensureZhSource() {
  if (inputPath) {
    if (!existsSync(inputPath)) throw new Error(`--input 指定的文件不存在: ${inputPath}`);
    return inputPath;
  }
  if (existsSync(ZH_SOURCE)) return ZH_SOURCE;
  if (!allowDownload) throw new Error('本地没有中文源且禁止下载，请用 --input 指定。');

  console.log(`下载中文卡库：${ZH_URL}`);
  const res = await fetch(ZH_URL);
  if (!res.ok) throw new Error(`ygocdb 下载失败：${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(ZH_ZIP), { recursive: true });
  await writeFile(ZH_ZIP, buf);
  console.log(`已保存到 ${ZH_ZIP}（${buf.length} 字节），解压中…`);
  execSync(`unzip -o -q "${ZH_ZIP}" -d "${dirname(ZH_SOURCE)}"`, { stdio: 'ignore' });
  return ZH_SOURCE;
}

// 纯函数：根据中文源 + 现有图鉴，生成翻译映射并给出覆盖率报告。
// 抽成纯函数便于测试，不依赖文件 IO。
export function buildTranslation(catalogCards, zhEntries) {
  const byId = new Map();
  for (const entry of zhEntries) {
    const pid = entry.id != null ? String(entry.id) : null;
    if (!pid) continue;
    byId.set(pid, entry);
  }

  const cards = {};
  let matched = 0;
  let withName = 0;
  let withDesc = 0;
  const missing = [];

  for (const c of catalogCards) {
    const pid = String(c.id);
    const zh = byId.get(pid);
    if (!zh) {
      missing.push(pid);
      continue;
    }
    matched += 1;
    const name = pickName(zh);
    const desc = pickDesc(zh);
    // 两者都为空则不写入（不伪造任何内容）
    if (!name && !desc) continue;
    cards[pid] = { name, desc };
    if (name) withName += 1;
    if (desc) withDesc += 1;
  }

  const total = catalogCards.length;
  const coverage = {
    total,
    matched,
    matchRate: matched / total,
    withName,
    withDesc,
    nameCoverage: withName / total,
    descCoverage: withDesc / total,
    missingCount: missing.length,
  };
  return { cards, coverage, missing };
}

async function main() {
  const source = await ensureZhSource();
  const zhRaw = JSON.parse(await readFile(source, 'utf8'));
  const zhEntries = Array.isArray(zhRaw) ? zhRaw : Object.values(zhRaw);
  const catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf8'));
  const catalogCards = catalog.cards;

  const { cards, coverage, missing } = buildTranslation(catalogCards, zhEntries);

  const payload = {
    source: ZH_URL,
    generated: new Date().toISOString(),
    count: Object.keys(cards).length,
    cards,
  };
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload), 'utf8');

  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  console.log('中文卡库导入完成：');
  console.log(`  图鉴总数           ${coverage.total}`);
  console.log(`  按密码命中         ${coverage.matched}（${pct(coverage.matchRate)}）`);
  console.log(`  含中文卡名         ${coverage.withName}（占图鉴 ${pct(coverage.nameCoverage)}）`);
  console.log(`  含中文效果文本     ${coverage.withDesc}（占图鉴 ${pct(coverage.descCoverage)}）`);
  console.log(`  无中文（回落英文） ${coverage.missingCount}（${pct(coverage.missingCount / coverage.total)}）`);
  console.log(`  写入 ${OUT_PATH}（${payload.count} 条）`);
  if (missing.length) {
    console.log(`  无中文的样例密码：${missing.slice(0, 12).join(', ')}`);
  }
  // 失败即报错：确保产物真实可用
  if (payload.count === 0) throw new Error('翻译数据为空，疑似数据源异常。');
}

// 直接执行脚本时才跑 main()；被测试 import 时不触发。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
