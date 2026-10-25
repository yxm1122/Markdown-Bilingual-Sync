/**
 * 原文暂存/写回（source/editSource）相关错误文案。
 */
import type { ErrorMessage } from "./types";

export const SOURCE_ERRORS = [
  {
    key: "source.editAndDeleteConflict",
    en: "Block {index} is both edited and marked for deletion. Undo one of them first.",
    zh: "块 {index} 同时被修改和删除，请先撤销其中一项。",
  },
  {
    key: "source.changed",
    en: "The source of block {index} has changed. Edit it again before applying.",
    zh: "块 {index} 的原文已变化，请重新编辑后再应用。",
  },
  {
    key: "source.emptyBlock",
    en: "Block {index} cannot be empty.",
    zh: "块 {index} 不能为空。",
  },
  {
    key: "source.insertAfterDeleted",
    en: "Block {index} is marked for deletion; a new block cannot be inserted after it.",
    zh: "块 {index} 已被标记删除，不能在其后插入新块。",
  },
  {
    key: "source.emptyInsert",
    en: "The inserted source block cannot be empty.",
    zh: "插入的原文块不能为空。",
  },
] as const satisfies readonly ErrorMessage[];
