/**
 * W-087 轻量拼音首字母匹配：让中文应用名可以用英文缩写搜索（微信 → wx，
 * 网易云音乐 → wyyy）。
 *
 * 完整拼音表有数百 KB，塞进桌面小组件不值当。这里只内置一份覆盖高频应用
 * 名用字的「汉字 → 首字母」压缩表（两字符一组：汉字 + 小写字母），查不到的
 * 字符原样跳过。配合自定义别名（alias）几乎能覆盖所有场景。
 */

const DATA =
  "微w信x网w易y云y音y节j奏z快k手s抖d音y视s频p浏l览l器q安a卓z电d脑n计j算s机j笔b记b本b助z手s管g理l家j大d师s王w者z荣r耀y联l盟m全q球q锋f会h用y户h端d腾t讯x扣k扣q输s入r法f搜s狗g紫z光g拼p音y百b度d三s六l零l安a全q卫w士s毒d霸b火h绒r卡k巴b斯s基j诺n麦m克k菲f捷j径j石s头t盘p城c堡b盘p古g天t翼y联l移y动d联l通t电d信x华h为w小x米m红h米m眸m节j奏z酷k我w虾x哔b站z看k板b漫m画h小x说s阅y读d起q点d晋j江j番f茄q七q猫m飞f卢l书s城c微w博b知z乎h豆d瓣b贴t吧b小x红h书h淘t宝b天t猫m京j东d拼p多d苏s宁n唯w品p会h得d物w闲x鱼y转z人r民m日r报b新x闻w财c经j股g票p同t花h顺s东d方f富f雪x球q支z付b宝b网w银y闪f付f顺s丰f圆y通t中z通t申s韵y达d邮y政z德d邦b物w流l打d印y扫s码m识s图t翻f译y有y道d地d图t高g德d导d航h铁t路l飞f机j智z行x同t程c携x程c去q哪n儿r美m团t饿e了l么m哈h啰l滴d滴d青q骑q单d车c地d铁t火h车c票p航h班b酒j店d民m航h机j场c航h空k东d南n国g际j海h南n春c秋q华h夏x吉j祥x深s圳z上h海h北b京j广g州z杭h州z成c都d武w汉h西x安n南n京j重c庆q天t津j苏s州z厦x门m长c沙s青q岛d大d连l宁n波b无w锡x佛f山s东d莞g烟t台t温w州z绍s兴x嘉j兴x常c州z南n通t扬y州z泰t淮h盐y城c连l港g徐x宿s迁q镇z游y戏x平p台t平p板b电d视t盒h子z路l由y器q键j盘p鼠s标s显x示s器q耳e机j音y箱x摄s像x头t摄s影y相x机j照z相x图t片p音y频p文w档d表b格g演y示s文w字z办b公g设s备b驱q动d固g件j系x统t软r件j硬y件j程c序x代d码m编b辑j开k发f环h境j虚x拟n机j远y程d控k制z终z端d命m令l行h注z册c表b任r务w管g理l设s置s控k制z面b板b个g性x化h主z题t壁b纸z锁s屏p声s音y蓝l牙y无w线x网w卡k内n存m硬y盘p处c理l器q显x卡k主z板b电d源y风f扇s散s热r机j箱x台t式s一y体t本b轻q薄b商s务w学x生s教j育y课k堂t设s计j剪j辑j视s听t音y响x麦m克k风f摄s制z直z播b推t流l码m率f分f辨b率l像x素s帧z率l缓h存c加j速s下x载z上s传c断d点d续x传t种z子z磁c力l链l接j账z号h密m码m登d录l验y证m码m短d信x通t知z邮y箱x邮y件j日r历l闹n钟z提t醒x备b忘w录l清q单d表b单d签s名k盖g章z打d包y压y缩j解j压y恢h复f备b份f升s级j更g新x卸x载z安a装z绿l色j便b携x开k源y免m费f付f费f会h员y积j分d优y惠h券q红h包b折z扣k团t购g秒m杀s限x时s特t价j满m减j包b邮y退t货h售s后h客k服f投t诉s反f馈k帮b助z关g于y版b本n官g网w更g多d搜s索q发f现x推t荐j热r门b排p行b榜b分f类l标b签q收s藏c关g注z粉f丝s点d赞z评p论l转z发f分f享x复f制z粘z贴t保b存s删s除c编b辑j撤c销h重z做z全q选x反f选x导d出r导r入r刷s新x返f回h前q进j关g闭b打d开k新x建j剪j切t查c看k显x示s隐y藏c排p序x筛s选x过g滤l统t计j分f析x图t表b报b表b日r志z监j控k警j告g错c误w异y常k崩b溃k修r复f优y化h清q理l加j载l等d待w完w成g进j行d中z暂z停t停t止z继j续x开k始s结j束s" +
  /* [MSET]（ZTools 借鉴 #3）设置页标签补充字（各字多音同首字母，无歧义）。 */
  "幕m勿w扰r专z和h池c储c息x布b局j桌z夜y间j模m栏l描m仪y触c摸m自z放f络l状z态t以y太t数s据j使s量l背b景j颜y界j菜c定d夹j已y应y默m认r页y启q项x离l庭t组z其q他t期q区q域y语y言y添t议y截j辅f助z镜j旁p白b滞z指z针z讲j述s盲m对d比b私s概g位w权q别b活h史s心x找z的d可k激j疑y难n答d情q况k";

function parse(): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < DATA.length; i += 2) {
    const han = DATA[i];
    const letter = DATA[i + 1];
    // 防御：只有「汉字 + 小写字母」的对才进表，脏数据宁可丢弃也不污染映射。
    if (/[\u4e00-\u9fff]/.test(han) && /[a-z]/.test(letter)) {
      map.set(han, letter);
    }
  }
  return map;
}

const TABLE = /* @__PURE__ */ parse();

/**
 * 取字符串中每个汉字的拼音首字母；非汉字中的英数保留（小写化）、其余跳过。
 *
 * @param input - 任意字符串（应用名等）。
 * @returns 首字母串，如 `"网易云音乐"` → `"wyyy"`；时间复杂度 O(len)。
 * @throws 无。
 *
 * @example
 * ```ts
 * pinyinInitials("微信");     // "wx"
 * pinyinInitials("VS Code"); // "vscode"
 * ```
 */
export function pinyinInitials(input: string): string {
  let out = "";
  for (const ch of input) {
    if (TABLE.has(ch)) {
      out += TABLE.get(ch);
    } else if (/[a-z0-9]/i.test(ch)) {
      out += ch.toLowerCase();
    }
  }
  return out;
}
