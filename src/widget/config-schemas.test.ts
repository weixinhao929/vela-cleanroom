import { describe, it, expect } from "vitest";
import {
  WIDGET_CONFIG_SCHEMAS,
  defaultWidgetConfig,
  sanitizeWidgetConfig,
  validateWidgetConfig
} from "./config-schemas";

describe("config-schemas", () => {
  it("defaults missing fields to the documented defaults", () => {
    const cfg = defaultWidgetConfig("clock");
    expect(cfg.showSeconds).toBe(true);
    expect(cfg.showDate).toBe(true);
    expect(cfg.transparent).toBe(false);
    expect(cfg.weekdayStyle).toBe("long");
    expect(cfg.hour12).toBe(false);
    expect(cfg.style).toBe("standard");
    expect(cfg.timeZone).toBe("auto");
  });

  it("sanitizes out-of-range numbers back to defaults", () => {
    const cfg = sanitizeWidgetConfig("weather", {
      unit: "celsius",
      showWindHumidity: false,
      // 越界：应回退到 30
      refreshInterval: 9999
    });
    expect(cfg.refreshInterval).toBe(30);
    expect(cfg.showWindHumidity).toBe(false);
    expect(cfg.showForecast).toBe(true);
  });

  it("coerces wrong-typed values to defaults", () => {
    const cfg = sanitizeWidgetConfig("clock", { showSeconds: "yes", days: "nope" });
    expect(cfg.showSeconds).toBe(true);
    // 未知字段（days 不属于 clock）保留原样，不因清洗而丢失。
    expect(cfg.days).toBe("nope");
  });

  it("keeps unknown extra fields", () => {
    const cfg = sanitizeWidgetConfig("todo", { showCompleted: false, customNote: "keep-me" });
    expect(cfg.showCompleted).toBe(false);
    expect("customNote" in cfg).toBe(true);
  });

  it("enumerates every registry-viewable defaults without throwing", () => {
    for (const type of Object.keys(WIDGET_CONFIG_SCHEMAS)) {
      expect(() => defaultWidgetConfig(type)).not.toThrow();
    }
  });

  it("validateWidgetConfig reports success on valid input", () => {
    const r = validateWidgetConfig("gallery", { columns: 4, gap: 8, thumbShape: "circle" });
    expect(r.data.columns).toBe(4);
    expect(r.data.thumbShape).toBe("circle");
  });

  it("validateWidgetConfig coerces invalid enums to defaults", () => {
    const r = validateWidgetConfig("gallery", { thumbShape: "hexagon" });
    expect(r.data.thumbShape).toBe("rounded");
  });

  it("shortcuts customShortcuts default to empty array", () => {
    expect(defaultWidgetConfig("shortcuts").customShortcuts).toEqual([]);
  });

  it("unknown widget type returns empty config and passes through input", () => {
    expect(defaultWidgetConfig("no-such-widget")).toEqual({});
    const input = { arbitrary: 1 };
    expect(sanitizeWidgetConfig("no-such-widget", input)).toEqual(input);
  });
});
