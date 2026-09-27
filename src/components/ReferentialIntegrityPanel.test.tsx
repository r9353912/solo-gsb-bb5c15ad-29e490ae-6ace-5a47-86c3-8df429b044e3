// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import OutputStage from './OutputStage';
import { diff } from '../merge/rfc6902';
import { threeWayMerge } from '../merge/threeWayMerge';
import type { JsonValue } from '../merge/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeRenderer(container: HTMLElement) {
  const root = createRoot(container);
  return (node: ReactElement) => act(() => root.render(node));
}

const h = (container: HTMLElement, sel: string) => container.querySelector(sel);
const all = (container: HTMLElement, sel: string) => [...container.querySelectorAll(sel)];
const btnByText = (container: HTMLElement, text: string) =>
  all(container, 'button').find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

/** React 受控输入：原生 setter 赋值后派发 input 事件 */
function setValue(el: Element | null, v: string) {
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * users：自引用 managerId（u1→u2 合法；u3→uX 悬空）
 */
const MERGED: JsonValue = {
  users: [
    { id: 'u1', managerId: 'u2' },
    { id: 'u2' },
    { id: 'u3', managerId: 'uX' },
  ],
};

function stageProps() {
  return {
    base: { users: [] } as unknown as JsonValue,
    merged: MERGED,
    patch: diff({ users: [] } as unknown as JsonValue, MERGED),
    mergeResult: threeWayMerge({ users: [] } as unknown as JsonValue, MERGED, { users: [] } as unknown as JsonValue),
    resolutions: {},
    schemaEnabled: false,
    schema: null,
    onSchemaEnabledChange: () => {},
    onSchemaChange: () => {},
    protectedConfig: '',
    onProtectedConfigChange: () => {},
    onBack: () => {},
    onRestart: () => {},
  };
}

function setup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let enabled = false;
  let rules = [] as Parameters<typeof OutputStage>[0]['refRules'];
  const render = makeRenderer(container);
  const rerender = () =>
    render(
      <OutputStage
        {...stageProps()}
        refEnabled={enabled}
        onRefEnabledChange={(v) => {
          enabled = v;
          rerender();
        }}
        refRules={rules}
        onRefRulesChange={(r) => {
          rules = r;
          rerender();
        }}
      />,
    );
  // 全新 root 的首次挂载在当前 jsdom act 环境下需嵌套一层 act 以完成异步 flush
  act(() => {
    rerender();
  });
  // 页面上受保护路径面板也有「应用规则 / 清空」按钮，所有查询都限定在引用完整性面板内
  const panel = () => h(container, '.ri-panel') as HTMLElement;
  return {
    container,
    panel,
    rerender,
    setEnabled: (v: boolean) => {
      enabled = v;
      rerender();
    },
    setRules: (r: typeof rules) => {
      rules = r;
      rerender();
    },
    getRules: () => rules,
    applyBtn: () =>
      all(panel(), 'button').find((b) => b.textContent?.includes('应用规则')) as HTMLButtonElement,
  };
}

const mergedDownloadBtn = (c: HTMLElement) => btnByText(c, '下载 merged.json')!;
const patchDownloadBtn = (c: HTMLElement) => btnByText(c, '下载 patch.json')!;

describe('引用完整性检查（OutputStage 集成）', () => {
  it('默认关闭不影响下载；开启后无规则也不限制', () => {
    const { container } = setup();
    expect(h(container, '.ri-panel')?.textContent).toContain('引用完整性检查');
    expect(h(container, '.ri-rule-list')).toBeNull();
    expect(mergedDownloadBtn(container).disabled).toBe(false);

    act(() => (h(container, '.ri-toggle input') as HTMLInputElement).click());
    expect(h(container, '.ri-rule-list')).not.toBeNull();
    expect(h(container, '.ri-summary.none')?.textContent).toContain('未配置引用规则');
    expect(mergedDownloadBtn(container).disabled).toBe(false);
  });

  it('应用规则后列出悬空引用（规则序号 + 具体路径 + 值），禁用两个下载；修正后恢复', () => {
    const { container, panel, applyBtn } = setup();
    act(() => (h(container, '.ri-toggle input') as HTMLInputElement).click());

    const rows = () => all(panel(), '.ri-rule-row:not(.ri-rule-head)');
    act(() => setValue(rows()[0].querySelector('.ri-col-target')!, '/users'));
    act(() => setValue(rows()[0].querySelector('.ri-col-id')!, 'id'));
    act(() => setValue(rows()[0].querySelector('.ri-col-ref')!, '/managerId'));
    act(() => applyBtn().click());

    // 一条悬空引用：/users/2/managerId = "uX"（无规则错误，只有悬空引用分组）
    const dangling = h(panel(), '.ri-issue-group')!;
    expect(dangling.querySelector('.ri-issue-title')?.textContent).toContain('悬空引用（1）');
    const item = dangling.querySelector('.ri-issue-item')!;
    expect(item.querySelector('.ri-rule-tag')?.textContent).toBe('#1');
    expect(item.querySelector('.ri-issue-path')?.textContent).toBe('/users/2/managerId');
    expect(item.querySelector('.ri-issue-msg')?.textContent).toContain('"uX"');
    expect(h(panel(), '.ri-summary.bad')?.textContent).toContain('悬空引用 1');

    // 两个下载均禁用并给出警示
    expect(mergedDownloadBtn(container).disabled).toBe(true);
    expect(patchDownloadBtn(container).disabled).toBe(true);
    expect(all(container, '.download-warn').some((w) => w.textContent?.includes('引用完整性检查未通过'))).toBe(true);

    // 修正引用路径：换成恒命中的 /id（每个记录 id 指向自身）→ 重新检查通过
    act(() => setValue(rows()[0].querySelector('.ri-col-ref')!, '/id'));
    act(() => applyBtn().click());
    expect(h(panel(), '.ri-summary.ok')).not.toBeNull();
    expect(mergedDownloadBtn(container).disabled).toBe(false);
    expect(patchDownloadBtn(container).disabled).toBe(false);
  });

  it('非法规则行就地报错且不更新有效规则（沿用旧规则，仍阻断）', () => {
    const { container, panel, applyBtn, getRules } = setup();
    act(() => (h(container, '.ri-toggle input') as HTMLInputElement).click());

    // 先应用一条会产生悬空引用的规则
    const rows0 = all(panel(), '.ri-rule-row:not(.ri-rule-head)');
    act(() => setValue(rows0[0].querySelector('.ri-col-target')!, '/users'));
    act(() => setValue(rows0[0].querySelector('.ri-col-id')!, 'id'));
    act(() => setValue(rows0[0].querySelector('.ri-col-ref')!, '/managerId'));
    act(() => applyBtn().click());
    expect(mergedDownloadBtn(container).disabled).toBe(true);
    expect(getRules()).toHaveLength(1);

    // 改成非法目标指针并点应用：就地报错，有效规则不变
    act(() => setValue(rows0[0].querySelector('.ri-col-target')!, 'not-a-pointer'));
    act(() => applyBtn().click());
    expect(h(panel(), '.ri-row-error')?.textContent).toContain('必须以 / 开头');
    expect(h(panel(), '.ri-status.bad')?.textContent).toContain('非法规则行');
    expect(getRules()).toHaveLength(1);
    // 旧规则仍生效，下载继续禁用
    expect(mergedDownloadBtn(container).disabled).toBe(true);
  });

  it('规则在返回调整重新生成后保留；重新开始（App 清空）即恢复不限制', () => {
    const { container, panel, applyBtn, setEnabled, setRules } = setup();
    act(() => (h(container, '.ri-toggle input') as HTMLInputElement).click());
    const rows0 = all(panel(), '.ri-rule-row:not(.ri-rule-head)');
    act(() => setValue(rows0[0].querySelector('.ri-col-target')!, '/users'));
    act(() => setValue(rows0[0].querySelector('.ri-col-id')!, 'id'));
    act(() => setValue(rows0[0].querySelector('.ri-col-ref')!, '/id'));
    act(() => applyBtn().click());
    expect(h(panel(), '.ri-summary.ok')).not.toBeNull();

    // 模拟「返回继续调整 → 重新生成结果」：OutputStage 重挂载，开关与规则仍由 App 持有
    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    const render2 = makeRenderer(c2);
    act(() => {
      render2(
        <OutputStage
          {...stageProps()}
          refEnabled
          onRefEnabledChange={() => {}}
          refRules={[{ index: 1, target: '/users', identity: 'id', ref: '/id' }]}
          onRefRulesChange={() => {}}
        />,
      );
    });
    expect(h(c2, '.ri-summary.ok')).not.toBeNull();

    // App「重新开始」清空规则与开关：面板收起、下载不再受限
    act(() => setEnabled(false));
    act(() => setRules([]));
    expect(h(container, '.ri-rule-list')).toBeNull();
    expect(mergedDownloadBtn(container).disabled).toBe(false);
  });
});
