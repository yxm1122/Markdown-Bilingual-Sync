The cache format is documented in the next section. 缓存文件按块顺序排列，每个块都有独立的锚点。This matters when a file is edited outside VS Code.

If a block is missing from the cache, the preview marks it as untranslated. 此时运行同步即可补齐缺失的块，已有的人工译文不会被覆盖。

The summary is optional. 摘要只作为上下文使用，不参与块对齐。
