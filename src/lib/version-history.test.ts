import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadVersionHistory, recordCurrentVersion } from "./version-history";
import { __resetMirrorSyncStateForTests } from "./local-backup";

/** 本机版本历史：upsert / 通道分条 / 容量上限 / 坏数据防御。 */

beforeEach(() => localStorage.clear());
afterEach(() => __resetMirrorSyncStateForTests());

describe("version-history", () => {
  it("首次记录写 firstSeen=lastSeen", () => {
    const list = recordCurrentVersion("0.1.0", "stable", 1000);
    expect(list).toEqual([{ version: "0.1.0", channel: "stable", firstSeen: 1000, lastSeen: 1000 }]);
    expect(loadVersionHistory()).toHaveLength(1);
  });

  it("同版本同通道刷新 lastSeen 不加条目；通道变化算新条目", () => {
    recordCurrentVersion("0.1.0", "stable", 1000);
    const list = recordCurrentVersion("0.1.0", "stable", 5000);
    expect(list).toHaveLength(1);
    expect(list[0].firstSeen).toBe(1000);
    expect(list[0].lastSeen).toBe(5000);
    const list2 = recordCurrentVersion("0.1.0", "insider", 6000);
    expect(list2).toHaveLength(2);
  });

  it("空版本与 unknown 不记录", () => {
    expect(recordCurrentVersion("", "stable")).toEqual([]);
    expect(recordCurrentVersion("unknown", "stable")).toEqual([]);
  });

  it("超容量截断最旧", () => {
    for (let i = 0; i < 35; i++) recordCurrentVersion(`0.0.${i}`, "stable", 1000 + i);
    const list = loadVersionHistory();
    expect(list.length).toBeLessThanOrEqual(30);
    expect(list[0].version).toBe("0.0.34");
  });

  it("坏数据返回空数组", () => {
    localStorage.setItem("focus-desk.version-history.v1", "{broken");
    expect(loadVersionHistory()).toEqual([]);
    localStorage.setItem("focus-desk.version-history.v1", JSON.stringify([{ evil: true }, "x"]));
    expect(loadVersionHistory()).toEqual([]);
  });
});
