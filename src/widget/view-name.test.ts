/**
 * 视图命名统一入口（promptViewName）回归：长度上限（码点截断）+ 重名拦截
 * + 取消/空值直通。弹窗依赖全 mock，聚焦校验逻辑。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const promptMock = vi.fn();
const alertMock = vi.fn();
vi.mock("../components/PromptDialog", () => ({
  promptDialog: (opts: unknown) => promptMock(opts),
  alertDialog: (opts: unknown) => alertMock(opts)
}));

import { promptViewName, LABEL_MAX_CHARS } from "./rename";

const tr = (s: string) => s;
const existing = [
  { id: "a", name: "Home" },
  { id: "b", name: "Work" }
];

describe("promptViewName", () => {
  beforeEach(() => {
    promptMock.mockReset();
    alertMock.mockReset();
    alertMock.mockResolvedValue(undefined);
  });

  it("唯一名通过并按码点截断到上限", async () => {
    promptMock.mockResolvedValue(`  ${"学".repeat(40)}  `);
    const name = await promptViewName(tr, { title: "t", existing });
    expect(name).toBe("学".repeat(LABEL_MAX_CHARS));
    expect([...(name ?? "")]).toHaveLength(LABEL_MAX_CHARS);
  });

  it("传入 existing（重命名场景）时撞名被拦截：提示并返回 null", async () => {
    promptMock.mockResolvedValue("Work");
    const name = await promptViewName(tr, { title: "t", existing });
    expect(name).toBeNull();
    expect(alertMock).toHaveBeenCalledTimes(1);
    // 重命名自己时同名是 no-op 语义，不算冲突。
    const keep = await promptViewName(tr, { title: "t", existing, initial: "Work", selfId: "b" });
    expect(keep).toBe("Work");
  });

  it("不传 existing（新建场景）不拦截撞名——store 的 addView 自动加序号", async () => {
    promptMock.mockResolvedValue("Work");
    expect(await promptViewName(tr, { title: "t" })).toBe("Work");
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("取消（null）与空白输入返回 null，不弹提示", async () => {
    promptMock.mockResolvedValue(null);
    expect(await promptViewName(tr, { title: "t", existing })).toBeNull();
    promptMock.mockResolvedValue("   ");
    expect(await promptViewName(tr, { title: "t", existing })).toBeNull();
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("弹窗带 maxLength（输入期即挡下超长）", async () => {
    promptMock.mockResolvedValue("x");
    await promptViewName(tr, { title: "t", existing });
    expect(promptMock).toHaveBeenCalledWith(expect.objectContaining({ maxLength: LABEL_MAX_CHARS }));
  });
});
