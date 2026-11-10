/**
 * 「文案指图 → 素材」解析探针 —— 纯离线，不连 MCP、不花钱、不写作品。
 *
 * 覆盖 `parseImageBindings()`：用户写的 `@图片1 为男主` 这类标记，
 * 决定「图挂到哪个素材」这件事能不能成立。误判的两个方向都很贵：
 * 漏解析 = 图根本不发；乱解析 = 在图库里凭空建一堆垃圾素材。
 *
 * 跑法：
 *   MOCHIANI_BRIDGE_NO_LISTEN=1 node probe-carton-bindings.mjs
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

process.env.MOCHIANI_BRIDGE_NO_LISTEN = "1";
const bridge = await import(pathToFileURL(path.join(here, "server.mjs")).href);
const { parseImageBindings } = bridge;

let failed = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failed += 1;
}
const flat = (list) => list.map((item) => `${item.marker}>${item.kind}:${item.name}@${item.index}`).join(" | ");

// 1) 用户真实那一份文案（3 张图，写作 @图片1 / 图片2 / 图片3，混用 @）
{
    const prompt =
        "@图片1 为男主，图片2 为女主，图片3 为路人，\n一只橘猫在窗台睡觉，打呼噜\n风格模板「国产都市」：中国新写实主义都市剧情片，纪实美学风格";
    const got = parseImageBindings(prompt, 3);
    check("真实文案解析出 3 条", got.length === 3, flat(got));
    check(
        "三条都落到 character",
        got.every((item) => item.kind === "character"),
        got.map((item) => item.kind).join(","),
    );
    check(
        "index 与图片顺序对齐（图片1→0）",
        got[0]?.index === 0 && got[1]?.index === 1 && got[2]?.index === 2,
        got.map((item) => item.index).join(","),
    );
    check("名字正确", got.map((item) => item.name).join(",") === "男主,女主,路人", got.map((item) => item.name).join(","));
}

// 2) 图片数量不足时不能瞎指
{
    const got = parseImageBindings("@图片1 为男主，图片2 为女主", 1);
    check("只有 1 张图时只解析第 1 条", got.length === 1, flat(got));
    check("0 张图时一条都不解析", parseImageBindings("@图片1 为男主", 0).length === 0);
}

// 3) 连接词的各种写法
{
    const cases = [
        ["@图片1 是男主", "男主"],
        ["@图片1=男主", "男主"],
        ["@图片1：男主", "男主"],
        ["@图片1 → 男主", "男主"],
        ["@图片1 作为男主", "男主"],
        ["图片2 为 女主", "女主"],
    ];
    for (const [prompt, want] of cases) {
        const got = parseImageBindings(prompt, 3);
        check(`连接词写法：${prompt}`, got[0]?.name === want, flat(got));
    }
}

// 4) 不认连接词就不解析（避免把正文里的「参考图片1 和图片2」当成素材名）
{
    check("无连接词不解析", parseImageBindings("参考图片1 和图片2 的构图", 3).length === 0);
}

// 5) 类别前缀 + 括号备注
{
    const got = parseImageBindings("@图片1 为场景 咖啡馆，@图片2 为道具 台灯，@图片3 为角色 男主（林晚）", 3);
    check(
        "场景/道具/角色前缀决定 assetType",
        got.map((item) => `${item.kind}:${item.name}`).join(",") === "scene:咖啡馆,prop:台灯,character:男主",
        flat(got),
    );
}

// 6) 同一素材写两遍只留第一条（第二条图不该覆盖第一条）
{
    const got = parseImageBindings("@图片1 为男主，@图片2 为男主", 3);
    check("同名素材去重", got.length === 1, flat(got));
}

// 7) 名字里带标点要截断，别把整句吞进去
{
    const got = parseImageBindings("@图片1 为男主。他站在窗边，@图片2 为女主！", 2);
    check(
        "句号/叹号截断名字",
        got.map((item) => item.name).join(",") === "男主,女主",
        flat(got),
    );
}

// 8) 摘声明：分镜文案里不能留「图片1 为男主」这种给桥看的字
{
    const { stripImageBindingMarkers, composeCartonScript } = bridge;
    const prompt =
        "@图片1 为男主，图片2 为女主，图片3 为路人，\n一只橘猫在窗台睡觉，打呼噜\n风格模板「国产都市」：纪实美学风格";
    const clean = stripImageBindingMarkers(prompt);
    check("文案里不再有 图片N", !/图片\s*[0-9]/.test(clean), JSON.stringify(clean));
    check("正文和风格模板都还在", clean.includes("橘猫") && clean.includes("风格模板"), JSON.stringify(clean));
    check("行首没有残留逗号", !/^[ \t]*[，,]/.test(clean), JSON.stringify(clean));
    const composed = composeCartonScript(clean, { character: ["男主", "女主", "路人"], scene: [], prop: [] });
    check(
        "素材名被补回文案（MochiAni 硬要求）",
        composed.added.length === 3 && composed.script.includes("男主、女主、路人"),
        JSON.stringify(composed.added),
    );
    check("没解析出绑定时不改文案", stripImageBindingMarkers("一只橘猫在窗台睡觉") === "一只橘猫在窗台睡觉");
}

// 9) 超界检测：文案点了图 3，但只连了 2 张 → 必须能被发现（否则就是「图静默丢掉」）
{
    const { readImageMarkerIndices } = bridge;
    const indices = readImageMarkerIndices("@图片1 为男主，@图片3 为路人");
    check("读到所有指图序号", indices.join(",") === "1,3", indices.join(","));
    const outOfRange = [...new Set(indices)].filter((n) => n > 2);
    check("超界序号可被识别", outOfRange.join(",") === "3", outOfRange.join(","));
    check("无标记时为空", readImageMarkerIndices("一只猫").length === 0);
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
