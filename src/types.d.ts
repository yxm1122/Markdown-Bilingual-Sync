/**
 * 第三方 Markdown 插件的本地类型声明（TypeScript 编译期使用）。
 *
 * markdown-it-footnote 与 markdown-it-task-lists 未随包提供类型，这里只补上
 * src/markdown/markdown.ts 实际用到的签名，避免为两个小插件引入额外的 @types 依赖。
 * 运行环境：仅参与 tsc 的类型检查与编辑器提示，不产生运行时代码；与扩展主进程无通信。
 */

/**
 * markdown-it-footnote：作为 markdown-it 插件注册，接收并原地增强 md 实例。
 */
declare module "markdown-it-footnote" {
  import type { MarkdownIt } from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

/**
 * markdown-it-task-lists：把 `- [ ]` / `- [x]` 列表项渲染为复选框。
 * 目前只声明启用开关与 label 位置等常用选项，未使用的选项保持默认。
 */
declare module "markdown-it-task-lists" {
  import type { MarkdownIt } from "markdown-it";
  interface TaskListOptions {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }
  const plugin: (md: MarkdownIt, options?: TaskListOptions) => void;
  export default plugin;
}
