import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeekBalanceClient, formatDeepSeekBalance } from "../src/balance.js";

test("getBalance calls official endpoint with bearer token", async () => {
  let request = null;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          is_available: true,
          balance_infos: [
            {
              currency: "CNY",
              total_balance: "12.34",
              granted_balance: "2.34",
              topped_up_balance: "10.00",
            },
          ],
        };
      },
    };
  };

  const client = new DeepSeekBalanceClient({
    apiKey: "test-key",
    baseURL: "https://api.deepseek.com/",
    fetchImpl,
  });

  const result = await client.getBalance();
  assert.equal(request.url, "https://api.deepseek.com/user/balance");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.equal(result.balance_infos[0].total_balance, "12.34");
});

test("formatDeepSeekBalance renders CNY balance", () => {
  const text = formatDeepSeekBalance({
    is_available: true,
    balance_infos: [
      {
        currency: "CNY",
        total_balance: "12.34",
        granted_balance: "2.34",
        topped_up_balance: "10.00",
      },
    ],
  });

  assert.match(text, /DeepSeek API 余额/);
  assert.match(text, /CNY：¥12\.34/);
  assert.match(text, /充值余额：¥10\.00/);
  assert.match(text, /赠送余额：¥2\.34/);
});

test("getBalance converts 401 into friendly error", async () => {
  const client = new DeepSeekBalanceClient({
    apiKey: "bad-key",
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async json() {
        return { error: { message: "Unauthorized" } };
      },
    }),
  });

  await assert.rejects(client.getBalance(), /API Key 无效/);
});
