/**
 * 画布口径「资产绑定换名字」探针 —— 纯离线，不连 MCP、不花钱、不写画布。
 *
 * 用户报障（2026-11-15）：「画布模式下发送过去的资产绑定，我的画布是 @图片1、@图片2，
 * 而 mochani 的画布资产锁定似乎是另一个名字，需要发送过去的时候把资产锁定自行适配成
 * mochani 画布能锁定的名字。」
 *
 * 真实数据（本机实读，2026-11-15）：
 *   · `mochiani_canvas_read` 里上传节点标题 = `mj_mwh8qa6b_drnkc-image-1` … `-image-5`；
 *   · `mochiani_canvas_generation_context` 的 `currentPrompt` =
 *     `资产绑定：粉裙女@mj_mwh8qa6b_drnkc-image-1@@图片1、皮衣男@图片2、…`
 *     → chip 渲染成 `@<节点标题>`，我们写的 `@图片1` 只是死文字。
 *
 * 跑法：
 *   MOCHIANI_BRIDGE_NO_LISTEN=1 node probe-canvas-bindings.mjs
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.MOCHIANI_BRIDGE_NO_LISTEN = "1";
const bridge = await import(pathToFileURL(path.join(here, "server.mjs")).href);
const { planPromptAssetBindings, collectCanvasReferences, isSameCanvasPrompt } = bridge;

let failed = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failed += 1;
}

const MJ = (n) => `mj_mwh8qa6b_drnkc-image-${n}`;
const ref = (id, name) => ({ referenceId: id, name });
const refsFor = (count) => Array.from({ length: count }, (_, index) => ref(`ref-${index + 1}`, MJ(index + 1)));
const titlesFor = (count) => Array.from({ length: count }, (_, index) => MJ(index + 1));

// ── ① 真实文案：编号换成结构化引用，且渲染成 MochiAni 的名字 ──────────────────────────
{
    const prompt = "资产绑定：粉裙女@图片1、皮衣男@图片2、番茄女@图片3、朋友@图片4、场景街边药店@图片5";
    const plan = planPromptAssetBindings({ prompt, titles: { image: titlesFor(5) }, references: refsFor(5) });
    check("5 条全部换成引用", plan.chipCount === 5 && plan.textCount === 0, JSON.stringify({ chip: plan.chipCount, text: plan.textCount }));
    check("不再残留 @图片N", !/@图片\d/.test(plan.rendered), plan.rendered);
    check("渲染成 MochiAni 的节点标题", plan.rendered.startsWith("资产绑定：粉裙女@mj_mwh8qa6b_drnkc-image-1、皮衣男@mj_mwh8qa6b_drnkc-image-2"), plan.rendered);
    check("文字与引用交替、顺序不乱", plan.segments.map((segment) => (segment.referenceId ? `[${segment.referenceId}]` : segment.text)).join("") ===
        `资产绑定：粉裙女[ref-1]、皮衣男[ref-2]、番茄女[ref-3]、朋友[ref-4]、场景街边药店[ref-5]`, JSON.stringify(plan.segments));
}

// ── ② 拿不到 referenceId（面板没挂载 / 引用还没生成）→ 退化成名字文本，别留死编号 ────────
{
    const prompt = "资产绑定：女模@图片1";
    const plan = planPromptAssetBindings({ prompt, titles: { image: [MJ(1)] }, references: [] });
    check("无引用时退化成名字文本", plan.chipCount === 0 && plan.textCount === 1, JSON.stringify(plan));
    check("退化后仍是可读的名字", plan.segments.length === 2 && plan.segments[1].text === `@${MJ(1)}`, JSON.stringify(plan.segments));
    check("两种情况渲染结果一致（可用同一个期望值核验）", plan.rendered === planPromptAssetBindings({ prompt, titles: { image: [MJ(1)] }, references: refsFor(1) }).rendered);
}

// ── ③ 编号超界 / 中间缺图：原样保留，并报 unresolved（绝不挪位猜）──────────────────────
{
    const prompt = "A@图片1 B@图片5";
    const plan = planPromptAssetBindings({ prompt, titles: { image: [MJ(1)] }, references: refsFor(1) });
    check("超界编号原样保留", plan.rendered.includes("@图片5"), plan.rendered);
    check("超界被报出来", plan.unresolved.length === 1 && plan.unresolved[0].marker === "@图片5", JSON.stringify(plan.unresolved));

    const gap = planPromptAssetBindings({ prompt: "A@图片2", titles: { image: [MJ(1)] }, references: refsFor(1) });
    check("中间缺图不挪位（图片2 不借用图片1 的名字）", gap.rendered === "A@图片2" && gap.chipCount === 0, gap.rendered);
}

// ── ④ 不带 @ 的「图片1」不动（避免把「1:1 画幅」「第图片1镜」这类正文改坏）───────────────
{
    const plan = planPromptAssetBindings({ prompt: "参考图片1 和图片2，画幅 1:1", titles: { image: titlesFor(2) }, references: refsFor(2) });
    check("没有 @ 的编号不动", plan.segments.length === 1 && plan.segments[0].text === "参考图片1 和图片2，画幅 1:1", JSON.stringify(plan.segments));
}

// ── ⑤ 脚本生成器那种多行「资产锁定」块 ────────────────────────────────────────────────
{
    const prompt = "- **资产锁定：**\n@图片1 女模：女模人物参考，锁定面容、发型。\n@图片2 白色得皮包：链条包参考。";
    const plan = planPromptAssetBindings({ prompt, titles: { image: titlesFor(2) }, references: refsFor(2) });
    check("多行块也换成引用", plan.chipCount === 2, plan.chipCount);
    check("行首「女模：…」文字保留", plan.rendered.includes("\n女模：女模人物参考") || plan.rendered.includes("@mj_mwh8qa6b_drnkc-image-1 女模：女模人物参考"), plan.rendered);
    check("第二行也换了", plan.rendered.includes(`@${MJ(2)} 白色得皮包`), plan.rendered);
}

// ── ⑥ 视频 / 音频编号各走各的（同类型各自计数）──────────────────────────────────────
{
    const plan = planPromptAssetBindings({
        prompt: "@图片1 @视频1 @音频1",
        titles: { image: ["img-a"], video: ["vid-a"], audio: ["aud-a"] },
        references: [ref("r-img", "img-a"), ref("r-vid", "vid-a"), ref("r-aud", "aud-a")],
    });
    check("三种素材各自命中", plan.segments.filter((s) => s.referenceId).map((s) => s.referenceId).join() === "r-img,r-vid,r-aud", JSON.stringify(plan.segments));
}

// ── ⑦ 引用名字带后缀 / 去扩展名也能对上（MochiAni 命名不完全可控）────────────────────
{
    const plan = planPromptAssetBindings({
        prompt: "@图片1",
        titles: { image: [MJ(1)] },
        references: [ref("r1", `${MJ(1)}.png`)],
    });
    check("引用名带扩展名也认", plan.chipCount === 1 && plan.segments.some((segment) => segment.referenceId === "r1"), JSON.stringify(plan.segments));
}

// ── ⑧ 从回执里抠引用：字段名不统一（referenceId / id、name / title）都要收 ──────────────
{
    const list = collectCanvasReferences({
        references: [{ referenceId: "a", name: "n1" }, { id: "b", title: "n2" }, { name: "没有 id 的" }],
        availableReferences: [{ referenceId: "a", name: "n1" }],
    });
    check("两种字段名都收到 + 去重 + 丢掉无 id", list.length === 2 && list[0].id === "a" && list[1].id === "b", JSON.stringify(list));
    check("空回执不炸", collectCanvasReferences(null).length === 0 && collectCanvasReferences({}).length === 0);
}

// ── ⑨ 回读核验口径：只剩空白差异放过，丢段落必须报错 ────────────────────────────────
{
    check("完全一致", isSameCanvasPrompt("甲\n乙", "甲\n乙"));
    check("chip 空格差异放过", isSameCanvasPrompt("粉裙女@x-image-1、皮衣男@x-image-2", "粉裙女@x-image-1 、 皮衣男@x-image-2"));
    check("丢了一段必须报错", !isSameCanvasPrompt("甲", "甲\n乙"));
    check("换了名字必须报错", !isSameCanvasPrompt("@图片1", "@x-image-1"));
}

// ── ⑩ 没有编号时整段原样返回（别把提示词改坏）────────────────────────────────────────
{
    const prompt = "纯文案，没有任何引用编号";
    const plan = planPromptAssetBindings({ prompt, titles: { image: titlesFor(2) }, references: refsFor(2) });
    check("无编号原样返回", plan.segments.length === 1 && plan.rendered === prompt, JSON.stringify(plan.segments));
    check("空提示词不炸", planPromptAssetBindings({}).segments.length === 0);
}

console.log(`\n${failed ? "FAIL" : "OK"}  probe-canvas-bindings: ${failed ? `${failed} 条失败` : "全部通过"}`);
process.exit(failed ? 1 : 0);
