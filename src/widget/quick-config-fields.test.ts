import { describe, expect, it } from "vitest";
import { WIDGET_CONFIG_SCHEMAS, defaultWidgetConfig } from "./config-schemas";
import { QUICK_CONFIG_FIELDS } from "./quick-config-fields";

/**
 * B1 就地配置弹层的 quick 字段标记表与 zod schema 的一致性守卫：
 * 表只描述呈现，默认值/范围以 schema 为准——这里逐项断言二者不漂移。
 * （schema 全字段带 .default/.catch，parse 恒成功；越界值会被 catch 回默认，
 *  所以「parse(x) === x」即「x 在 schema 合法范围内」。）
 */

/** 用 schema 判定单个字段值是否原样通过（未被 catch/default 改写）。 */
function roundTrip(type: string, key: string, value: unknown): boolean {
  const schema = WIDGET_CONFIG_SCHEMAS[type];
  const parsed = schema.safeParse({ [key]: value });
  if (!parsed.success) return false;
  return (parsed.data as Record<string, unknown>)[key] === value;
}

describe("QUICK_CONFIG_FIELDS 与 schema 一致", () => {
  it("每个 quick 条目都有对应 schema，且字段存在于 schema shape", () => {
    for (const [type, fields] of Object.entries(QUICK_CONFIG_FIELDS)) {
      expect(WIDGET_CONFIG_SCHEMAS[type], `widget type ${type} 缺少 schema`).toBeTruthy();
      const defaults = defaultWidgetConfig(type);
      for (const f of fields) {
        expect(f.key in defaults, `${type}.${f.key} 不在 ${type} schema 的字段集中`).toBe(true);
      }
    }
  });

  it("toggle 字段默认值为 boolean", () => {
    for (const [type, fields] of Object.entries(QUICK_CONFIG_FIELDS)) {
      const defaults = defaultWidgetConfig(type);
      for (const f of fields) {
        if (f.kind === "toggle") {
          expect(typeof defaults[f.key], `${type}.${f.key}`).toBe("boolean");
        }
      }
    }
  });

  it("segment 字段：schema 默认值在选项内，且每个选项 id 均可通过 schema 解析", () => {
    for (const [type, fields] of Object.entries(QUICK_CONFIG_FIELDS)) {
      const defaults = defaultWidgetConfig(type);
      for (const f of fields) {
        if (f.kind !== "segment") continue;
        const ids = f.options.map((o) => o.id);
        expect(
          ids.includes(defaults[f.key] as string),
          `${type}.${f.key} 的 schema 默认值 ${String(defaults[f.key])} 不在 quick 选项 [${ids.join(",")}] 内`
        ).toBe(true);
        for (const id of ids) {
          expect(roundTrip(type, f.key, id), `${type}.${f.key} 选项 ${id} 被 schema 拒绝`).toBe(true);
        }
      }
    }
  });

  it("slider/stepper 字段：min/max/step 均在 schema 范围内，默认值落在区间内", () => {
    for (const [type, fields] of Object.entries(QUICK_CONFIG_FIELDS)) {
      const defaults = defaultWidgetConfig(type);
      for (const f of fields) {
        if (f.kind !== "slider" && f.kind !== "stepper") continue;
        const label = `${type}.${f.key}`;
        expect(roundTrip(type, f.key, f.min), `${label} min=${f.min} 越界`).toBe(true);
        expect(roundTrip(type, f.key, f.max), `${label} max=${f.max} 越界`).toBe(true);
        if (f.step !== undefined) {
          expect(roundTrip(type, f.key, f.min + f.step), `${label} min+step 越界（step 与 schema 范围不匹配）`).toBe(
            true
          );
        }
        const d = defaults[f.key] as number;
        expect(d >= f.min && d <= f.max, `${label} 默认值 ${d} 不在 [${f.min},${f.max}]`).toBe(true);
      }
    }
  });

  it("color 字段默认值为 string；zones 字段默认值为数组", () => {
    for (const [type, fields] of Object.entries(QUICK_CONFIG_FIELDS)) {
      const defaults = defaultWidgetConfig(type);
      for (const f of fields) {
        if (f.kind === "color") expect(typeof defaults[f.key], `${type}.${f.key}`).toBe("string");
        if (f.kind === "zones") expect(Array.isArray(defaults[f.key]), `${type}.${f.key}`).toBe(true);
      }
    }
  });

  it("quick 条目数克制：非时钟类型 ≤ 5 项（时钟因承接遗留弹层独有字段豁免）", () => {
    for (const [type, fields] of Object.entries(QUICK_CONFIG_FIELDS)) {
      const cap = type === "clock" ? 8 : 5;
      expect(fields.length, `${type} 有 ${fields.length} 个 quick 字段`).toBeLessThanOrEqual(cap);
    }
  });
});
