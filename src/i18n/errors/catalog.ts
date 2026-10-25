/**
 * 错误文案汇总目录。
 *
 * 只包含纯数据；scripts/build-l10n.ts 与测试直接导入本文件，因此这里不能出现
 * vscode 或任何运行时 API。新增领域文件后在此展开数组，ErrorKey 会自动扩展。
 */
import { CACHE_ERRORS } from "./cache";
import { COMMAND_ERRORS } from "./commands";
import { COMMON_ERRORS } from "./common";
import { EXPORT_ERRORS } from "./exportTranslation";
import { GLOSSARY_ERRORS } from "./glossary";
import { IMPORT_ERRORS } from "./importTranslation";
import { LANGUAGE_ERRORS } from "./language";
import { PREVIEW_ERRORS } from "./preview";
import { SOURCE_ERRORS } from "./source";
import { SYNC_ERRORS } from "./sync";
import { TRANSLATION_ERRORS } from "./translation";

export const ERROR_MESSAGES = [
  ...COMMON_ERRORS,
  ...SYNC_ERRORS,
  ...SOURCE_ERRORS,
  ...CACHE_ERRORS,
  ...EXPORT_ERRORS,
  ...IMPORT_ERRORS,
  ...GLOSSARY_ERRORS,
  ...LANGUAGE_ERRORS,
  ...TRANSLATION_ERRORS,
  ...PREVIEW_ERRORS,
  ...COMMAND_ERRORS,
] as const;

/** 所有已登记错误文案的稳定 key 联合类型。 */
export type ErrorKey = (typeof ERROR_MESSAGES)[number]["key"];
