/** 测试：缓存块编辑、锚点保留与锁定。 */
import { describe, expect, it } from "vitest";
import {
  markCachedBlockSynced,
  replaceCachedBlock,
} from "../src/cache/editCache";
import { SOURCE, inspect, translate } from "./helpers";

async function fixture() {
  const initial = await translate();
  const state = inspect(SOURCE, initial.cacheText);
  const list = state.alignment.blocks.find(
    (block) => block.source.kind === "list" && block.cache,
  );
  const paragraph = state.alignment.blocks.find(
    (block) => block.source.kind === "paragraph" && block.cache,
  );
  if (!list?.cache || !paragraph?.cache) {
    throw new Error("fixture is missing expected blocks");
  }
  return { initial, state, list, paragraph };
}

describe("replaceCachedBlock", () => {
  it("writes human-edited content and updates the destination hash", async () => {
    const { initial, state, list } = await fixture();
    const edited = replaceCachedBlock({
      cacheText: initial.cacheText,
      cache: state.cache,
      target: list.cache!,
      content: "- 人工修改一\n- 人工修改二",
      sourceHash: list.source.hash,
      sourceKind: list.source.kind,
      mode: "human",
      md: state.md,
    });

    expect(edited.text).toContain("- 人工修改一");
    expect(edited.anchor.mode).toBe("human");
    expect(edited.anchor.dst).toBe(edited.block.hash);

    const after = inspect(SOURCE, edited.text);
    expect(
      after.alignment.blocks.find(
        (block) => block.source.kind === "list",
      )?.status,
    ).toBe("human");
  });

  it("rejects content that changes the block kind", async () => {
    const { initial, state, paragraph } = await fixture();
    expect(() =>
      replaceCachedBlock({
        cacheText: initial.cacheText,
        cache: state.cache,
        target: paragraph.cache!,
        content: "## Swapped to a heading",
        sourceHash: paragraph.source.hash,
        sourceKind: paragraph.source.kind,
        mode: "auto",
        md: state.md,
      }),
    ).toThrow("结构");
  });

  it("rejects caches with untracked content", async () => {
    const { initial, state, list } = await fixture();
    const untrackedText = `${initial.cacheText}\n\nLoose paragraph.\n`;
    const untracked = inspect(SOURCE, untrackedText);
    expect(() =>
      replaceCachedBlock({
        cacheText: untrackedText,
        cache: untracked.cache,
        target: untracked.cache.blocks.find(
          (block) => block.block.kind === "list",
        )!,
        content: "- 人工修改",
        sourceHash: list.source.hash,
        sourceKind: list.source.kind,
        mode: "human",
        md: state.md,
      }),
    ).toThrow("未加锚点");
  });
});

describe("markCachedBlockSynced", () => {
  it("accepts the current source hash and locks the block", async () => {
    const { initial, state, paragraph } = await fixture();
    const changed = SOURCE.replace(
      "First paragraph.",
      "First paragraph changed.",
    );
    const changedState = inspect(changed, initial.cacheText);
    const target = changedState.cache.blocks.find(
      (block) => block.block.kind === "paragraph",
    )!;
    const source = changedState.source.blocks.find(
      (block) => block.kind === "paragraph",
    )!;

    const synced = markCachedBlockSynced({
      cacheText: initial.cacheText,
      cache: changedState.cache,
      target,
      sourceHash: source.hash,
      md: changedState.md,
    });

    expect(synced.anchor.mode).toBe("human");
    expect(synced.anchor.src).toBe(source.hash);
    expect(synced.anchor.dst).toBe(synced.block.hash);

    const after = inspect(changed, synced.text);
    expect(
      after.alignment.blocks.find(
        (block) => block.source.kind === "paragraph",
      )?.status,
    ).toBe("human");
  });
});
