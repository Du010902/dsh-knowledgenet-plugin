/**
 * **表格操作：一个入口 + 按需弹出的菜单**
 * （`design/node-editor-design-implementation-review.md` P2 ✓）。
 *
 * 复查实测的问题：原来把九个图标按钮的 240px 工具条**常驻**铺在表格上方，
 * 按"整块容器"定位 ⇒ 短表格也被贴到容器右边，还盖住了前一段引用 ✗。
 *
 * 现在分两步：
 * - `TableEntry`：**一个约 24px 的小按钮** ✓（光标进了表格才出现 ✓，键盘也能 Tab 到 ✓）。
 *   位置由 `tableEntryPosition` 决定：优先表格右侧空白 → 表格上方空白 → 表格自己的右上角 ✓
 *   （宁可靠在表格上，也不许盖住正文 ✓）。
 * - `TableMenu`：**点开才出现**的完整动作菜单（文字 + 图标 ✓），
 *   支持 Esc 关闭并回到正文、↑/↓ 在菜单里走 ✓；选中动作后才真正执行 ✓。
 *
 * 两者都**不抢焦点** ✗：`pointerdown` 只 `preventDefault` ⇒ 编辑器里的表格选区不被清掉 ✓
 * （命令要作用在那个选区上 ✓）。
 */
import { Fragment, useEffect, useRef, type ReactNode, type RefObject } from "react";

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

/** 入口按钮的图标（一张小表格 ✓） */
const ENTRY_ICON = (
  <Icon>
    <rect x="2" y="3" width="12" height="10" rx="1.2" />
    <path d="M2 6.4h12M6.6 6.4V13" />
  </Icon>
);

/** 动作 → 图标（行/列的形状 + 箭头 / 减号 ✓，语义由文字标签写清 ✓） */
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
  /* 移动：箭头画在行 / 列**里面** ✓（与"插入"那组箭头在形状外面区分开 ✓） */
  "row-up": (
    <Icon>
      <rect x="2" y="5" width="12" height="6" rx="1.2" />
      <path d="M8 9.2V6.8M6.6 8 8 6.6 9.4 8" />
    </Icon>
  ),
  "row-down": (
    <Icon>
      <rect x="2" y="5" width="12" height="6" rx="1.2" />
      <path d="M8 6.8v2.4M6.6 8 8 9.4 9.4 8" />
    </Icon>
  ),
  "col-left": (
    <Icon>
      <rect x="5" y="2" width="6" height="12" rx="1.2" />
      <path d="M9.2 8H6.8M8 6.6 6.6 8 8 9.4" />
    </Icon>
  ),
  "col-right": (
    <Icon>
      <rect x="5" y="2" width="6" height="12" rx="1.2" />
      <path d="M6.8 8h2.4M8 6.6 9.4 8 8 9.4" />
    </Icon>
  ),
};

/** 只用到 `preventDefault`：不抢焦点、也不清掉表格选区 ✓ */
function keepSelection(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

/**
 * 表格操作**入口**（一个 24px 的小按钮 ✓）。
 *
 * 复查要求（`design/table-interaction-and-row-column-functions-review.md` P2a ✓）：
 * 入口要**看得见**（不再只靠 45% 透明的一个图标 ✗）、鼠标悬停表格或光标进入表格都能发现 ✓、
 * 只读 / 保存中**显示但禁用并说明状态** ✓。
 *
 * @param props.top - 内容坐标下的纵向位置 ✓。
 * @param props.right - 相对容器右边缘的偏移 ✓。
 * @param props.inside - 是否靠在表格右上角（供样式微调 ✓）。
 * @param props.open - 菜单是否展开（`aria-expanded` ✓）。
 * @param props.disabled - 只读 / 保存中 ⇒ 禁用 ✓。
 * @param props.hint - 悬停提示（禁用时说明状态 ✓）。
 * @param props.t - 取文案 ✓。
 * @param props.onToggle - 开/关菜单 ✓。
 * @param props.nodeRef - 把真实节点交出去 ✓：判"点的是不是菜单内部"必须按**节点引用** ✗
 *   （Shadow DOM 里 `event.target` 到 `document` 已被重定向成 host ✓，
 *   见 `design/table-menu-shadow-dom-review.md` ✓）。
 */
export function TableEntry(props: {
  top: number;
  right: number;
  inside: boolean;
  open: boolean;
  disabled: boolean;
  hint: string;
  t: (key: string) => string;
  onToggle: () => void;
  nodeRef?: RefObject<HTMLButtonElement | null> | undefined;
}): ReactNode {
  return (
    <button
      type="button"
      className={`kn-table-entry${props.inside ? " is-inside" : ""}${props.open ? " is-open" : ""}`}
      style={{ top: `${props.top}px`, right: `${props.right}px` }}
      title={props.hint}
      aria-label={props.t("tableMenuLabel")}
      aria-haspopup="menu"
      aria-expanded={props.open}
      disabled={props.disabled}
      ref={props.nodeRef}
      onPointerDown={keepSelection}
      onClick={props.onToggle}
    >
      {ENTRY_ICON}
      <span className="kn-table-entry-label">{props.t("tableMenuLabel")}</span>
    </button>
  );
}

/**
 * 表格操作**菜单**（点开才出现 ✓）。
 * @param props.top - 内容坐标下的纵向位置 ✓。
 * @param props.right - 相对容器右边缘的偏移 ✓。
 * @param props.alignment - 当前列对齐（点亮对应项 ✓）。
 * @param props.t - 取文案 ✓。
 * @param props.onAction - 执行动作 ✓。
 * @param props.onDismiss - Esc / 需要关闭（调用方负责把焦点还给正文 ✓）。
 * @param props.disabledReasons - 动不了的项 ⇒ 禁用并说明原因（边界 / 表头 / 多选或合并 ✓）。
 * @param props.nodeRef - 菜单容器的真实节点 ✓（判"点的是不是菜单内部"按引用 ✗，不看类名 ✓）。
 * @returns 弹出菜单。
 */
export function TableMenu(props: {
  top: number;
  right: number;
  alignment: TableAlignment;
  t: (key: string) => string;
  onAction: (action: TableMenuAction) => void;
  onDismiss: () => void;
  disabledReasons?: Partial<Record<TableMenuAction, string>> | undefined;
  nodeRef?: RefObject<HTMLDivElement | null> | undefined;
}): ReactNode {
  const ownRef = useRef<HTMLDivElement | null>(null);
  /* 外部要拿节点（判内部/外部点击 ✓）⇒ 用外面给的那个 ref ✗ */
  const listRef = props.nodeRef ?? ownRef;

  /*
   * **打开就把焦点放进菜单** ✓：菜单项上才有 ↓/↑/Esc 与 Enter ✓。
   * 复查验收第 4 条明确要"键盘选择能执行动作"✗ —— 只在菜单容器上挂 `onKeyDown`、
   * 焦点却留在入口按钮上，是收不到这些键的 ✓。
   * 焦点进来**不会**弄丢表格选区 ✗：ProseMirror 的选区在 state 里 ✓，动作做完会把焦点还给正文 ✓。
   */
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const first = list.querySelector<HTMLButtonElement>("button.kn-table-menu-item:not(:disabled)");
    first?.focus();
  }, [listRef]);

  /** ↑/↓ 在菜单项之间走 ✓（在 Shadow DOM 里要用**根**的 activeElement ✗） */
  const moveFocus = (delta: number): void => {
    const list = listRef.current;
    if (list === null) return;
    const items = Array.from(list.querySelectorAll("button.kn-table-menu-item:not(:disabled)")) as HTMLButtonElement[];
    if (items.length === 0) return;
    const root = list.getRootNode() as Document | ShadowRoot;
    const active = root.activeElement;
    const current = active === null ? -1 : items.indexOf(active as HTMLButtonElement);
    const next = (current + delta + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      className="kn-table-menu"
      role="menu"
      aria-label={props.t("tableMenuLabel")}
      style={{ top: `${props.top}px`, right: `${props.right}px` }}
      ref={listRef}
      /* 不抢焦点、也不丢表格选区 ✗（命令要作用在当前选区上 ✓） */
      onPointerDown={keepSelection}
      onKeyDown={(event: { key: string; preventDefault: () => void }) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onDismiss();
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveFocus(1);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(-1);
        }
      }}
      contentEditable={false}
    >
      {TABLE_MENU_ITEMS.map((item, index) => {
        const previous = index === 0 ? null : TABLE_MENU_ITEMS[index - 1];
        const active = item.alignment !== undefined && item.alignment === props.alignment;
        /* 动不了的项（边界 / 表头 / 多选或合并）⇒ 禁用 + 说明为什么 ✓ */
        const reason = props.disabledReasons?.[item.id];
        const disabled = reason !== undefined;
        const label = props.t(item.labelKey);
        return (
          <Fragment key={item.id}>
            {previous !== null && previous.group !== item.group ? (
              <span className="kn-table-menu-sep" aria-hidden="true" />
            ) : null}
            <button
              type="button"
              role="menuitem"
              className={`kn-table-menu-item${item.danger === true ? " is-danger" : ""}${active ? " is-active" : ""}${item.move === true ? " is-move" : ""}`}
              title={disabled ? `${label} · ${props.t(reason as string)}` : label}
              aria-pressed={item.alignment === undefined ? undefined : active}
              disabled={disabled}
              onClick={() => { props.onAction(item.id); }}
            >
              {ICONS[item.id]}
              <span className="kn-table-menu-label">{label}</span>
              {item.move === true && disabled ? (
                <span className="kn-table-menu-why">{props.t(reason as string)}</span>
              ) : null}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
