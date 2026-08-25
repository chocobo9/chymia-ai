import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outputDir = dirname(fileURLToPath(import.meta.url));
const scenePath = join(outputDir, 'chymia-progressive-architecture.excalidraw');
const svgPath = join(outputDir, 'chymia-progressive-architecture.svg');

let seed = 100;
let index = 0;
const elements = [];
const boundByShape = new Map();

function base(id, type, x, y, width, height, options = {}) {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: options.strokeColor ?? '#343a40',
    backgroundColor: options.backgroundColor ?? 'transparent',
    fillStyle: options.fillStyle ?? 'solid',
    strokeWidth: options.strokeWidth ?? 2,
    strokeStyle: options.strokeStyle ?? 'solid',
    roughness: options.roughness ?? 1,
    opacity: options.opacity ?? 100,
    groupIds: options.groupIds ?? [],
    frameId: null,
    index: `a${String(index++).padStart(3, '0')}`,
    roundness: type === 'rectangle' ? { type: 3 } : type === 'arrow' ? { type: 2 } : null,
    seed: seed++,
    version: 1,
    versionNonce: seed * 13,
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
  };
}

function addText(id, x, y, width, height, text, options = {}) {
  const element = {
    ...base(id, 'text', x, y, width, height, {
      strokeColor: options.color ?? '#212529',
      strokeWidth: 1,
      fillStyle: 'hachure',
      groupIds: options.groupIds ?? [],
    }),
    text,
    fontSize: options.fontSize ?? 18,
    fontFamily: options.fontFamily ?? 1,
    textAlign: options.textAlign ?? 'left',
    verticalAlign: options.verticalAlign ?? 'top',
    containerId: null,
    originalText: text,
    autoResize: false,
    lineHeight: options.lineHeight ?? 1.25,
  };
  elements.push(element);
  return element;
}

function addRect(id, x, y, width, height, options = {}) {
  const element = base(id, 'rectangle', x, y, width, height, options);
  elements.push(element);
  return element;
}

function addEllipse(id, x, y, width, height, options = {}) {
  const element = base(id, 'ellipse', x, y, width, height, options);
  elements.push(element);
  return element;
}

function bind(shapeId, arrowId) {
  const list = boundByShape.get(shapeId) ?? [];
  list.push({ id: arrowId, type: 'arrow' });
  boundByShape.set(shapeId, list);
}

function addArrow(id, x, y, points, options = {}) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const element = {
    ...base(id, 'arrow', x, y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
      strokeColor: options.color ?? '#343a40',
      strokeWidth: options.strokeWidth ?? 2,
      strokeStyle: options.strokeStyle ?? 'solid',
      roughness: options.roughness ?? 1,
    }),
    points,
    startBinding: options.startId
      ? { elementId: options.startId, focus: options.startFocus ?? 0, gap: options.startGap ?? 2 }
      : null,
    endBinding: options.endId
      ? { elementId: options.endId, focus: options.endFocus ?? 0, gap: options.endGap ?? 2 }
      : null,
    startArrowhead: options.startArrowhead ?? null,
    endArrowhead: options.endArrowhead ?? 'triangle',
    lastCommittedPoint: null,
    elbowed: false,
  };
  elements.push(element);
  if (options.startId) bind(options.startId, id);
  if (options.endId) bind(options.endId, id);
  return element;
}

function addModule({
  id,
  number,
  x,
  y,
  width,
  height,
  title,
  subtitle,
  lines,
  stroke,
  fill,
}) {
  const groupIds = [`g-${id}`];
  addRect(id, x, y, width, height, {
    strokeColor: stroke,
    backgroundColor: fill,
    strokeWidth: 3,
    groupIds,
  });
  addEllipse(`${id}-number`, x + 18, y + 18, 38, 38, {
    strokeColor: stroke,
    backgroundColor: '#ffffff',
    strokeWidth: 2,
    groupIds,
  });
  addText(`${id}-number-text`, x + 18, y + 23, 38, 28, String(number).padStart(2, '0'), {
    color: stroke,
    fontSize: 17,
    textAlign: 'center',
    groupIds,
  });
  addText(`${id}-title`, x + 68, y + 20, width - 88, 34, title, {
    color: stroke,
    fontSize: title === 'Coding Agent Runtime' ? 19 : title === 'Context Assembly' ? 21 : 23,
    groupIds,
  });
  addText(`${id}-subtitle`, x + 22, y + 70, width - 44, 25, subtitle, {
    color: '#495057',
    fontSize: 15,
    groupIds,
  });
  addText(`${id}-lines`, x + 22, y + 108, width - 44, height - 124, lines.join('\n'), {
    color: '#343a40',
    fontSize: 16,
    lineHeight: 1.35,
    groupIds,
  });
}

addText('title', 60, 38, 1080, 50, 'CHYMIA · CURRENT EXECUTION ARCHITECTURE', {
  color: '#1f3b73',
  fontSize: 34,
});
addText(
  'subtitle',
  62,
  90,
  1250,
  30,
  '一次 User Task 如何被组织成跨 Coding Agent CLI 的可控协作',
  { color: '#495057', fontSize: 18 },
);
addRect('boundary-pill', 1270, 42, 580, 72, {
  strokeColor: '#7048e8',
  backgroundColor: '#f3f0ff',
  strokeWidth: 2,
});
addText(
  'boundary-pill-text',
  1294,
  57,
  532,
  48,
  'CORE BOUNDARY\n共享协作上下文  ≠  共享 Provider 私有 Session',
  { color: '#6741d9', fontSize: 16, textAlign: 'center' },
);

addText('main-lane', 60, 150, 720, 28, 'PRIMARY FLOW · ONE TASK, ONE VISIBLE EXECUTION SPINE', {
  color: '#1f3b73',
  fontSize: 17,
});
addRect('main-frame', 45, 184, 1830, 410, {
  strokeColor: '#91a7ff',
  backgroundColor: '#f8f9ff',
  strokeWidth: 2,
  roughness: 1,
});

addModule({
  id: 'user-task',
  number: 1,
  x: 70,
  y: 245,
  width: 190,
  height: 250,
  title: 'User Task',
  subtitle: 'Web / Feishu',
  lines: ['开发目标', '目标 Agent / @all', '附件与 Project'],
  stroke: '#2b8a3e',
  fill: '#ebfbee',
});
addModule({
  id: 'thread',
  number: 2,
  x: 325,
  y: 225,
  width: 240,
  height: 290,
  title: 'Thread',
  subtitle: '协作事实入口',
  lines: ['建立同一开发目标', '持久化用户消息', '维护 participants', '所有入口复用同一路径'],
  stroke: '#1971c2',
  fill: '#e7f5ff',
});
addModule({
  id: 'routing',
  number: 3,
  x: 630,
  y: 225,
  width: 240,
  height: 290,
  title: 'Routing',
  subtitle: '确定性协作策略',
  lines: ['解析 @mention / @all', '选择可用 Agent', 'serial：前序结果交接', 'parallel：同一起始快照'],
  stroke: '#e67700',
  fill: '#fff4e6',
});
addModule({
  id: 'context',
  number: 4,
  x: 935,
  y: 205,
  width: 310,
  height: 330,
  title: 'Context Assembly',
  subtitle: '构造本次可见上下文',
  lines: [
    'Thread history',
    'Task snapshot',
    'Evidence recall',
    'smart window: burst / anchors / tombstone',
    'SOP / Skill / identity',
    'token budget → effectivePrompt',
  ],
  stroke: '#0c8599',
  fill: '#e3fafc',
});
addModule({
  id: 'runtime',
  number: 5,
  x: 1300,
  y: 205,
  width: 320,
  height: 330,
  title: 'Coding Agent Runtime',
  subtitle: '一次可控 CLI activation',
  lines: ['Invocation identity', 'Session resume + mutex', 'timeout / cancel / retry', 'Provider Adapter', 'normalize → Agent Events'],
  stroke: '#7b2cbf',
  fill: '#f3f0ff',
});
addModule({
  id: 'cli',
  number: 6,
  x: 1685,
  y: 245,
  width: 165,
  height: 250,
  title: 'Real CLI',
  subtitle: 'true external',
  lines: ['Claude', 'Codex', 'Gemini', '', 'private loop / Session'],
  stroke: '#495057',
  fill: '#f1f3f5',
});

addArrow('a-user-thread', 260, 370, [[0, 0], [65, 0]], {
  color: '#1f3b73',
  strokeWidth: 3,
  startId: 'user-task',
  endId: 'thread',
});
addArrow('a-thread-routing', 565, 370, [[0, 0], [65, 0]], {
  color: '#1f3b73',
  strokeWidth: 3,
  startId: 'thread',
  endId: 'routing',
});
addArrow('a-routing-context', 870, 370, [[0, 0], [65, 0]], {
  color: '#1f3b73',
  strokeWidth: 3,
  startId: 'routing',
  endId: 'context',
});
addArrow('a-context-runtime', 1245, 370, [[0, 0], [55, 0]], {
  color: '#1f3b73',
  strokeWidth: 3,
  startId: 'context',
  endId: 'runtime',
});
addArrow('a-runtime-cli', 1620, 370, [[0, 0], [65, 0]], {
  color: '#1f3b73',
  strokeWidth: 3,
  startId: 'runtime',
  endId: 'cli',
});

addText('label-user-thread', 264, 336, 58, 24, 'normalize', {
  color: '#1f3b73',
  fontSize: 13,
  textAlign: 'center',
});
addText('label-thread-routing', 570, 336, 55, 24, 'select', {
  color: '#1f3b73',
  fontSize: 13,
  textAlign: 'center',
});
addText('label-routing-context', 873, 329, 58, 40, 'build\nsnapshot', {
  color: '#1f3b73',
  fontSize: 13,
  textAlign: 'center',
});
addText('label-context-runtime', 1247, 336, 50, 24, 'invoke', {
  color: '#1f3b73',
  fontSize: 13,
  textAlign: 'center',
});
addText('label-runtime-cli', 1624, 329, 56, 40, 'spawn /\nresume', {
  color: '#1f3b73',
  fontSize: 13,
  textAlign: 'center',
});

addText('support-lane', 60, 625, 720, 28, 'SUPPORT LAYER · STATE, RECALL, EFFECTS, OBSERVABILITY', {
  color: '#5f3dc4',
  fontSize: 17,
});
addRect('support-frame', 45, 662, 1830, 650, {
  strokeColor: '#d0bfff',
  backgroundColor: '#fff',
  strokeWidth: 2,
  roughness: 1,
});

addRect('live-view', 70, 740, 190, 190, {
  strokeColor: '#2b8a3e',
  backgroundColor: '#ebfbee',
  strokeWidth: 2,
});
addText('live-view-title', 92, 764, 146, 30, 'Live View', {
  color: '#2b8a3e',
  fontSize: 21,
  textAlign: 'center',
});
addText('live-view-lines', 90, 814, 150, 72, 'streaming reply\nagent status\ntool progress', {
  color: '#343a40',
  fontSize: 15,
  textAlign: 'center',
  lineHeight: 1.4,
});

addRect('durable-state', 325, 720, 500, 260, {
  strokeColor: '#495057',
  backgroundColor: '#f8f9fa',
  strokeWidth: 2,
});
addText('durable-state-title', 352, 748, 446, 30, 'Durable Collaboration State · SQLite', {
  color: '#343a40',
  fontSize: 21,
});
addText(
  'durable-state-lines',
  352,
  804,
  446,
  130,
  'Thread · Message · Task\nSession · Tool Event · Audit\n\n按 Thread 重建 Context\n实时 UI 不是事实来源',
  { color: '#495057', fontSize: 16, lineHeight: 1.45 },
);

addRect('memory-module', 880, 700, 410, 520, {
  strokeColor: '#0c8599',
  backgroundColor: '#f0fdfa',
  strokeWidth: 3,
});
addText('memory-title', 908, 724, 354, 30, 'MEMORY MODULE', {
  color: '#0c8599',
  fontSize: 23,
  textAlign: 'center',
});
addText(
  'memory-subtitle',
  908,
  764,
  354,
  28,
  '跨调用可检索的共享 Evidence；不是 Provider Session',
  { color: '#0c8599', fontSize: 14, textAlign: 'center' },
);
addRect('memory-store', 910, 810, 350, 105, {
  strokeColor: '#0c8599',
  backgroundColor: '#e3fafc',
  strokeWidth: 2,
});
addText('memory-store-title', 930, 828, 310, 28, '1 · STORE', {
  color: '#0c8599',
  fontSize: 19,
  textAlign: 'center',
});
addText(
  'memory-store-lines',
  930,
  865,
  310,
  38,
  'EvidenceItem · provenance\nentity / edge · optional vector',
  { color: '#343a40', fontSize: 14, textAlign: 'center', lineHeight: 1.35 },
);
addRect('memory-search', 910, 945, 350, 115, {
  strokeColor: '#0c8599',
  backgroundColor: '#e3fafc',
  strokeWidth: 2,
});
addText('memory-search-title', 930, 962, 310, 28, '2 · RETRIEVE & RANK', {
  color: '#0c8599',
  fontSize: 19,
  textAlign: 'center',
});
addText(
  'memory-search-lines',
  930,
  998,
  310,
  52,
  'jieba + FTS5 / BM25 · vector KNN\nRRF fusion · lexical fallback',
  { color: '#343a40', fontSize: 14, textAlign: 'center', lineHeight: 1.4 },
);
addRect('memory-recall', 910, 1090, 350, 105, {
  strokeColor: '#0c8599',
  backgroundColor: '#e3fafc',
  strokeWidth: 2,
});
addText('memory-recall-title', 930, 1108, 310, 28, '3 · BOUNDED RECALL', {
  color: '#0c8599',
  fontSize: 19,
  textAlign: 'center',
});
addText(
  'memory-recall-lines',
  930,
  1144,
  310,
  38,
  'query from current turn · hit limit\ntimeout · fail-open',
  { color: '#343a40', fontSize: 14, textAlign: 'center', lineHeight: 1.35 },
);

addRect('events', 1340, 720, 300, 240, {
  strokeColor: '#7b2cbf',
  backgroundColor: '#f3f0ff',
  strokeWidth: 2,
});
addText('events-title', 1360, 748, 260, 30, 'Unified Agent Events', {
  color: '#7b2cbf',
  fontSize: 21,
  textAlign: 'center',
});
addText(
  'events-lines',
  1360,
  804,
  260,
  122,
  'text · thinking\ntool_use · tool_result\nerror · done\n\n→ UI projection\n→ tool / audit records',
  { color: '#343a40', fontSize: 16, textAlign: 'center', lineHeight: 1.45 },
);

addRect('local-effects', 1685, 740, 165, 220, {
  strokeColor: '#495057',
  backgroundColor: '#f1f3f5',
  strokeWidth: 2,
});
addText('local-effects-title', 1700, 764, 135, 54, 'Local Project\n& Tools', {
  color: '#495057',
  fontSize: 19,
  textAlign: 'center',
});
addText('local-effects-lines', 1700, 842, 135, 76, 'source files\nshell / tests\nCLI-native tools', {
  color: '#343a40',
  fontSize: 14,
  textAlign: 'center',
  lineHeight: 1.45,
});

addArrow('a-thread-state', 445, 515, [[0, 0], [0, 205]], {
  color: '#495057',
  strokeWidth: 2,
  strokeStyle: 'dashed',
  startId: 'thread',
  endId: 'durable-state',
});
addText('label-thread-state', 454, 608, 95, 26, 'append facts', {
  color: '#495057',
  fontSize: 13,
});
addArrow('a-memory-store-search', 1085, 915, [[0, 0], [0, 30]], {
  color: '#0c8599',
  strokeWidth: 2,
  startId: 'memory-store',
  endId: 'memory-search',
});
addArrow('a-memory-search-recall', 1085, 1060, [[0, 0], [0, 30]], {
  color: '#0c8599',
  strokeWidth: 2,
  startId: 'memory-search',
  endId: 'memory-recall',
});
addArrow('a-memory-context', 1260, 1142, [[0, 0], [28, 0], [28, -572], [-115, -607]], {
  color: '#0c8599',
  strokeWidth: 3,
  startId: 'memory-recall',
  endId: 'context',
});
addText('label-memory-context', 1298, 618, 108, 26, 'inject evidence', {
  color: '#0c8599',
  fontSize: 13,
});
addArrow('a-runtime-events', 1460, 535, [[0, 0], [0, 185]], {
  color: '#7b2cbf',
  strokeWidth: 2,
  startId: 'runtime',
  endId: 'events',
});
addText('label-runtime-events', 1471, 622, 112, 26, 'normalized stream', {
  color: '#7b2cbf',
  fontSize: 13,
});
addArrow('a-cli-effects', 1768, 495, [[0, 0], [0, 245]], {
  color: '#495057',
  strokeWidth: 2,
  startId: 'cli',
  endId: 'local-effects',
});
addText('label-cli-effects', 1778, 632, 78, 38, 'real side\neffects', {
  color: '#495057',
  fontSize: 13,
});
addArrow('a-events-live', 1340, 910, [[0, 0], [0, 350], [-1080, 0], [0, -330]], {
  color: '#2b8a3e',
  strokeWidth: 2,
  strokeStyle: 'dashed',
  startId: 'events',
  endId: 'live-view',
});
addText('label-events-live', 602, 1262, 220, 26, 'Socket projection back to Web / Feishu', {
  color: '#2b8a3e',
  fontSize: 13,
  textAlign: 'center',
});

addText(
  'footer',
  60,
  1350,
  1770,
  48,
  'READING ORDER  →  主链只回答“任务如何执行”；支撑层只回答“上下文从哪里来、状态存在哪里、事件如何返回”。',
  { color: '#495057', fontSize: 16, textAlign: 'center' },
);

for (const element of elements) {
  if (boundByShape.has(element.id)) element.boundElements = boundByShape.get(element.id);
}

const scene = {
  type: 'excalidraw',
  version: 2,
  source: 'https://excalidraw.com',
  elements,
  appState: {
    gridSize: null,
    gridStep: 5,
    viewBackgroundColor: '#fffefb',
    zoom: { value: 0.67 },
    scrollX: 0,
    scrollY: 0,
  },
  files: {},
};

const esc = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1400" viewBox="0 0 1920 1400" role="img" aria-labelledby="title desc">
  <title id="title">Chymia current execution architecture</title>
  <desc id="desc">A progressive architecture diagram showing one user task moving through Thread, Routing, Context Assembly, Coding Agent Runtime and real Coding Agent CLIs, with state, memory, events and local effects as supporting layers.</desc>
  <defs>
    <marker id="arrow-main" markerWidth="11" markerHeight="11" refX="10" refY="5.5" orient="auto"><path d="M0,0 L10,5.5 L0,11" fill="none" stroke="#1f3b73" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></marker>
    <marker id="arrow-gray" markerWidth="11" markerHeight="11" refX="10" refY="5.5" orient="auto"><path d="M0,0 L10,5.5 L0,11" fill="none" stroke="#495057" stroke-width="2"/></marker>
    <marker id="arrow-teal" markerWidth="11" markerHeight="11" refX="10" refY="5.5" orient="auto"><path d="M0,0 L10,5.5 L0,11" fill="none" stroke="#0c8599" stroke-width="2"/></marker>
    <marker id="arrow-purple" markerWidth="11" markerHeight="11" refX="10" refY="5.5" orient="auto"><path d="M0,0 L10,5.5 L0,11" fill="none" stroke="#7b2cbf" stroke-width="2"/></marker>
    <marker id="arrow-green" markerWidth="11" markerHeight="11" refX="10" refY="5.5" orient="auto"><path d="M0,0 L10,5.5 L0,11" fill="none" stroke="#2b8a3e" stroke-width="2"/></marker>
    <style>
      text { font-family: "Segoe Print", "Comic Sans MS", "Microsoft YaHei", "PingFang SC", sans-serif; }
      .title { font: 700 34px "Cascadia Mono", "Microsoft YaHei", sans-serif; fill:#1f3b73; }
      .subtitle { font: 18px "Microsoft YaHei", sans-serif; fill:#495057; }
      .lane { font: 700 17px "Cascadia Mono", "Microsoft YaHei", sans-serif; letter-spacing:.8px; }
      .module-title { font-weight:700; }
      .module-sub { font:15px "Microsoft YaHei", sans-serif; fill:#495057; }
      .body { font:16px "Microsoft YaHei", sans-serif; fill:#343a40; }
      .small { font:13px "Microsoft YaHei", sans-serif; }
      .support-title { font-size:21px; font-weight:700; }
      .wire { fill:none; stroke-linecap:round; stroke-linejoin:round; }
      .dash { stroke-dasharray:8 8; }
    </style>
  </defs>
  <rect width="1920" height="1080" fill="#fffefb"/>
  <text x="60" y="70" class="title">CHYMIA · CURRENT EXECUTION ARCHITECTURE</text>
  <text x="62" y="108" class="subtitle">一次 User Task 如何被组织成跨 Coding Agent CLI 的可控协作</text>
  <rect x="1270" y="42" width="580" height="72" rx="18" fill="#f3f0ff" stroke="#7048e8" stroke-width="2.2"/>
  <text x="1560" y="68" text-anchor="middle" font-size="15" font-weight="700" fill="#6741d9">CORE BOUNDARY</text>
  <text x="1560" y="94" text-anchor="middle" font-size="16" fill="#6741d9">共享协作上下文  ≠  共享 Provider 私有 Session</text>

  <text x="60" y="172" class="lane" fill="#1f3b73">PRIMARY FLOW · ONE TASK, ONE VISIBLE EXECUTION SPINE</text>
  <rect x="45" y="184" width="1830" height="410" rx="28" fill="#f8f9ff" stroke="#91a7ff" stroke-width="2.2"/>

  ${[
    ['70','245','190','250','#2b8a3e','#ebfbee','01','User Task','Web / Feishu',['开发目标','目标 Agent / @all','附件与 Project']],
    ['325','225','240','290','#1971c2','#e7f5ff','02','Thread','协作事实入口',['建立同一开发目标','持久化用户消息','维护 participants','所有入口复用同一路径']],
    ['630','225','240','290','#e67700','#fff4e6','03','Routing','确定性协作策略',['解析 @mention / @all','选择可用 Agent','serial：前序结果交接','parallel：同一起始快照']],
    ['935','205','310','330','#0c8599','#e3fafc','04','Context Assembly','构造本次可见上下文',['Thread history','Task snapshot','Evidence recall','smart window: burst / anchors / tombstone','SOP / Skill / identity','token budget → effectivePrompt']],
    ['1300','205','320','330','#7b2cbf','#f3f0ff','05','Coding Agent Runtime','一次可控 CLI activation',['Invocation identity','Session resume + mutex','timeout / cancel / retry','Provider Adapter','normalize → Agent Events']],
    ['1685','245','165','250','#495057','#f1f3f5','06','Real CLI','true external',['Claude','Codex','Gemini','','private loop / Session']],
  ].map(([x,y,w,h,stroke,fill,n,titleText,sub,lines]) => {
    const titleSize = titleText === 'Coding Agent Runtime' ? 19 : titleText === 'Context Assembly' ? 21 : titleText === 'Real CLI' ? 21 : 23;
    const lineStart = Number(y) + 124;
    return `<g>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20" fill="${fill}" stroke="${stroke}" stroke-width="3"/>
      <ellipse cx="${Number(x)+37}" cy="${Number(y)+37}" rx="19" ry="19" fill="#fff" stroke="${stroke}" stroke-width="2"/>
      <text x="${Number(x)+37}" y="${Number(y)+43}" text-anchor="middle" font-size="16" font-weight="700" fill="${stroke}">${n}</text>
      <text x="${Number(x)+68}" y="${Number(y)+45}" class="module-title" fill="${stroke}" font-size="${titleSize}">${esc(titleText)}</text>
      <text x="${Number(x)+22}" y="${Number(y)+91}" class="module-sub">${esc(sub)}</text>
      ${lines.map((line, i) => `<text x="${Number(x)+22}" y="${lineStart+i*28}" class="body">${esc(line)}</text>`).join('')}
    </g>`;
  }).join('')}

  <path d="M260 370 L325 370" class="wire" stroke="#1f3b73" stroke-width="3" marker-end="url(#arrow-main)"/>
  <path d="M565 370 L630 370" class="wire" stroke="#1f3b73" stroke-width="3" marker-end="url(#arrow-main)"/>
  <path d="M870 370 L935 370" class="wire" stroke="#1f3b73" stroke-width="3" marker-end="url(#arrow-main)"/>
  <path d="M1245 370 L1300 370" class="wire" stroke="#1f3b73" stroke-width="3" marker-end="url(#arrow-main)"/>
  <path d="M1620 370 L1685 370" class="wire" stroke="#1f3b73" stroke-width="3" marker-end="url(#arrow-main)"/>
  <text x="292" y="350" text-anchor="middle" class="small" fill="#1f3b73">normalize</text>
  <text x="598" y="350" text-anchor="middle" class="small" fill="#1f3b73">select</text>
  <text x="902" y="337" text-anchor="middle" class="small" fill="#1f3b73">build</text>
  <text x="902" y="353" text-anchor="middle" class="small" fill="#1f3b73">snapshot</text>
  <text x="1272" y="350" text-anchor="middle" class="small" fill="#1f3b73">invoke</text>
  <text x="1652" y="337" text-anchor="middle" class="small" fill="#1f3b73">spawn /</text>
  <text x="1652" y="353" text-anchor="middle" class="small" fill="#1f3b73">resume</text>

  <text x="60" y="647" class="lane" fill="#5f3dc4">SUPPORT LAYER · STATE, RECALL, EFFECTS, OBSERVABILITY</text>
  <rect x="45" y="662" width="1830" height="650" rx="28" fill="#ffffff" stroke="#d0bfff" stroke-width="2.2"/>

  <rect x="70" y="740" width="190" height="190" rx="18" fill="#ebfbee" stroke="#2b8a3e" stroke-width="2.2"/>
  <text x="165" y="778" text-anchor="middle" class="support-title" fill="#2b8a3e">Live View</text>
  <text x="165" y="827" text-anchor="middle" class="body">streaming reply</text>
  <text x="165" y="853" text-anchor="middle" class="body">agent status</text>
  <text x="165" y="879" text-anchor="middle" class="body">tool progress</text>

  <rect x="325" y="720" width="500" height="260" rx="18" fill="#f8f9fa" stroke="#495057" stroke-width="2.2"/>
  <text x="352" y="762" class="support-title" fill="#343a40">Durable Collaboration State · SQLite</text>
  <text x="352" y="818" class="body">Thread · Message · Task</text>
  <text x="352" y="846" class="body">Session · Tool Event · Audit</text>
  <text x="352" y="890" class="body">按 Thread 重建 Context</text>
  <text x="352" y="918" class="body">实时 UI 不是事实来源</text>

  <rect x="880" y="700" width="410" height="520" rx="22" fill="#f0fdfa" stroke="#0c8599" stroke-width="3"/>
  <text x="1085" y="742" text-anchor="middle" font-size="23" font-weight="700" fill="#0c8599">MEMORY MODULE</text>
  <text x="1085" y="780" text-anchor="middle" class="small" fill="#0c8599">跨调用可检索的共享 Evidence；不是 Provider Session</text>

  <rect x="910" y="810" width="350" height="105" rx="15" fill="#e3fafc" stroke="#0c8599" stroke-width="2"/>
  <text x="1085" y="844" text-anchor="middle" font-size="19" font-weight="700" fill="#0c8599">1 · STORE</text>
  <text x="1085" y="878" text-anchor="middle" font-size="14" fill="#343a40">EvidenceItem · provenance</text>
  <text x="1085" y="899" text-anchor="middle" font-size="14" fill="#343a40">entity / edge · optional vector</text>

  <rect x="910" y="945" width="350" height="115" rx="15" fill="#e3fafc" stroke="#0c8599" stroke-width="2"/>
  <text x="1085" y="979" text-anchor="middle" font-size="19" font-weight="700" fill="#0c8599">2 · RETRIEVE &amp; RANK</text>
  <text x="1085" y="1015" text-anchor="middle" font-size="14" fill="#343a40">jieba + FTS5 / BM25 · vector KNN</text>
  <text x="1085" y="1039" text-anchor="middle" font-size="14" fill="#343a40">RRF fusion · lexical fallback</text>

  <rect x="910" y="1090" width="350" height="105" rx="15" fill="#e3fafc" stroke="#0c8599" stroke-width="2"/>
  <text x="1085" y="1124" text-anchor="middle" font-size="19" font-weight="700" fill="#0c8599">3 · BOUNDED RECALL</text>
  <text x="1085" y="1157" text-anchor="middle" font-size="14" fill="#343a40">query from current turn · hit limit</text>
  <text x="1085" y="1178" text-anchor="middle" font-size="14" fill="#343a40">timeout · fail-open</text>

  <path d="M1085 915 L1085 945" class="wire" stroke="#0c8599" stroke-width="2" marker-end="url(#arrow-teal)"/>
  <path d="M1085 1060 L1085 1090" class="wire" stroke="#0c8599" stroke-width="2" marker-end="url(#arrow-teal)"/>

  <rect x="1340" y="720" width="300" height="240" rx="18" fill="#f3f0ff" stroke="#7b2cbf" stroke-width="2.2"/>
  <text x="1490" y="762" text-anchor="middle" class="support-title" fill="#7b2cbf">Unified Agent Events</text>
  <text x="1490" y="812" text-anchor="middle" class="body">text · thinking</text>
  <text x="1490" y="840" text-anchor="middle" class="body">tool_use · tool_result</text>
  <text x="1490" y="868" text-anchor="middle" class="body">error · done</text>
  <text x="1490" y="908" text-anchor="middle" class="body">→ UI projection</text>
  <text x="1490" y="936" text-anchor="middle" class="body">→ tool / audit records</text>

  <rect x="1685" y="740" width="165" height="220" rx="18" fill="#f1f3f5" stroke="#495057" stroke-width="2.2"/>
  <text x="1767" y="782" text-anchor="middle" class="support-title" fill="#495057">Local Project</text>
  <text x="1767" y="808" text-anchor="middle" class="support-title" fill="#495057">&amp; Tools</text>
  <text x="1767" y="858" text-anchor="middle" class="body">source files</text>
  <text x="1767" y="884" text-anchor="middle" class="body">shell / tests</text>
  <text x="1767" y="910" text-anchor="middle" class="body">CLI-native tools</text>

  <path d="M445 515 L445 720" class="wire dash" stroke="#495057" stroke-width="2" marker-end="url(#arrow-gray)"/>
  <text x="458" y="626" class="small" fill="#495057">append facts</text>
  <path d="M1260 1142 L1288 1142 L1288 570 L1150 535" class="wire" stroke="#0c8599" stroke-width="3" marker-end="url(#arrow-teal)"/>
  <text x="1300" y="620" class="small" fill="#0c8599">inject evidence</text>
  <path d="M1460 535 L1460 720" class="wire" stroke="#7b2cbf" stroke-width="2" marker-end="url(#arrow-purple)"/>
  <text x="1473" y="628" class="small" fill="#7b2cbf">normalized stream</text>
  <path d="M1767 495 L1767 740" class="wire" stroke="#495057" stroke-width="2" marker-end="url(#arrow-gray)"/>
  <text x="1780" y="648" class="small" fill="#495057">real side effects</text>

  <path d="M1340 910 L1340 1260 L260 1260 L260 860" class="wire dash" stroke="#2b8a3e" stroke-width="2" marker-end="url(#arrow-green)"/>
  <text x="720" y="1282" text-anchor="middle" class="small" fill="#2b8a3e">Socket projection back to Web / Feishu</text>

  <text x="960" y="1362" text-anchor="middle" class="subtitle">READING ORDER  →  主链回答“任务如何执行”；支撑层回答“上下文从哪里来、状态存在哪里、事件如何返回”。</text>
</svg>`;

writeFileSync(scenePath, `${JSON.stringify(scene, null, 2)}\n`, 'utf8');
writeFileSync(svgPath, svg, 'utf8');

console.log(scenePath);
console.log(svgPath);
