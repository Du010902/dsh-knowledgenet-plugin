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
}
