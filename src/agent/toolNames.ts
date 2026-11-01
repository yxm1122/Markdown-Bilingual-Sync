/**
 * Language Model Tool 的稳定名称。
 *
 * 名称同时出现在 package.json `contributes.languageModelTools` 与
 * `onLanguageModelTool:<name>` 激活事件中；测试会比较三处是否一致。
 */
export const AGENT_TOOL_NAMES = {
  getDocumentBrief: "mbs_get_document_brief",
  updateDocumentBrief: "mbs_update_document_brief",
  updateDocumentGlossary: "mbs_update_document_glossary",
  getGlossary: "mbs_get_glossary",
  updateGlossary: "mbs_update_glossary",
} as const;

export type AgentToolName =
  (typeof AGENT_TOOL_NAMES)[keyof typeof AGENT_TOOL_NAMES];
