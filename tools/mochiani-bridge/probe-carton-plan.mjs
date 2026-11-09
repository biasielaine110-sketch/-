/**
 * carton（漫剧编辑器）适配层探针 —— 纯离线，不连 MCP、不花钱、不写作品。
 *
 * 用真实抓下来的 `generation_settings`（gs-out.json 的 data.generationSettings）当输入，
 * 校验：模型/渠道目录怎么拼、参数类型怎么还原、素材名怎么匹配、配音怎么拆、文案怎么补名字。
 *
 * 跑法：
 *   MOCHIANI_BRIDGE_NO_LISTEN=1 node probe-carton-plan.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

process.env.MOCHIANI_BRIDGE_NO_LISTEN = "1";
// Windows 上动态 import 绝对路径必须是 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
const bridge = await import(pathToFileURL(path.join(here, "server.mjs")).href);

let failed = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failed += 1;
}

const gsPath = process.argv[2] || path.join(repoRoot, "gs-out.json");
if (!fs.existsSync(gsPath)) {
    console.log("SKIP  settings 快照不存在（默认找仓库根的 gs-out.json，也可以当第一个参数传路径）");
    console.log("      抓法：curl -X POST 'http://127.0.0.1:17399/api/tool?token=…' -d '{\"name\":\"mochiani_get_generation_settings\",\"args\":{…}}'");
} else {
    const video = JSON.parse(fs.readFileSync(gsPath, "utf8")).data.generationSettings.video;
    const models = bridge.buildCartonVideoModels(video);

    check("模型目录非空", models.length > 0, `${models.length} 个模型`);
    check("每个模型都有渠道", models.every((m) => m.channels.length > 0));
    check("modelKey 带 carton: 前缀", models.every((m) => m.modelKey.startsWith("carton:")));
    check("全部标成生视频（不会和生图混组）", models.every((m) => m.kind === "video"));
    check(
        "渠道 id 在同一模型内唯一",
        models.every((m) => new Set(m.channels.map((c) => c.id)).size === m.channels.length),
    );
    check("同名不同 id 拆成两条（Seedance 2.0）", models.filter((m) => m.modelName === "Seedance 2.0").length > 1);
    check(
        "参数值统一成字符串（duration 也要）",
        models.every((m) => Object.values(m.configInfo).every((list) => list.every((o) => typeof o.value === "string"))),
    );

    const h3 = models.find((m) => m.modelName.startsWith("Minimax H3"));
    check("H3 带 MochiAni 自己的默认参数", Boolean(h3?.defaultParams?.duration), JSON.stringify(h3?.defaultParams));

    // 字符串参数 → 原类型（duration 要还原成数字，否则 MochiAni 那边类型不对）
    const option = video.available_options.find((o) => String(o.model_id) === String(h3.modelId) && String(o.supplier_id) === h3.channels[0].id);
    const coerced = bridge.coerceCartonParams({ duration: "15", resolution: "768P", model_size: "9:16" }, option);
    check("duration 还原成数字", coerced.duration === 15, `${typeof coerced.duration} ${coerced.duration}`);
    check("分辨率保持字符串", coerced.resolution === "768P", String(coerced.resolution));
    check("画幅原样透传", coerced.model_size === "9:16", String(coerced.model_size));
}

// 素材名匹配
const assets = [
    { id: "c1", name: "林晚", kind: "character" },
    { id: "c2", name: "陆沉", kind: "character" },
    { id: "s1", name: "老宅客厅", kind: "scene" },
    { id: "p1", name: "铜钥匙", kind: "prop" },
];
check("精确匹配", bridge.matchCartonAsset("林晚", assets)?.id === "c1");
check("带空格也能匹配", bridge.matchCartonAsset(" 林 晚 ", assets)?.id === "c1");
check("包含匹配（「老宅」→ 老宅客厅）", bridge.matchCartonAsset("老宅", assets)?.id === "s1");
check("匹配不到返回 null", bridge.matchCartonAsset("不存在的角色", assets) === null);

// 素材库返回结构不确定 → 靠 id+name 认对象，靠字段/键名判类别
const fakeContext = {
    characters: [{ id: "c1", name: "林晚", assetType: "character" }],
    scenes: [{ id: "s1", name: "老宅客厅" }],
    props: [{ assetId: "p1", name: "铜钥匙", type: "prop" }],
    shots: [{ id: "not-an-asset" }],
};
const collected = bridge.collectCartonAssets(fakeContext);
check("认出 3 个素材", collected.length === 3, collected.map((a) => `${a.kind}:${a.name}`).join(","));
check("按数组键名兜底判类别（场景没写 assetType）", collected.some((a) => a.id === "s1" && a.kind === "scene"));
check("没有 name 的对象不算素材", !collected.some((a) => a.id === "not-an-asset"));

// 文案补名字：MochiAni 要求关联的素材正式名必须出现在 script 里
const composed = bridge.composeCartonScript("她推开门，屋里没人。", {
    character: ["林晚"],
    scene: ["老宅客厅"],
    prop: [],
});
check("缺的名字补进文案", composed.script.includes("林晚") && composed.script.includes("老宅客厅"));
check("补了什么要报出来", composed.added.length === 2, composed.added.join("、"));
const noCompose = bridge.composeCartonScript("林晚走进老宅客厅。", { character: ["林晚"], scene: ["老宅客厅"], prop: [] });
check("名字都在就不动文案", noCompose.script === "林晚走进老宅客厅。" && noCompose.added.length === 0);

// 配音逐行解析
const lines = bridge.parseVoiceLines("林晚：这门我从来没开过。\n\n陆沉: 那你现在开。\n（旁白）");
check("解析出 3 行", lines.length === 3, JSON.stringify(lines));
check("中英文冒号都认", lines[0].characterName === "林晚" && lines[1].characterName === "陆沉");
check("没冒号的算旁白（没有角色）", lines[2].characterName === "");

// 配音角色候选
const voiceCharacters = bridge.collectVoiceCharacters({
    generationSettings: {
        voiceover: {
            characters: [{ characterId: "vc1", characterName: "林晚" }],
            shots: [{ shotId: "s1", items: [{ itemId: "i1", text: "台词" }] }],
        },
    },
});
check("捞出配音角色", voiceCharacters.length === 1 && voiceCharacters[0].id === "vc1", JSON.stringify(voiceCharacters));

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
