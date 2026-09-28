/**
 * 生图后端配置文件。把渠道的 API Key 放这里（服务端持有，不暴露给前端）。
 * 支持多个 Key：余额不足时自动切换到下一个（仅 RunningHub 渠道实现，见 runninghub.js）。
 */
export const config = {
  port: 8787,

  // 允许跨域访问的前端来源（你的网站画布地址）。留空数组表示允许任意来源。
  allowedOrigins: [],

  // RunningHub 渠道
  runninghub: {
    baseUrl: "https://www.runninghub.cn",
    // 每行一个 Key，第一个为主 Key，其余为备用 Key（余额不足自动切换）
    apiKeys: [
      "你的RunningHub主Key",
      // "备用Key1",
      // "备用Key2",
    ],
    // 默认工作流 ID（Qwen Image 2.1 文生图）。可在请求里用 model 覆盖。
    defaultWorkflowId: "2102725625755820033",
  },

  // OpenAI 兼容渠道（方舟 / 豆包 / 任意 /v1/images/generations 服务）
  openai: {
    baseUrl: "https://api.openai.com", // 会自动拼 /v1
    apiKey: "你的OpenAI兼容Key",
    model: "gpt-image-1",
  },
};
