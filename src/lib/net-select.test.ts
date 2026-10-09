import { describe, it, expect } from "vitest";
import { selectNetworkRows, type NetworkInfo } from "./system-stats";

const ni = (name: string, rx: number, tx: number, up = true): NetworkInfo => ({
  name,
  rx_bps: rx,
  tx_bps: tx,
  total_received: 0,
  total_transmitted: 0,
  up
});

describe("selectNetworkRows（W-145 网卡选择口径）", () => {
  it("first：在连网卡中选当前窗口收发之和最大者（经典网速工具 AutoSelect）", () => {
    const rows = selectNetworkRows([ni("以太网", 0, 0), ni("WLAN", 800, 100), ni("vEthernet", 0, 0)], "first");
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("WLAN");
  });

  it("first：全部为零时回退列表第一块，不空转", () => {
    const rows = selectNetworkRows([ni("以太网", 0, 0), ni("WLAN", 0, 0)], "first");
    expect(rows[0].name).toBe("以太网");
  });

  it("aggregate：只累计在连网卡，幽灵行（up=false）贡献为 0", () => {
    const rows = selectNetworkRows([ni("以太网", 100, 50), ni("断开的卡", 999, 999, false)], "aggregate", "", "合计");
    expect(rows[0].name).toBe("合计");
    expect(rows[0].rx).toBe(100);
    expect(rows[0].tx).toBe(50);
  });

  it("all：包含幽灵行（供 UI 显示未连接），速率原样透传", () => {
    const rows = selectNetworkRows([ni("以太网", 1, 2), ni("断开的卡", 0, 0, false)], "all");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ name: "断开的卡", up: false });
  });

  it("select：按名精确命中；名字不存在返回幽灵行（未连接），空名返回空数组", () => {
    expect(selectNetworkRows([ni("以太网", 7, 8), ni("WLAN", 0, 0)], "select", "WLAN")[0]).toMatchObject({
      name: "WLAN",
      rx: 0,
      tx: 0
    });
    // 选中的网卡被拔/改名：整节不能静默消失——幽灵行驱动 UI 显示「未连接」。
    expect(selectNetworkRows([ni("以太网", 7, 8)], "select", "不存在")).toEqual([
      { name: "不存在", rx: 0, tx: 0, up: false }
    ]);
    expect(selectNetworkRows([ni("以太网", 7, 8)], "select", "")).toEqual([]);
  });

  it("空列表：任何模式都不炸、返回空数组", () => {
    expect(selectNetworkRows([], "first")).toEqual([]);
    expect(selectNetworkRows([], "aggregate")).toHaveLength(1);
    expect(selectNetworkRows([], "all")).toEqual([]);
  });
});
