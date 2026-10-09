/**
 * edit-chrome 判定单元：编辑铬件 / 卡片内部控件两个谓词的命中与放行边界。
 * WidgetCard / GroupCard 的键盘守卫（方向键微移、Delete）都以这两份
 * 判定为准——这里用最小 DOM 夹具钉住口径。
 */
import { afterEach, describe, expect, it } from "vitest";
import { isEditChromeTarget, isWidgetControlTarget } from "./edit-chrome";

function mount(html: string): void {
  const host = document.createElement("div");
  host.id = "edit-chrome-fixture";
  host.innerHTML = html;
  document.body.appendChild(host);
}

afterEach(() => {
  document.getElementById("edit-chrome-fixture")?.remove();
});

describe("edit-chrome 判定", () => {
  it("编辑铬件：工具栏/面板/批量工具栏/菜单内命中，画布空白放行", () => {
    mount(`
      <div class="widget-edit-toolbar"><button id="tb" /></div>
      <div class="widget-template-panel"><input id="pi" /></div>
      <div class="dock-cfg"><button id="di" /></div>
      <div class="widget-batch-toolbar"><button id="bi" /></div>
      <div class="ctx-menu"><button id="mi" /></div>
      <div id="blank"></div>
    `);
    for (const id of ["tb", "pi", "di", "bi", "mi"]) {
      const el = document.getElementById(id)!;
      expect(isEditChromeTarget(el), id).toBe(true);
      // 铬件自身即根时也命中（closest 含自身）。
      expect(isEditChromeTarget(el.parentElement), id + "-root").toBe(true);
    }
    expect(isEditChromeTarget(document.getElementById("blank"))).toBe(false);
    expect(isEditChromeTarget(document.body)).toBe(false);
    expect(isEditChromeTarget(null)).toBe(false);
  });

  it("卡片内部控件：button/select/data-interactive 命中，卡片壳层与画布放行", () => {
    mount(`
      <div class="widget-card" id="card-shell">
        <button id="ctl-btn"></button>
        <select id="ctl-select"><option>1</option></select>
        <div data-interactive id="ctl-di"></div>
        <div class="card-body-plain" id="plain"></div>
      </div>
      <div class="widget-group" id="group-shell">
        <button id="grp-btn"></button>
      </div>
      <div class="wexp"><button id="wexp-btn"></button></div>
    `);
    for (const id of ["ctl-btn", "ctl-select", "ctl-di", "grp-btn", "wexp-btn"]) {
      expect(isWidgetControlTarget(document.getElementById(id)!), id).toBe(true);
    }
    // 壳层本身（方向键微移的落点）与卡片内非交互区域放行。
    expect(isWidgetControlTarget(document.getElementById("card-shell"))).toBe(false);
    expect(isWidgetControlTarget(document.getElementById("group-shell"))).toBe(false);
    expect(isWidgetControlTarget(document.getElementById("plain"))).toBe(false);
    expect(isWidgetControlTarget(document.body)).toBe(false);
  });
});
