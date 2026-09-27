import { describe, expect, it } from 'vitest';
import {
  checkReferentialIntegrity,
  compileRefPath,
  hasIntegrityErrors,
  parseTargetPointer,
  RefRuleSyntaxError,
  type RefRule,
} from './referentialIntegrity';
import type { JsonValue } from './types';

const rule = (
  target: string,
  identity: string,
  ref: string,
  index = 1,
): RefRule => ({ index, target, identity, ref });

describe('引用完整性规则语法', () => {
  it('目标指针必须是以 / 开头的合法 RFC 6901 指针', () => {
    expect(parseTargetPointer('/orders')).toEqual(['orders']);
    expect(() => parseTargetPointer('orders')).toThrow(RefRuleSyntaxError);
    expect(() => parseTargetPointer('')).toThrow(RefRuleSyntaxError);
    expect(() => parseTargetPointer('/a~x')).toThrow('RFC 6901 转义');
    expect(parseTargetPointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
  });

  it('引用路径编译：整段 * 为展开段，段内 * 为字面量', () => {
    expect(compileRefPath('/items/*/id')).toEqual([
      { type: 'literal', value: 'items' },
      { type: '*' },
      { type: 'literal', value: 'id' },
    ]);
    expect(compileRefPath('/a*')).toEqual([{ type: 'literal', value: 'a*' }]);
    expect(() => compileRefPath('x')).toThrow(RefRuleSyntaxError);
    expect(() => compileRefPath('/a~2')).toThrow('RFC 6901 转义');
  });
});

describe('引用完整性检查', () => {
  it('合法引用全部命中：引用路径相对每条目标记录，null / 缺失终点跳过', () => {
    const doc: JsonValue = {
      users: [
        { id: 'u1', managerId: 'u2' },
        { id: 'u2', managerId: null }, // 终点 null：跳过
        { id: 1 }, // 终点缺失：跳过
        { id: 2, managerId: 1 }, // 数字身份命中数字身份
      ],
    };
    const report = checkReferentialIntegrity(doc, [rule('/users', 'id', '/managerId')]);
    expect(report.ruleIssues).toEqual([]);
    expect(report.dangling).toEqual([]);
    expect(hasIntegrityErrors(report)).toBe(false);
  });

  it('悬空引用：* 逐层展开数组，错误路径保留目标项下标与具体下标', () => {
    const doc: JsonValue = {
      folders: [
        {
          id: 'f1',
          children: [{ parentId: 'f2' }, { parentId: 'f3' }],
        },
        { id: 'f2', children: [{ parentId: 'f1' }] },
      ],
    };
    const report = checkReferentialIntegrity(doc, [
      rule('/folders', 'id', '/children/*/parentId', 2),
    ]);
    expect(report.ruleIssues).toEqual([]);
    expect(report.dangling).toEqual([
      { ruleIndex: 2, pointer: '/folders/0/children/1/parentId', value: 'f3' },
    ]);
    expect(hasIntegrityErrors(report)).toBe(true);
  });

  it('数字身份与字符串身份严格区分："1" 不命中数字 1，记为悬空引用', () => {
    const doc: JsonValue = {
      users: [{ id: 1, friend: '1' }, { id: 2 }],
    };
    const report = checkReferentialIntegrity(doc, [rule('/users', 'id', '/friend')]);
    expect(report.dangling).toEqual([
      { ruleIndex: 1, pointer: '/users/0/friend', value: '1' },
    ]);
  });

  it('终点缺失或 null 跳过；布尔 / 对象 / 数组终点报规则错误', () => {
    const doc: JsonValue = {
      targets: [
        { id: 't1', ref: null },
        { id: 't2' }, // 终点缺失：跳过
        { id: 't3', ref: true },
        { id: 't4', ref: { a: 1 } },
        { id: 't5', ref: ['t1'] },
      ],
    };
    const report = checkReferentialIntegrity(doc, [rule('/targets', 'id', '/ref')]);
    // null 与缺失跳过；true / 对象 / 数组三条规则错误
    expect(report.ruleIssues.map((i) => i.pointer)).toEqual([
      '/targets/2/ref',
      '/targets/3/ref',
      '/targets/4/ref',
    ]);
    expect(report.ruleIssues.every((i) => i.message.includes('类型非法'))).toBe(true);
    expect(report.dangling).toEqual([]);
  });

  it('中间路径缺失 / 不可继续、* 遇到非数组均报规则错误并保留具体路径', () => {
    const doc: JsonValue = {
      targets: [
        {
          id: 't1',
          rows: [
            { nested: { value: 't1' } },
            { nested: 'scalar' },
            { nested: [{ value: 't1' }] },
          ],
        },
        { id: 't2' }, // 记录内没有 rows：中间路径缺失
      ],
    };
    const r1 = rule('/targets', 'id', '/rows/*/nested/missing/leaf', 1);
    const r2 = rule('/targets', 'id', '/rows/*/nested/*/value', 2);
    const report = checkReferentialIntegrity(doc, [r1, r2]);

    const r1Issues = report.ruleIssues.filter((i) => i.ruleIndex === 1);
    expect(r1Issues).toContainEqual(
      expect.objectContaining({
        ruleIndex: 1,
        pointer: '/targets/0/rows/0/nested/missing',
        message: expect.stringContaining('中间路径缺失'),
      }),
    );
    expect(r1Issues).toContainEqual(
      expect.objectContaining({
        ruleIndex: 1,
        pointer: '/targets/0/rows/1/nested/missing',
        message: expect.stringContaining('无法继续'),
      }),
    );
    expect(r1Issues).toContainEqual(
      expect.objectContaining({ ruleIndex: 1, pointer: '/targets/1/rows' }),
    );

    const r2Issues = report.ruleIssues.filter((i) => i.ruleIndex === 2);
    expect(r2Issues.map((i) => i.pointer)).toEqual(
      expect.arrayContaining(['/targets/0/rows/0/nested', '/targets/0/rows/1/nested']),
    );
    expect(
      r2Issues
        .filter((i) => i.pointer.endsWith('/nested'))
        .every((i) => i.message.includes('* 段遇到非数组')),
    ).toBe(true);
    expect(report.dangling).toEqual([]);
  });

  it('目标缺失、目标非数组、非对象元素、身份缺失 / 类型非法 / 重复分别报错', () => {
    const doc: JsonValue = {
      notArray: { a: 1 },
      // 0: 对象合法；1: 非对象；2: 缺身份字段；3: 布尔非法；4/5: 数字身份重复
      badItems: [{ id: 'ok' }, 'nope', { other: 1 }, { id: true }, { id: 1 }, { id: 1 }],
      empty: [],
    };

    expect(checkReferentialIntegrity(doc, [rule('/missing', 'id', '/x')]).ruleIssues).toEqual([
      expect.objectContaining({ pointer: '/missing', message: expect.stringContaining('缺失') }),
    ]);
    expect(checkReferentialIntegrity(doc, [rule('/notArray', 'id', '/x')]).ruleIssues).toEqual([
      expect.objectContaining({ pointer: '/notArray', message: expect.stringContaining('不是数组') }),
    ]);

    const report = checkReferentialIntegrity(doc, [rule('/badItems', 'id', '/x')]);
    expect(report.ruleIssues).toEqual([
      expect.objectContaining({ pointer: '/badItems/1', message: expect.stringContaining('不是对象') }),
      expect.objectContaining({ pointer: '/badItems/2', message: expect.stringContaining('缺少顶层身份字段') }),
      expect.objectContaining({ pointer: '/badItems/3', message: expect.stringContaining('类型非法') }),
      expect.objectContaining({ pointer: '/badItems/5', message: expect.stringContaining('重复') }),
    ]);

    // 空数组：无记录无引用，通过
    const ok = checkReferentialIntegrity(doc, [rule('/empty', 'id', '/x')]);
    expect(ok.ruleIssues).toEqual([]);
    expect(ok.dangling).toEqual([]);
  });

  it('多层 * 展开：每条悬空引用携带规则序号与完整具体路径', () => {
    const doc: JsonValue = {
      graph: [
        {
          id: 'a',
          groups: [
            { edges: [{ to: 'a' }, { to: 'b' }] },
            { edges: [{ to: 'c' }] },
          ],
        },
      ],
    };
    const report = checkReferentialIntegrity(doc, [
      rule('/graph', 'id', '/groups/*/edges/*/to', 3),
    ]);
    expect(report.ruleIssues).toEqual([]);
    expect(report.dangling).toEqual([
      { ruleIndex: 3, pointer: '/graph/0/groups/0/edges/1/to', value: 'b' },
      { ruleIndex: 3, pointer: '/graph/0/groups/1/edges/0/to', value: 'c' },
    ]);
  });
});
