import { env } from "vscode";

// Must run before src/i18n loads; UI_TEXT is localized once at module init.
(env as { language: string }).language = "en";
