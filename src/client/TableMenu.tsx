/**
 * **表格操作菜单**（`design/table-caret-and-interaction-design.md` 第 3 节 ✓）。
 *
 * 为什么要有它：Crepe 自带的表格结构控件是**常驻的横竖辅助线 + 加号 + 行列抓手** ✗ ——
 * 用户只是准备写字，却同时看到十字线、加号、整行整列底色 ⇒ 表格被拖进"排版模式" ✓。
 * 那些控件已经由 CSS 整块撤掉（含 `pointer-events: none`，不许透明控件继续吃点击 ✗），
 * 结构操作改由这里**按需出现**：光标进了表格才出现 ✓，键盘焦点进了表格同样能发现 ✓。
 *
 * 界面约束（文档"视觉参数"✓）：
 * - 一个约 22px 的轻量按钮，图标 + `title` / `aria-label`（危险操作**写明对象** ✓）；
 * - 分组之间一条细分隔线（插行 / 插列 / 对齐 / 删除 ✓）；
 * - 当前列的对齐按钮点亮（`aria-pressed` ✓）；
 * - **按在菜单上不抢焦点** ✗：`pointerdown` 阻止默认 ⇒ 编辑器里的表格选区不被清掉 ✓
 *   （命令要作用在那个选区上 ✓）。
 */
import { Fragment, type ReactNode } from "react";

import { TABLE_MENU_ITEMS, type TableAlignment, type TableMenuAction } from "./table-menu.ts";

/** 统一的小图标外壳（16 视口 / 描边跟随文字色 ✓） */
function Icon(props: { children: ReactNode }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {props.children}
      </g>
    </svg>
  );
}

/** 动作 → 图标（行/列的形状 + 箭头 / 减号 ✓，语义由标题写清 ✓） */
const ICONS: Record<TableMenuAction, ReactNode> = {
  "row-before": (
    <Icon>
      <rect x="2" y="7.5" width="12" height="6" rx="1.2" />
      <path d="M8 5.2V1.6M8 1.6 5.9 3.7M8 1.6l2.1 2.1" />
    </Icon>
  ),
  "row-after": (
    <Icon>
      <rect x="2" y="2.5" width="12" height="6" rx="1.2" />
      <path d="M8 10.8v3.6M8 14.4l-2.1-2.1M8 14.4l2.1-2.1" />
    </Icon>
  ),
  "col-before": (
    <Icon>
      <rect x="7.5" y="2" width="6" height="12" rx="1.2" />
      <path d="M5.2 8H1.6M1.6 8l2.1-2.1M1.6 8l2.1 2.1" />
    </Icon>
  ),
  "col-after": (
    <Icon>
      <rect x="2.5" y="2" width="6" height="12" rx="1.2" />
      <path d="M10.8 8h3.6M14.4 8l-2.1-2.1M14.4 8l-2.1 2.1" />
    </Icon>
  ),
  "align-left": (
    <Icon>
      <path d="M2 3.2h12M2 6.4h7.5M2 9.6h12M2 12.8h7.5" />
    </Icon>
  ),
  "align-center": (
    <Icon>
      <path d="M2 3.2h12M4.25 6.4h7.5M2 9.6h12M4.25 12.8h7.5" />
    </Icon>
  ),
  "align-right": (
    <Icon>
      <path d="M2 3.2h12M6.5 6.4h7.5M2 9.6h12M6.5 12.8h7.5" />
    </Icon>
  ),
  "row-delete": (
    <Icon>
      <rect x="2" y="5" width="12" height="6" rx="1.2" />
      <path d="M5.6 8h4.8" />
    </Icon>
  ),
  "col-delete": (
    <Icon>
      <rect x="5" y="2" width="6" height="12" rx="1.2" />
      <path d="M8 5.6v4.8" />
    </Icon>
  ),
};

/** 只用到 `preventDefault`：不抢焦点、也不清掉表格选区 ✓ */
function blockFocusSteal(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

/**
 * 渲染菜单。
 * @param props.top - 相对正文滚动容器内容原点的纵向位置 ✓。
 * @param props.right - 同上，距右边缘 ✓。
 * @param props.alignment - 当前列对齐（点亮对应按钮 ✓）。
 * @param props.t - 取文案（宿主 locale ✓）。
 * @param props.onAction - 执行动作（调用方负责取编辑器上下文并跑命令 ✓）。
 * @returns 菜单。
 */
export function TableMenu(props: {
  top: number;
  right: number;
  alignment: TableAlignment;
  t: (key: string) => string;
  onAction: (action: TableMenuAction) => void;
}): ReactNode {
  return (
    <div
      className="kn-table-menu"
      role="toolbar"
      aria-label={props.t("tableMenuLabel")}
      /* 坐标系在内容里 ✓（跟着正文一起滚 ✓） */
      style={{ top: `${props.top}px`, right: `${props.right}px` }}
      /* 不抢焦点、也不丢表格选区 ✗（命令要作用在当前选区上 ✓） */
      onPointerDown={blockFocusSteal}
      /* 菜单自己不是正文内容 ✓（编辑器不会把按键/输入算进文档 ✓） */
      contentEditable={false}
    >
      {TABLE_MENU_ITEMS.map((item, index) => {
        const previous = index === 0 ? null : TABLE_MENU_ITEMS[index - 1];
        const active = item.alignment !== undefined && item.alignment === props.alignment;
        return (
          <Fragment key={item.id}>
            {previous !== null && previous.group !== item.group ? (
              <span className="kn-table-menu-sep" aria-hidden="true" />
            ) : null}
            <button
              type="button"
              className={`kn-table-menu-btn${item.danger === true ? " is-danger" : ""}${active ? " is-active" : ""}`}
              title={props.t(item.labelKey)}
              aria-label={props.t(item.labelKey)}
              aria-pressed={item.alignment === undefined ? undefined : active}
              onClick={() => { props.onAction(item.id); }}
            >
              {ICONS[item.id]}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
