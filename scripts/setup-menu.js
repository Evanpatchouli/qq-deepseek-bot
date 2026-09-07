import {
  ApiClient,
  TokenManager,
} from "@tencent-connect/qqbot-nodejs/protocol";

const appId = process.env.QQBOT_APP_ID;
const appSecret = process.env.QQBOT_APP_SECRET;

if (!appId || !appSecret) {
  throw new Error("缺少 QQBOT_APP_ID 或 QQBOT_APP_SECRET");
}

const tokenManager = new TokenManager();
const api = new ApiClient();

const accessToken = await tokenManager.getAccessToken(
  appId,
  appSecret,
);

const menu = {
  items: [
    {
      type: "send_message",
      name: "聊聊",
      send_message: "陪我聊聊天吧",
    },

    {
      type: "menu",
      name: "生活",
      sub_menu_items: [
        {
          type: "send_message",
          name: "天气",
          send_message: "帮我看看今天的天气，并告诉我该怎么穿",
        },
        {
          type: "send_message",
          name: "穿搭",
          send_message: "帮我搭配一下今天的衣服",
        },
        {
          type: "send_message",
          name: "记账",
          send_message: "我要记一笔账：",
        },
        {
          type: "send_message",
          name: "笔记",
          send_message: "帮我记个笔记：",
        },
        {
          type: "send_message",
          name: "小确幸",
          send_message: "记录一下今天的小确幸：",
        },
      ],
    },

    {
      type: "menu",
      name: "更多",
      sub_menu_items: [
        {
          type: "send_message",
          name: "调查",
          send_message: "帮我调查一下：",
        },
        {
          type: "send_message",
          name: "清空对话",
          send_message: "/reset",
        },
        {
          type: "send_message",
          name: "帮助",
          send_message: "/help",
        },
      ],
    },
  ],
};

try {
  const result = await api.request(
    accessToken,
    "PUT",
    "/v2/menu",
    menu,
  );

  console.log("✅ Qgent 自定义菜单配置成功！");
  console.log(result);
} catch (error) {
  console.error("❌ 菜单配置失败：");
  console.error(error);
  process.exit(1);
}