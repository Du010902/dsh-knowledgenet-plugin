/**
 * **宿主基线模块的最小类型声明** ✓
 *
 * 本插件不把 `@deepseek-ai/dsh-client-ui-primitives` 装进自己的 `node_modules` ✗ ——
 * 它由**宿主模块表**提供 ✓（`packages/client/web/src/seed.ts` 的冻结表 ✓，
 * 构建侧 `build.mjs` 的 `CLIENT_BASELINE` 也把它列为 external ✓）。
 *
 * 为什么需要这个文件 ✗：插件仓库里没有这个包的 `types` ✓（那是宿主的东西 ✓），
 * 而 TS 解析裸模块名要有声明 ✓。这里只声明我们**真正用到**的那几个导出 ✓，
 * 形状照抄宿主源码 ✓（`packages/client/ui-primitives/src/ImageLightbox.tsx` ✓）。
 */

declare module "@deepseek-ai/dsh-client-ui-primitives" {
  /** `ImageLightbox` 需要调用方给的两条文案 ✓（宿主自己不持有语言 ✓） */
  export interface ImageLightboxLabels {
    /** 预览对话框的无障碍名称 ✓ */
    dialog: string;
    /** 关闭按钮的无障碍名称 ✓ */
    close: string;
  }

  /**
   * 宿主共享的**原图预览**（点缩略图 / 正文图片时铺开的那一层 ✓）。
   *
   * 这里只关心插件的调用契约 ✓（`src` / `alt` / `labels` / `onClose` ✓）：
   * Esc、点遮罩、× 关闭、焦点还原、`--dsh-frame-chrome-top` 避开 Windows 标题栏，
   * 都是宿主组件自己的事 ✓；返回类型写 `any` 是为了不引入 React 类型依赖 ✓
   * （本仓库的 `tsconfig` 没有 `@types/react` ✓）。
   */
  export function ImageLightbox(props: {
    src: string;
    alt: string;
    labels: ImageLightboxLabels;
    onClose: () => void;
  }): any;

  /*
   * **宿主共享的 Menu** ✓（`packages/client/ui-primitives/src/Menu.tsx` ✓）。
   *
   * 本插件只用到"在视口坐标弹一个受控菜单"这一种形态 ✓：`portal` + `getAnchorRect` ✓。
   * 声明照抄宿主当前实现（安装包 0.2.1-rc.2 的 primitives 导出核对过 ✓），
   * 类型里出现 `any` 是为了不引入 React 类型依赖 ✓（本仓库 tsconfig 没有 @types/react ✓）。
   */
  export interface DshMenuShortcut {
    keys: readonly string[];
    aria?: string | undefined;
  }

  /** 一个可选条目 ✓（`label` / `icon` 是 ReactNode ✓） */
  export interface DshMenuItemEntry {
    id: string;
    label?: any;
    icon?: any;
    disabled?: boolean;
    danger?: boolean;
    shortcut?: DshMenuShortcut;
    submenu?: readonly DshMenuItemEntry[];
  }

  /** 分组标题行（不可选 ✓） */
  export interface DshMenuLabelEntry {
    type: "label";
    id: string;
    text: string;
  }

  /** 分隔线（不可选 ✓） */
  export interface DshMenuSeparatorEntry {
    type: "separator";
    id: string;
  }

  /** 菜单的一行：可选条目 / 标题行 / 分隔线 ✓ */
  export type DshMenuEntry = DshMenuItemEntry | DshMenuLabelEntry | DshMenuSeparatorEntry;

  /**
   * 宿主受控菜单 ✓（portal 到 body，`position: fixed` 由宿主算 ✓）。
   *
   * 这里只声明插件真正用到的 props ✓：`open` / `anchor` / `items` / `onSelect` / `onClose` +
   * portal 定位（`portal` / `getAnchorRect` / `side` / `align`）+ 键盘与尺寸（`autoFocus` / `dense`）✓。
   */
  export function Menu(props: {
    open: boolean;
    anchor: any;
    items?: readonly DshMenuEntry[];
    children?: any;
    footer?: readonly DshMenuEntry[];
    selectedId?: string | undefined;
    selectedIds?: readonly string[] | undefined;
    onSelect?: ((id: string) => void) | undefined;
    onClose: () => void;
    align?: "start" | "end";
    side?: "bottom" | "top" | "right";
    portal?: boolean;
    autoFocus?: boolean;
    dense?: boolean;
    compact?: boolean;
    selection?: "check" | "fill";
    getAnchorRect?: (() => DOMRect | null) | undefined;
    className?: string | undefined;
    listClassName?: string | undefined;
  }): any;
}
