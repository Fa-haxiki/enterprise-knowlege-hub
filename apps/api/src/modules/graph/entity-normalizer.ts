/**
 * 实体名规则归一化：对齐管线的第一道（也是最便宜的一道）通道。
 * 归一化名相同即视为同一实体，直接合并；不相同的再交给 embedding / LLM。
 * 规则刻意保守：只处理「确定不改变指代」的写法差异，避免把不同实体归成一个。
 */

export const ENTITY_TYPE_ZH: Record<string, string> = {
  Project: '项目',
  Supplier: '供应商',
  Person: '人员',
  Policy: '制度',
  Department: '部门',
};

/** 各类型可安全去掉的后缀（按长度降序匹配，只去一次） */
const TYPE_SUFFIXES: Record<string, string[]> = {
  Supplier: ['集团股份有限公司', '股份有限公司', '有限责任公司', '集团有限公司', '有限公司', '集团', '公司'],
  Person: ['先生', '女士', '总监', '经理', '主任', '老师', '同志', '同学', '博士', '教授'],
};

/** 去掉后不影响辨识的包裹/装饰符号 */
const DECORATION_RE = /[《》「」『』“”"'‘’()（）[\]【】<>〈〉]/g;
const TRAILING_PUNCT_RE = /[。．.,，;；:：!！?？、·-]+$/;
/** 文件名痕迹：抽取时把《03-供应商付款审批制度.pdf》这类文档标题当成实体/别名带进来 */
const FILE_NUMBER_PREFIX_RE = /^\d{1,2}\s*[-_.、．—–]\s*/;
const FILE_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|md|txt|html?)$/i;
/** 成对包裹符号：《X》/「X」/“X” → X；《X》（编号）也只取 X（编号是文号不是名字） */
const WRAPPING_PAIRS: [string, string][] = [
  ['《', '》'],
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['"', '"'],
  ['【', '】'],
  ['〈', '〉'],
];
const ONLY_PARENTHETICAL_RE = /^([（(][^（）()]*[）)])?$/;
/** 尾部短括注（主责 / 分管 / 费用部分）：是角色限定不是名字的一部分 */
const TRAILING_QUALIFIER_RE = /[（(][\u4e00-\u9fa5]{1,6}[）)]$/;

function unwrap(s: string): string {
  for (const [open, close] of WRAPPING_PAIRS) {
    if (!s.startsWith(open)) continue;
    const end = s.indexOf(close, open.length);
    if (end <= open.length) continue;
    const rest = s.slice(end + close.length).trim();
    // 闭合符号后只剩空串或一个括注（如文号）时取书名号内的名字；否则只去掉符号本身
    if (ONLY_PARENTHETICAL_RE.test(rest)) return s.slice(open.length, end).trim();
    return `${s.slice(open.length, end)}${rest}`.trim();
  }
  return s;
}

/**
 * 清洗实体表面写法（保留给人看的原文形态，仅去掉明显不属于名字的部分）：
 * 成对书名号/引号、文件编号前缀（03-）、文件扩展名（.pdf）、尾部短括注（（主责））。
 */
export function cleanEntitySurface(name: string): string {
  let s = (name ?? '').trim();
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = unwrap(s);
    s = s.replace(FILE_EXT_RE, '').replace(FILE_NUMBER_PREFIX_RE, '').replace(TRAILING_QUALIFIER_RE, '').trim();
  }
  return s;
}

/**
 * 规则归一化：NFKC（全角→半角）→ 去文件名痕迹 → 去空白/装饰符号 → 英文小写 → 按类型去后缀。
 * 返回空串表示该名称没有可辨识内容。
 */
export function normalizeEntityName(name: string, type?: string): string {
  let s = cleanEntitySurface((name ?? '').normalize('NFKC'));
  s = s.replace(DECORATION_RE, '').replace(/\s+/g, '').toLowerCase();
  s = s.replace(TRAILING_PUNCT_RE, '');
  if (!s) return '';

  if (type && TYPE_SUFFIXES[type]) {
    for (const suffix of TYPE_SUFFIXES[type]) {
      if (s.length > suffix.length + 1 && s.endsWith(suffix)) {
        s = s.slice(0, -suffix.length);
        break;
      }
    }
  }
  if (type === 'Department' && s.endsWith('部门') && s.length > 3) {
    s = `${s.slice(0, -2)}部`;
  }
  // 「星云ERP升级项目」与「星云ERP升级」同指；过短的名字（如「A项目」）不去，避免只剩一个字
  if (type === 'Project' && s.endsWith('项目') && s.length - 2 >= 4) {
    s = s.slice(0, -2);
  }
  return s;
}

function bigrams(s: string): Set<string> {
  if (s.length < 2) return new Set(s ? [s] : []);
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 字面相似度：归一化名的 bigram Dice 系数（0-1），对中文短名称比编辑距离更稳 */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ba = bigrams(a);
  const bb = bigrams(b);
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  return (2 * inter) / (ba.size + bb.size);
}

/** 一方是另一方的子串（简称 ⊂ 全称），且较短一方至少 2 个字符 */
export function isNameContained(a: string, b: string): boolean {
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 2 && long.includes(short);
}

/** 余弦相似度（向量已归一化时即点积；这里不假设归一化） */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
