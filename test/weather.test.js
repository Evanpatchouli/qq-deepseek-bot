import test from "node:test";
import assert from "node:assert/strict";
import { WeatherClient } from "../src/weather.js";
import { DeepSeekClient } from "../src/deepseek.js";
import { executeQgentTool } from "../src/tools.js";

const data = { city: "乌鲁木齐", weather: "晴", temperature: 0, report_time: "2026-09-14 10:00:00" };
const ok = () => ({ ok: true, json: async () => data });

test("weather sends key only in header and preserves zero temperature and source time", async () => {
  const client = new WeatherClient({ apiKey: "test-key", extended: true, fetchImpl: async (url, options) => {
    assert.equal(url.origin + url.pathname, "https://uapis.cn/api/v1/misc/weather");
    assert.equal(url.searchParams.get("city"), "乌鲁木齐");
    assert.equal(url.searchParams.get("forecast"), "true");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    assert.equal(url.href.includes("test-key"), false);
    return ok();
  } });
  const result = await client.getWeather({ city: " 乌鲁木齐 " });
  assert.equal(result.weather.temperature, 0);
  assert.equal(result.weather.report_time, data.report_time);
  assert.equal(result.weather.feels_like, undefined);
});

test("invalid location and missing key never make a request", async () => {
  const client = new WeatherClient({ fetchImpl: () => assert.fail("unexpected fetch") });
  for (const args of [{}, { city: " " }, { city: 3 }, { city: "a".repeat(101) }, { city: "北京", apiKey: "x" }, []]) {
    await assert.rejects(client.getWeather(args), /城市/);
  }
  await assert.rejects(client.getWeather({ city: "北京" }), /UAPI_API_KEY/);
});

for (const status of [400, 401, 402, 403, 404, 429, 500]) {
  test(`HTTP ${status} returns safe failure without response body`, async () => {
    const client = new WeatherClient({ apiKey: "secret", fetchImpl: async () => ({ ok: false, status, json: () => assert.fail("must not read error body") }) });
    await assert.rejects(client.getWeather({ city: "北京" }), (error) => !error.message.includes("secret"));
  });
}

test("malformed or incomplete success responses are rejected", async () => {
  for (const json of [async () => { throw new SyntaxError(); }, async () => ({}), async () => ({ ...data, temperature: null })]) {
    const client = new WeatherClient({ apiKey: "x", fetchImpl: async () => ({ ok: true, json }) });
    await assert.rejects(client.getWeather({ city: "北京" }));
  }
});

test("timeout covers response body consumption", async () => {
  const client = new WeatherClient({ apiKey: "x", timeoutMs: 10, fetchImpl: async (url, { signal }) => ({
    ok: true, json: () => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("abort")), { once: true })),
  }) });
  await assert.rejects(client.getWeather({ city: "北京" }), /超时/);
});

test("network error does not expose credentials", async () => {
  const client = new WeatherClient({ apiKey: "secret", fetchImpl: async () => { throw new Error("secret"); } });
  await assert.rejects(client.getWeather({ city: "北京" }), /^Error: 无法连接天气服务/);
});

test("weather tool cannot touch private storage and validates arguments", async () => {
  const weather = new WeatherClient({ apiKey: "x", fetchImpl: async () => ok() });
  const call = { name: "qgent_get_weather", arguments: '{"city":"北京"}' };
  assert.equal((await executeQgentTool({ call, userId: "user-a", weather })).success, true);
  await assert.rejects(executeQgentTool({ call, weather }), /用户标识/);
  await assert.rejects(executeQgentTool({ call: { ...call, arguments: "{" }, userId: "user-a", weather }), /JSON/);
});

for (const failed of [false, true]) {
  test(`AI receives weather ${failed ? "failure" : "success"} and retains web search`, async () => {
    const client = new DeepSeekClient({ apiKey: "fake", model: "fake", systemPrompt: "test", weather: {
      getWeather: async () => { if (failed) throw new Error("天气查询超时"); return { success: true, weather: data }; },
    } });
    let requests = 0;
    client.client.responses.create = async (request) => {
      requests++;
      assert.ok(request.tools.some((tool) => tool.name === "qgent_get_weather"));
      assert.ok(request.tools.some((tool) => tool.type === "web_search"));
      if (requests === 1) return { output: [{ type: "function_call", name: "qgent_get_weather", call_id: "w1", arguments: '{"city":"北京"}' }] };
      const result = JSON.parse(request.input.at(-1).output);
      assert.equal(result.success, !failed);
      return { output_text: failed ? "查询失败" : "天气已查询" };
    };
    assert.equal(await client.chat({ history: [], prompt: "北京天气", userId: "user-a" }), failed ? "查询失败" : "天气已查询");
    assert.equal(requests, 2);
  });
}

test("repeated weather calls stop at configured round limit", async () => {
  const client = new DeepSeekClient({ apiKey: "fake", model: "fake", systemPrompt: "", maxToolRounds: 2,
    weather: { getWeather: async () => ({ success: true, weather: data }) } });
  let requests = 0;
  client.client.responses.create = async () => {
    requests++;
    return { output: [{ type: "function_call", name: "qgent_get_weather", call_id: String(requests), arguments: '{"city":"北京"}' }] };
  };
  await assert.rejects(client.chat({ history: [], prompt: "天气", userId: "a" }), /round limit/);
  assert.equal(requests, 2);
});
