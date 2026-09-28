import { describe, it, expect } from "vitest";
import { validateBackup, parseAndValidateBackup, describeBackup, BACKUP_SCHEMA_VERSION } from "./backup-validate";

/** 一个结构完整的 v2 备份。 */
const validV2 = {
  schemaVersion: 2,
  tasks: [{ id: "t1", title: "写周报" }],
  deadlines: [{ id: "d1", title: "答辩" }],
  sessions: [{ id: "s1", mode: "focus" }],
  settings: [{ key: "app:settings:v1", value: "{}" }]
};

describe("validateBackup 结构校验", () => {
  it("接受完整的当前版本备份", () => {
    const r = validateBackup(validV2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(r.payload.tasks).toHaveLength(1);
    expect(r.warnings).toHaveLength(0);
  });

  it("拒绝非对象顶层结构", () => {
    for (const bad of [null, 42, "text", [], undefined]) {
      const r = validateBackup(bad);
      expect(r.ok).toBe(false);
    }
  });

  it("拒绝缺少 tasks 的文件（基本可断定不是本应用备份）", () => {
    const r = validateBackup({ schemaVersion: 2, deadlines: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("tasks");
  });

  it("拒绝版本高于当前应用的文件", () => {
    const r = validateBackup({ ...validV2, schemaVersion: 99 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("v99");
    expect(r.reason).toContain("更新应用");
  });

  it("拒绝无效的版本号", () => {
    for (const v of ["2", 0, -1, 2.5, {}]) {
      const r = validateBackup({ ...validV2, schemaVersion: v });
      expect(r.ok).toBe(false);
    }
  });

  it("拒绝字段类型错误（tasks 是数组但 sessions 不是）", () => {
    const r = validateBackup({ ...validV2, sessions: "oops" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("sessions");
  });

  it("拒绝记录数组里混入非对象（文件被截断/损坏）", () => {
    const r = validateBackup({ ...validV2, tasks: [{ id: "t1" }, "broken"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("损坏");
  });

  it("拒绝全空备份（恢复它等于清空数据）", () => {
    const r = validateBackup({ schemaVersion: 2, tasks: [], deadlines: [], sessions: [], settings: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("清空");
  });
});

describe("版本迁移链", () => {
  it("无 schemaVersion 的旧文件按 v1 迁移并补齐缺失字段", () => {
    // v1 只导出 tasks 与 deadlines。
    const r = validateBackup({ tasks: [{ id: "t1" }], deadlines: [{ id: "d1" }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.schemaVersion).toBe(2);
    // sessions 缺失必须保持缺失：补成 [] 会让 Rust 侧先 DELETE 再插 0 条，
    // 恢复一份合法 v1 备份就清空全部专注历史。
    expect(r.payload.sessions).toBeUndefined();
    expect("sessions" in r.payload).toBe(false);
    expect(r.payload.settings).toEqual([]);
    expect(r.warnings[0]).toContain("v1");
    expect(describeBackup(r.payload)).toContain("专注记录 保留现有");
  });

  it("显式携带 sessions: [] 才是清空语义", () => {
    const r = validateBackup({ tasks: [{ id: "t1" }], sessions: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.sessions).toEqual([]);
    expect(describeBackup(r.payload)).toContain("专注记录 0");
  });

  it("迁移不改动已有数据", () => {
    const r = validateBackup({ tasks: [{ id: "keep-me", title: "原样保留" }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.tasks[0]).toEqual({ id: "keep-me", title: "原样保留" });
  });

  it("显式 v1 与省略字段等价", () => {
    const a = validateBackup({ schemaVersion: 1, tasks: [{ id: "t" }] });
    const b = validateBackup({ tasks: [{ id: "t" }] });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.payload).toEqual(b.payload);
  });
});

describe("parseAndValidateBackup", () => {
  it("解析合法 JSON 文本", () => {
    const r = parseAndValidateBackup(JSON.stringify(validV2));
    expect(r.ok).toBe(true);
  });

  it("把 JSON 语法错误转成可读原因", () => {
    const r = parseAndValidateBackup('{"tasks": [ truncated');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("有效的 JSON");
  });

  it("空文本被拒绝而不是抛异常", () => {
    expect(parseAndValidateBackup("").ok).toBe(false);
  });
});

describe("describeBackup", () => {
  it("给出各域记录数摘要", () => {
    const r = validateBackup(validV2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = describeBackup(r.payload);
    expect(text).toContain("任务 1");
    expect(text).toContain("DDL 1");
    expect(text).toContain("专注记录 1");
    expect(text).toContain("设置项 1");
  });
});

describe("interruptions 可选扩展（v2）", () => {
  it("携带中断记录的备份：负载透传且摘要包含数量", () => {
    const r = validateBackup({
      ...validV2,
      interruptions: [{ id: "i1", reason: "phone", mode: "focus" }]
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.interruptions).toHaveLength(1);
    expect(describeBackup(r.payload)).toContain("中断记录 1");
  });

  it("旧备份无该字段：负载不带 interruptions（恢复时保留现有记录）", () => {
    const r = validateBackup(validV2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.interruptions).toBeUndefined();
    expect(describeBackup(r.payload)).not.toContain("中断");
  });

  it("字段不是数组或记录损坏：整体拒绝", () => {
    expect(validateBackup({ ...validV2, interruptions: "oops" }).ok).toBe(false);
    expect(validateBackup({ ...validV2, interruptions: [{ id: "i1" }, "broken"] }).ok).toBe(false);
  });
});
