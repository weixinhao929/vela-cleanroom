import { describe, expect, it } from "vitest";
import { jsonBackupService } from "./backup";
import { ValidationError } from "./errors";
import type { AppState } from "./schemas";

const sample: AppState = {
  tasks: [
    {
      id: "t1",
      title: "完成报告",
      completed: false,
      createdAt: "2026-08-13T00:00:00.000Z",
      dueAt: "",
      priority: 0,
      tags: [],
      sortOrder: 0
    }
  ],
  deadlines: [
    {
      id: "d1",
      title: "项目节点",
      dueAt: "2026-08-20T00:00:00.000Z",
      notified: false,
      completed: false,
      notifiedTiers: [],
      repeat: "none"
    }
  ],
  pomodoro: {
    mode: "focus",
    timerMode: "countdown",
    focusTimerMode: "countdown",
    remainingSeconds: 1500,
    isRunning: false,
    completedFocusSessions: 2,
    currentTaskId: null,
    currentEventLabel: null,
    awaitingActivity: false
  }
};

describe("jsonBackupService", () => {
  it("round-trips export then import without loss", async () => {
    const raw = jsonBackupService.exportJson(sample);
    await expect(jsonBackupService.importJson(raw)).resolves.toEqual(sample);
  });

  it("throws ValidationError on malformed JSON", async () => {
    await expect(jsonBackupService.importJson("{not json")).rejects.toThrowError(ValidationError);
  });

  it("throws ValidationError on schema mismatch", async () => {
    await expect(jsonBackupService.importJson(JSON.stringify({ tasks: "nope" }))).rejects.toThrowError(ValidationError);
  });

  it("import rejects out-of-domain data", async () => {
    const bad = JSON.parse(JSON.stringify(sample));
    bad.tasks[0].title = "";
    await expect(jsonBackupService.importJson(JSON.stringify(bad))).rejects.toThrowError(ValidationError);
  });

  it("E-1: imports a +00:00 offset timestamp without failing", async () => {
    const withOffset = JSON.parse(JSON.stringify(sample));
    withOffset.tasks[0].createdAt = "2026-08-13T00:00:00.123456789+00:00";
    const imported = await jsonBackupService.importJson(JSON.stringify(withOffset));
    expect(imported.tasks[0].createdAt).toBe("2026-08-13T00:00:00.123456789+00:00");
  });
});
