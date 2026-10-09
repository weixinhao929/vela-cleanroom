/**
 * shortcuts-undo 测试：
 *  - undo/redo 对称执行逆操作，label 原样透传（toast 用）；
 *  - pushOp 清空重做栈；栈深上限 100（最早的操作被挤出）。
 *
 * 栈是模块级单例：beforeEach 复位，用例间不靠执行顺序隐式清栈。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { __resetShortcutsUndoForTest, canRedo, canUndo, pushOp, redoOp, undoOp } from "./shortcuts-undo";

describe("shortcuts-undo 命令栈", () => {
  beforeEach(() => __resetShortcutsUndoForTest());

  it("undo/redo 对称：执行逆操作并透传 label", () => {
    let v = 0;
    pushOp({
      label: "op-a",
      undo: () => {
        v = 0;
      },
      redo: () => {
        v = 1;
      }
    });
    pushOp({
      label: "op-b",
      undo: () => {
        v = 1;
      },
      redo: () => {
        v = 2;
      }
    });
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(false);
    expect(undoOp()?.label).toBe("op-b");
    expect(v).toBe(1);
    expect(redoOp()?.label).toBe("op-b");
    expect(v).toBe(2);
    // 重做栈耗尽。
    expect(undoOp()).not.toBeNull();
    expect(undoOp()).not.toBeNull();
    expect(canUndo()).toBe(false);
    expect(undoOp()).toBeNull();
    expect(redoOp()).not.toBeNull();
    expect(redoOp()).not.toBeNull();
    expect(redoOp()).toBeNull();
  });

  it("pushOp 清空重做栈（经典语义）", () => {
    pushOp({ label: "x", undo: () => {}, redo: () => {} });
    expect(undoOp()).not.toBeNull();
    expect(canRedo()).toBe(true);
    pushOp({ label: "y", undo: () => {}, redo: () => {} });
    expect(canRedo()).toBe(false);
  });

  it("栈深上限 100：最早的记录被挤出", () => {
    for (let i = 0; i < 105; i++) {
      pushOp({ label: `bulk-${i}`, undo: () => {}, redo: () => {} });
    }
    let n = 0;
    while (undoOp()) n++;
    expect(n).toBe(100);
  });
});
