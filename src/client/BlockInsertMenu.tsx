/**
 * **右键块插入菜单**（`design/editor-block-menu-redesign.md` ✓）。
 *
 * 用**宿主共享的 Menu** ✓（`@deepseek-ai/dsh-client-ui-primitives` ✓）：
 * portal 到 body、`--dsw-*` 主题色、Esc / 点外面关闭、↑↓ / Home / End 键盘行走、
 * autoFocus、窗口缩放重定位 —— 全是宿主踩过一遍的 ✓；
 * 插件这边只负责"在右键坐标上打开 / 条目从哪来 / 选中后执行"✓，不自己画菜单 ✗。
 *
 * 条目**不是手写的** ✓：`block-insert.ts` 从 Crepe 官方 `buildMenu` 快照读出
 * label / icon / onRun ✓（命令与旧斜杠菜单同源 ✓）；这里只做**分组排序 + 中文文案 + 图标着色** ✓。
 */
import { useCallback, useMemo, useRef, type ReactNode } from "react";

import { Menu, type DshMenuEntry } from "@deepseek-ai/dsh-client-ui-primitives";

import {
  BLOCK_MENU_GROUP_ORDER,
  blockMenuGroupTextKey,
  blockMenuTextKey,
  themeBlockMenuIcon,
  type BlockMenuGroupData,
} from "./block-insert.ts";

/** 菜单的屏幕坐标（= 右键落点 / ＋ 手柄右侧 ✓） */
export interface BlockInsertMenuPoint {
  x: number;
  y: number;
}

/**
 * 渲染块插入菜单 ✓。
 * @param props.open - 是否展开（宿主 Menu 受控 ✓）。
 * @param props.x - 视口 x（Menu 的 `getAnchorRect` 用它 ✓）。
 * @param props.y - 视口 y ✓。
 * @param props.groups - Crepe 分组快照（来自 `readBlockMenuGroups` ✓）。
 * @param props.t - 取文案（父组件已把 `BLOCK_MENU_LITERAL` 并进兜底字典 ✓）。
 * @param props.onSelect - 选中条目（参数 = Crepe item key ✓）。
 * @param props.onClose - Esc / 点外面 / 关闭（焦点恢复由父组件按原因决定 ✓）。
 * @returns 宿主 Menu（关闭时只渲染一个零尺寸锚点 ✓）。
 */
export function BlockInsertMenu(props: {
  open: boolean;
  x: number;
  y: number;
  groups: readonly BlockMenuGroupData[];
  t: (key: string) => string;
  onSelect: (key: string) => void;
  onClose: () => void;
}): ReactNode {
  const { x, y, groups } = props;
  /*
   * 文案函数**每次渲染都可能是新的** ✗（父组件 `makeTranslator` 的结果）⇒ **不许进依赖数组** ✗：
   * 仓库既有口径是 ref 现取 ✓（`tests/client-effect-hygiene.test.mjs` 会拦裸 `t` ✓）。
   * 菜单打开时 `groups` 是那一刻的新快照 ✓，memo 重算时会读到最新文案 ✓。
   */
  const tRef = useRef(props.t);
  tRef.current = props.t;
  /**
   * 锚点矩形 = **零尺寸，落在右键坐标上** ✓ —— 宿主的 portal 定位逻辑会把它当成
   * "紧贴锚点左下角"（`side: bottom` + 4px 间距 ✓），所以菜单就出现在指针右下方 ✓。
   * 引用要稳定 ✓：宿主把它放进定位 effect 的依赖里 ✗，每次渲染换新函数会反复重排 ✓。
   */
  const getAnchorRect = useCallback((): DOMRect => ({
    left: x, top: y, right: x, bottom: y, width: 0, height: 0, x, y,
    toJSON: () => ({ x, y, width: 0, height: 0, top: y, left: x, right: x, bottom: y }),
  }) as DOMRect, [x, y]);
  const items = useMemo<DshMenuEntry[]>(() => {
    const ordered = [...groups].sort((a, b) => {
      const left = BLOCK_MENU_GROUP_ORDER.indexOf(a.key);
      const right = BLOCK_MENU_GROUP_ORDER.indexOf(b.key);
      /* 未收录的分组（Crepe 新加 ✓）排到最后 ✓，不丢条目 ✓ */
      if (left === -1 && right === -1) return 0;
      if (left === -1) return 1;
      if (right === -1) return -1;
      return left - right;
    });
    const entries: DshMenuEntry[] = [];
    for (const group of ordered) {
      const groupKey = blockMenuGroupTextKey(group.key);
      entries.push({
        type: "label",
        id: `group-${group.key}`,
        text: groupKey === null ? group.label : tRef.current(groupKey),
      });
      for (const item of group.items) {
        const textKey = blockMenuTextKey(item.key);
        entries.push({
          id: item.key,
          label: textKey === null ? item.label : tRef.current(textKey),
          icon: (
            /*
             * 图标是 Crepe 的静态 SVG 字符串 ✓（可信、内联在插件产物里 ✓）：
             * 直接包一层 span，让宿主 `.itemIcon svg` 的 14px 尺寸生效 ✓；
             * `fill="currentColor"` 由 `themeBlockMenuIcon` 补上 ✓（暗色主题下可见 ✓）。
             */
            <span
              style={{ display: "inline-flex", width: "14px", height: "14px" }}
              dangerouslySetInnerHTML={{ __html: themeBlockMenuIcon(item.icon) }}
            />
          ),
        });
      }
    }
    return entries;
  }, [groups]);

  /*
   * **关闭时什么都不渲染** ✓（只读 / 空条目同理 ✓）。
   *
   * 为什么重要 ✗：宿主 `Menu` 的调用只该发生在**打开那一刻** ✓ ——
   * 这样即使运行环境没有提供宿主模块（例如只注入 `ImageLightbox` 替身的浏览器 E2E ✓），
   * 编辑器挂载时也**不会**因为拿 `Menu` 而抛错 ✗；最多是"右键时打不开菜单" ✓。
   * 另外宿主 Menu 关闭时也会渲染一个零尺寸锚点外壳 ⇒ 关掉就不渲染，省一层 DOM ✓。
   */
  if (!props.open || items.length === 0) return null;
  return (
    <Menu
      open
      anchor={null}
      items={items}
      portal
      autoFocus
      dense
      align="start"
      side="bottom"
      getAnchorRect={getAnchorRect}
      onSelect={props.onSelect}
      onClose={props.onClose}
    />
  );
}
