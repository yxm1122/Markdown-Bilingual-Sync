/**
 * 静态预览与截图矩阵使用的 VS Code 主题令牌近似值。
 *
 * 真实 Webview 由 VS Code 注入 `--vscode-*` 变量；本模块只在浏览器里复现
 * Dark+ / Light+ / Dark High Contrast 的关键取值，用于独立打开 HTML 和自动截图。
 * 改动主题时以 VS Code 默认主题的 workbench 颜色为准，不要引入品牌色。
 */

export type StaticTheme = "dark" | "light" | "hc";

const FONT =
  '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const EDITOR_FONT = '"Cascadia Code", Consolas, "Courier New", monospace';

/** Dark+（VS Code 默认深色）。 */
const DARK = `
:root {
  color-scheme: dark;
  --vscode-font-family: ${FONT};
  --vscode-editor-font-family: ${EDITOR_FONT};
  --vscode-markdown-font-family: var(--vscode-font-family);
  --vscode-markdown-font-size: 14px;
  --vscode-markdown-line-height: 1.6;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-disabledForeground: #cccccc80;
  --vscode-errorForeground: #f85149;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-editorInfo-foreground: #3794ff;
  --vscode-icon-foreground: #cccccc;
  --vscode-focusBorder: #0078d4;
  --vscode-widget-border: #313131;
  --vscode-widget-shadow: rgba(0,0,0,.36);
  --vscode-editor-background: #1f1f1f;
  --vscode-editor-foreground: #cccccc;
  --vscode-editor-selectionBackground: #264f78;
  --vscode-editorWidget-background: #202020;
  --vscode-editorWidget-border: #454545;
  --vscode-panel-border: #2b2b2b;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-button-border: transparent;
  --vscode-button-secondaryBackground: #313131;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-input-background: #313131;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-input-placeholderForeground: #989898;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-badge-background: #616161;
  --vscode-badge-foreground: #f8f8f8;
  --vscode-textLink-foreground: #4daafc;
  --vscode-textLink-activeForeground: #4daafc;
  --vscode-textCodeBlock-background: #2b2b2b;
  --vscode-textPreformat-foreground: #d7ba7d;
  --vscode-textPreformat-background: #2b2b2b;
  --vscode-textBlockQuote-background: #2b2b2b;
  --vscode-textBlockQuote-border: #616161;
  --vscode-menu-background: #1f1f1f;
  --vscode-menu-foreground: #cccccc;
  --vscode-menu-border: #454545;
  --vscode-menu-selectionBackground: #0078d4;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-menu-separatorBackground: #454545;
  --vscode-notifications-background: #202020;
  --vscode-notifications-border: #454545;
  --vscode-notifications-foreground: #cccccc;
  --vscode-progressBar-background: #0078d4;
  --vscode-toolbar-hoverBackground: #5a5d5e50;
  --vscode-actionBar-toggledBackground: #0078d433;
  --vscode-diffEditor-insertedLineBackground: #20442c;
  --vscode-diffEditor-removedLineBackground: #4b1818;
  --vscode-diffEditor-insertedTextBackground: #2ea04326;
  --vscode-diffEditor-removedTextBackground: #f8514926;
  --vscode-testing-iconPassed: #73c991;
  --vscode-charts-blue: #3794ff;
  --vscode-symbolIcon-keywordForeground: #c586c0;
  --vscode-symbolIcon-stringForeground: #ce9178;
  --vscode-symbolIcon-numberForeground: #b5cea8;
  --vscode-symbolIcon-commentForeground: #6a9955;
  --vscode-symbolIcon-functionForeground: #dcdcaa;
  --vscode-symbolIcon-classForeground: #4ec9b0;
  --vscode-inputValidation-warningBackground: #352a05;
  --vscode-inputValidation-warningBorder: #b89500;
  --vscode-inputValidation-infoBackground: #063b49;
  --vscode-inputValidation-infoBorder: #007acc;
  --vscode-inputValidation-errorBackground: #5a1d1d;
  --vscode-inputValidation-errorBorder: #be1100;
  --vscode-scrollbarSlider-background: #79797966;
  --vscode-scrollbarSlider-hoverBackground: #646464b3;
  --vscode-scrollbarSlider-activeBackground: #bfbfbf66;
}
body { margin: 0; }
`;

/** Light+（VS Code 默认浅色）。 */
const LIGHT = `
:root {
  color-scheme: light;
  --vscode-font-family: ${FONT};
  --vscode-editor-font-family: ${EDITOR_FONT};
  --vscode-markdown-font-family: var(--vscode-font-family);
  --vscode-markdown-font-size: 14px;
  --vscode-markdown-line-height: 1.6;
  --vscode-foreground: #3b3b3b;
  --vscode-descriptionForeground: #717171;
  --vscode-disabledForeground: #b0b0b0;
  --vscode-errorForeground: #a1260d;
  --vscode-editorWarning-foreground: #bf8803;
  --vscode-editorInfo-foreground: #1a85ff;
  --vscode-icon-foreground: #424242;
  --vscode-focusBorder: #0090f1;
  --vscode-widget-border: #d4d4d4;
  --vscode-widget-shadow: rgba(0,0,0,.16);
  --vscode-editor-background: #ffffff;
  --vscode-editor-foreground: #3b3b3b;
  --vscode-editor-selectionBackground: #add6ff;
  --vscode-editorWidget-background: #f8f8f8;
  --vscode-editorWidget-border: #d4d4d4;
  --vscode-panel-border: #e5e5e5;
  --vscode-button-background: #007acc;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #0062a3;
  --vscode-button-border: transparent;
  --vscode-button-secondaryBackground: #f3f3f3;
  --vscode-button-secondaryForeground: #3b3b3b;
  --vscode-button-secondaryHoverBackground: #e8e8e8;
  --vscode-input-background: #ffffff;
  --vscode-input-foreground: #3b3b3b;
  --vscode-input-border: #cecece;
  --vscode-input-placeholderForeground: #767676;
  --vscode-list-hoverBackground: #f0f0f0;
  --vscode-list-activeSelectionBackground: #cce4f7;
  --vscode-badge-background: #cccccc;
  --vscode-badge-foreground: #333333;
  --vscode-textLink-foreground: #006ab1;
  --vscode-textLink-activeForeground: #006ab1;
  --vscode-textCodeBlock-background: #f0f0f0;
  --vscode-textPreformat-foreground: #a31515;
  --vscode-textPreformat-background: #f0f0f0;
  --vscode-textBlockQuote-background: #f2f2f2;
  --vscode-textBlockQuote-border: #c8c8c8;
  --vscode-menu-background: #f8f8f8;
  --vscode-menu-foreground: #3b3b3b;
  --vscode-menu-border: #d4d4d4;
  --vscode-menu-selectionBackground: #007acc;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-menu-separatorBackground: #d4d4d4;
  --vscode-notifications-background: #f8f8f8;
  --vscode-notifications-border: #d4d4d4;
  --vscode-notifications-foreground: #3b3b3b;
  --vscode-progressBar-background: #007acc;
  --vscode-toolbar-hoverBackground: #b8b8b850;
  --vscode-actionBar-toggledBackground: #0078d426;
  --vscode-diffEditor-insertedLineBackground: #e6ffec;
  --vscode-diffEditor-removedLineBackground: #ffebe9;
  --vscode-diffEditor-insertedTextBackground: #abf2bc;
  --vscode-diffEditor-removedTextBackground: #ff818266;
  --vscode-testing-iconPassed: #388a34;
  --vscode-charts-blue: #0066bf;
  --vscode-symbolIcon-keywordForeground: #0000ff;
  --vscode-symbolIcon-stringForeground: #a31515;
  --vscode-symbolIcon-numberForeground: #098658;
  --vscode-symbolIcon-commentForeground: #008000;
  --vscode-symbolIcon-functionForeground: #795e26;
  --vscode-symbolIcon-classForeground: #267f99;
  --vscode-inputValidation-warningBackground: #fff4ce;
  --vscode-inputValidation-warningBorder: #b89500;
  --vscode-inputValidation-infoBackground: #e5f3ff;
  --vscode-inputValidation-infoBorder: #007acc;
  --vscode-inputValidation-errorBackground: #f2dede;
  --vscode-inputValidation-errorBorder: #be1100;
  --vscode-scrollbarSlider-background: #64646466;
  --vscode-scrollbarSlider-hoverBackground: #646464b3;
  --vscode-scrollbarSlider-activeBackground: #00000099;
}
body { margin: 0; }
`;

/** Dark High Contrast。 */
const HC = `
:root {
  color-scheme: dark;
  --vscode-font-family: ${FONT};
  --vscode-editor-font-family: ${EDITOR_FONT};
  --vscode-markdown-font-family: var(--vscode-font-family);
  --vscode-markdown-font-size: 14px;
  --vscode-markdown-line-height: 1.6;
  --vscode-foreground: #ffffff;
  --vscode-descriptionForeground: #ffffff;
  --vscode-disabledForeground: #ffffff80;
  --vscode-errorForeground: #f48771;
  --vscode-editorWarning-foreground: #ffd700;
  --vscode-editorInfo-foreground: #6fc3df;
  --vscode-icon-foreground: #ffffff;
  --vscode-focusBorder: #f38518;
  --vscode-widget-border: #6fc3df;
  --vscode-widget-shadow: rgba(0,0,0,.6);
  --vscode-editor-background: #000000;
  --vscode-editor-foreground: #ffffff;
  --vscode-editor-selectionBackground: #ffffff33;
  --vscode-editorWidget-background: #000000;
  --vscode-editorWidget-border: #6fc3df;
  --vscode-panel-border: #6fc3df;
  --vscode-button-background: #000000;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1a1a1a;
  --vscode-button-border: #ffffff;
  --vscode-button-secondaryBackground: #000000;
  --vscode-button-secondaryForeground: #ffffff;
  --vscode-button-secondaryHoverBackground: #1a1a1a;
  --vscode-input-background: #000000;
  --vscode-input-foreground: #ffffff;
  --vscode-input-border: #6fc3df;
  --vscode-input-placeholderForeground: #ffffffb3;
  --vscode-list-hoverBackground: #1a1a1a;
  --vscode-list-activeSelectionBackground: #1a1a1a;
  --vscode-badge-background: #000000;
  --vscode-badge-foreground: #ffffff;
  --vscode-textLink-foreground: #6fc3df;
  --vscode-textLink-activeForeground: #6fc3df;
  --vscode-textCodeBlock-background: #000000;
  --vscode-textPreformat-foreground: #ffd700;
  --vscode-textPreformat-background: #000000;
  --vscode-textBlockQuote-background: #000000;
  --vscode-textBlockQuote-border: #6fc3df;
  --vscode-menu-background: #000000;
  --vscode-menu-foreground: #ffffff;
  --vscode-menu-border: #6fc3df;
  --vscode-menu-selectionBackground: #1a1a1a;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-menu-separatorBackground: #6fc3df;
  --vscode-notifications-background: #000000;
  --vscode-notifications-border: #6fc3df;
  --vscode-notifications-foreground: #ffffff;
  --vscode-progressBar-background: #f38518;
  --vscode-toolbar-hoverBackground: #1a1a1a;
  --vscode-actionBar-toggledBackground: #f3851833;
  --vscode-diffEditor-insertedLineBackground: #004000;
  --vscode-diffEditor-removedLineBackground: #400000;
  --vscode-diffEditor-insertedTextBackground: #00ff0040;
  --vscode-diffEditor-removedTextBackground: #ff000040;
  --vscode-testing-iconPassed: #00ff00;
  --vscode-charts-blue: #00ffff;
  --vscode-symbolIcon-keywordForeground: #569cd6;
  --vscode-symbolIcon-stringForeground: #ce9178;
  --vscode-symbolIcon-numberForeground: #b5cea8;
  --vscode-symbolIcon-commentForeground: #7ca668;
  --vscode-symbolIcon-functionForeground: #dcdcaa;
  --vscode-symbolIcon-classForeground: #4ec9b0;
  --vscode-inputValidation-warningBackground: #000000;
  --vscode-inputValidation-warningBorder: #ffd700;
  --vscode-inputValidation-infoBackground: #000000;
  --vscode-inputValidation-infoBorder: #6fc3df;
  --vscode-inputValidation-errorBackground: #000000;
  --vscode-inputValidation-errorBorder: #f48771;
  --vscode-scrollbarSlider-background: #ffffff66;
  --vscode-scrollbarSlider-hoverBackground: #ffffffb3;
  --vscode-scrollbarSlider-activeBackground: #ffffff;
}
body { margin: 0; }
`;

export const STATIC_THEMES: Record<StaticTheme, string> = {
  dark: DARK,
  light: LIGHT,
  hc: HC,
};

export const STATIC_THEME_NAMES: Record<StaticTheme, string> = {
  dark: "Dark+",
  light: "Light+",
  hc: "Dark High Contrast",
};
