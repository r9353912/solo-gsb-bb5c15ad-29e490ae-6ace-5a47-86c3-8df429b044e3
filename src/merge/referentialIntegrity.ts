import { toPointer } from './pointer';
import { isPlainObject, type JsonValue } from './types';

/**
 * 输出阶段的「引用完整性检查」：
 * 用户为每条规则指定一个**目标对象数组**（JSON Pointer）、记录的**顶层身份字段名**
 * 与一条**引用路径**（相对每条目标记录，遵循 RFC 6901，整段 * 逐层展开数组并保留具体下标）。
 *
 * 按合并结果建立目标索引：
 * - 目标路径缺失、目标不是对象数组（含非对象元素）、记录缺少身份字段、身份类型非法
 *   （仅限字符串或有限数字，严格按类型区分，数字 1 与字符串 "1" 是两个身份）、身份重复——
 *   均作为规则错误列出（含规则序号与具体路径）；
 * - 沿引用路径取值：终点缺失或为 null 时跳过；终点必须是字符串或数字，否则报规则错误；
 *   中间路径缺失（或不可继续向下取值）、* 段遇到非数组均报规则错误；
 *   目标为空数组时没有任何引用；
 * - 终点字符串 / 数字在目标索引中按同类型查不到对应身份时，记为一条悬空引用。
 */

/** 一条引用完整性规则（由界面规则列表编译而来） */
export interface RefRule {
  /** 规则序号（在列表中的位置，自 1 起） */
  index: number;
  /** 目标对象数组的 JSON Pointer（文档根起，遵循 RFC 6901） */
  target: string;
  /** 目标记录的顶层身份字段名 */
  identity: string;
  /** 引用路径（相对每条目标记录；遵循 RFC 6901；整段 * 逐层展开数组） */
  ref: string;
}

/** 引用路径的一段：字面量段或整段 *（逐层展开数组、保留具体下标） */
export type RefSegment = { type: 'literal'; value: string } | { type: '*' };

/** 规则配置语法非法时抛出（界面就地提示，不更新有效规则） */
export class RefRuleSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefRuleSyntaxError';
  }
}

/** 严格校验 RFC 6901 转义（~ 后只能为 0 或 1），并反转义为路径段 */
function strictUnescape(raw: string): string {
  if (/~[^01]/.test(raw) || /~$/.test(raw)) {
    throw new RefRuleSyntaxError(`路径段 "${raw}" 含非法 RFC 6901 转义：~ 后只能为 0 或 1`);
  }
  return raw.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** 解析目标指针：必须以 / 开头的普通 RFC 6901 指针（无通配语义） */
export function parseTargetPointer(pointer: string): string[] {
  if (typeof pointer !== 'string' || pointer === '' || !pointer.startsWith('/')) {
    throw new RefRuleSyntaxError('目标指针必须以 / 开头（RFC 6901 JSON Pointer）');
  }
  return pointer.slice(1).split('/').map(strictUnescape);
}

/**
 * 编译引用路径：必须以 / 开头；原始段恰为 * 时为「逐层展开数组」段，
 * 其余段按 RFC 6901 转义反转义为字面量段（段内含 * 按普通字面量处理）。
 */
export function compileRefPath(pointer: string): RefSegment[] {
  if (typeof pointer !== 'string' || pointer === '' || !pointer.startsWith('/')) {
    throw new RefRuleSyntaxError('引用路径必须以 / 开头（相对每条目标记录的 RFC 6901 指针）');
  }
  return pointer.slice(1).split('/').map((raw) => {
    if (raw === '*') return { type: '*' } as RefSegment;
    return { type: 'literal', value: strictUnescape(raw) };
  });
}

/** 规则级 / 数据级错误：目标、身份或引用路径不满足约束 */
export interface RuleIssue {
  /** 规则序号（自 1 起） */
  ruleIndex: number;
  /** 具体路径：目标指针、目标项下标路径或引用展开后的具体路径 */
  pointer: string;
  message: string;
}

/** 一条悬空引用：引用终点值在目标索引中找不到同类型身份 */
export interface DanglingRef {
  /** 规则序号（自 1 起） */
  ruleIndex: number;
  /** 引用终点的具体路径（* 已展开为具体下标，遵循 RFC 6901） */
  pointer: string;
  /** 引用值（字符串或数字） */
  value: string | number;
}

/** 一次引用完整性检查结果 */
export interface IntegrityReport {
  ruleIssues: RuleIssue[];
  dangling: DanglingRef[];
}

/** 身份值：仅限字符串或有限数字（布尔 / null / 对象 / 数组均不合格） */
function isIdentity(v: JsonValue): v is string | number {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

/** 身份值展示：字符串加引号、数字不加 */
function formatIdentity(v: string | number): string {
  return typeof v === 'string' ? `"${v}"` : String(v);
}

/** 沿一个字面量段取值的结果 */
type StepResult =
  | { ok: true; value: JsonValue }
  | { ok: false; kind: 'missing' | 'nonContainer' };

function stepInto(cur: JsonValue, seg: string): StepResult {
  if (Array.isArray(cur)) {
    const idx = Number(seg);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { ok: false, kind: 'missing' };
    return { ok: true, value: cur[idx] };
  }
  if (isPlainObject(cur)) {
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { ok: false, kind: 'missing' };
    return { ok: true, value: cur[seg] };
  }
  return { ok: false, kind: 'nonContainer' };
}

/** 对单条规则执行检查，错误与悬空引用追加到报告数组 */
function checkRule(
  doc: JsonValue,
  rule: RefRule,
  targetSegs: string[],
  refSegs: RefSegment[],
  out: IntegrityReport,
): void {
  const issue = (pointer: string, message: string) =>
    out.ruleIssues.push({ ruleIndex: rule.index, pointer, message });
  const dangle = (pointer: string, value: string | number) =>
    out.dangling.push({ ruleIndex: rule.index, pointer, value });

  // —— 定位目标对象数组 ——
  let target: JsonValue | undefined = doc;
  for (const seg of targetSegs) {
    if (target === null || typeof target !== 'object') {
      target = undefined;
      break;
    }
    const step = stepInto(target as JsonValue, seg);
    if (!step.ok) {
      target = undefined;
      break;
    }
    target = step.value;
  }

  if (target === undefined) {
    issue(rule.target, '目标路径缺失：合并结果中不存在该对象数组');
    return;
  }
  if (!Array.isArray(target)) {
    issue(rule.target, '目标不是数组（规则要求目标为对象数组）');
    return;
  }

  // —— 逐元素校验身份并建立索引（字符串与数字分别建索引，严格按类型区分） ——
  const strIndex = new Map<string, number>();
  const numIndex = new Map<number, number>();
  const objectItems: { item: { [k: string]: JsonValue }; path: string[] }[] = [];

  target.forEach((raw, i) => {
    const itemPath = [...targetSegs, String(i)];
    const itemPointer = toPointer(itemPath);
    if (!isPlainObject(raw)) {
      issue(itemPointer, `目标数组第 ${i + 1} 项不是对象（目标必须是对象数组）`);
      return;
    }
    objectItems.push({ item: raw, path: itemPath });
    if (!Object.prototype.hasOwnProperty.call(raw, rule.identity)) {
      issue(itemPointer, `第 ${i + 1} 项缺少顶层身份字段 "${rule.identity}"`);
      return;
    }
    const id = raw[rule.identity];
    if (!isIdentity(id)) {
      issue(
        itemPointer,
        `第 ${i + 1} 项的身份字段 "${rule.identity}" 类型非法：仅允许字符串或数字`,
      );
      return;
    }
    const firstAt =
      typeof id === 'string' ? strIndex.get(id) : numIndex.get(id as number);
    if (firstAt !== undefined) {
      issue(itemPointer, `第 ${i + 1} 项身份 ${formatIdentity(id)} 重复（首次见于第 ${firstAt} 项）`);
      return;
    }
    if (typeof id === 'string') strIndex.set(id, i + 1);
    else numIndex.set(id, i + 1);
  });

  // 空数组自然没有记录，也就没有任何引用
  const lookup = (v: string | number): boolean =>
    typeof v === 'string' ? strIndex.has(v) : numIndex.has(v);

  /** 访问引用终点：缺失 / null 跳过；字符串数字查索引；其余报类型非法 */
  const visitEndpoint = (v: JsonValue | undefined, path: string[]) => {
    if (v === undefined || v === null) return;
    if (isIdentity(v)) {
      if (!lookup(v)) dangle(toPointer(path), v);
      return;
    }
    issue(toPointer(path), '引用终点类型非法：仅允许字符串、数字或 null（null 视为不引用）');
  };

  /** 从引用路径第 depth 段起逐层取值（支持 * 展开） */
  const walk = (cur: JsonValue | undefined, path: string[], depth: number) => {
    const seg = refSegs[depth];
    const last = depth === refSegs.length - 1;

    if (seg.type === '*') {
      if (!Array.isArray(cur)) {
        issue(
          toPointer(path),
          `引用路径的 * 段遇到非数组（实际为 ${cur === null ? 'null' : typeof cur}），无法逐层展开`,
        );
        return;
      }
      cur.forEach((v, i) => {
        const p = [...path, String(i)];
        if (last) visitEndpoint(v, p);
        else walk(v, p, depth + 1);
      });
      return;
    }

    const p = [...path, seg.value];
    const step: StepResult =
      cur === undefined ? { ok: false, kind: 'missing' } : stepInto(cur, seg.value);
    if (!step.ok) {
      // 终点缺失：跳过（不引用）；中间路径缺失 / 不可继续：报错
      if (last) return;
      if (step.kind === 'missing') {
        issue(toPointer(p), '引用路径的中间路径缺失，无法继续访问引用终点');
      } else {
        issue(toPointer(p), '引用路径中途遇到 null 或非对象 / 非数组值，无法继续访问引用终点');
      }
      return;
    }
    if (last) visitEndpoint(step.value, p);
    else walk(step.value, p, depth + 1);
  };

  for (const { item, path } of objectItems) {
    walk(item, path, 0);
  }
}

/**
 * 对合并结果执行全部规则的引用完整性检查。
 * 规则的目标指针 / 引用路径语法已在界面侧编译过；此处再次编译以容错。
 * 某条规则自身语法非法时作为规则错误列出（指针为空），不影响其他规则。
 */
export function checkReferentialIntegrity(doc: JsonValue, rules: RefRule[]): IntegrityReport {
  const report: IntegrityReport = { ruleIssues: [], dangling: [] };
  for (const rule of rules) {
    let targetSegs: string[];
    let refSegs: RefSegment[];
    try {
      targetSegs = parseTargetPointer(rule.target);
      refSegs = compileRefPath(rule.ref);
    } catch (err) {
      report.ruleIssues.push({
        ruleIndex: rule.index,
        pointer: '',
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    checkRule(doc, rule, targetSegs, refSegs, report);
  }
  return report;
}

/** 报告中是否存在任何阻断下载的错误（规则错误或悬空引用） */
export function hasIntegrityErrors(report: IntegrityReport): boolean {
  return report.ruleIssues.length > 0 || report.dangling.length > 0;
}
