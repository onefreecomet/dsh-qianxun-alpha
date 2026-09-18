import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
//#region lib/types/index.js
/**
* @deepseek-ai/dsh-qianxun-tab — 千寻回测控制台（dsh-better-sidebar 自定义 tab）。
*
* 本文件是 Node（宿主）半区入口：把「提示词」从浏览器 localStorage 迁到宿主的
* 服务端存储，并在 `/api/dsh-qianxun-tab/prompts` 上暴露给浏览器半区调用。
* 背景：localStorage 按「浏览器 profile × 源（协议+主机+端口）」隔离，Safari 里
* 存的提示词 Chrome 看不到；DSH Desktop 每次启动都用 `reservePort()` 拿一个新的
* 随机端口（origin 每次都变），localStorage 因此每次都是空桶。改为服务端存储后，
* 同一台机器上的任何浏览器/任何端口看到的都是同一份数据。
*
* 数据落盘：`$DSH_HOME/qianxun/prompts.json`
*   { version, rev, updatedAt, prompts: [{ id, name, content, created_at, updated_at }] }
* 写入是原子的（临时文件 + rename），并按到达顺序串行化，避免并发覆盖。
*
* 路由（exact，同源 fetch）：
*   GET    /api/dsh-qianxun-tab/prompts  → { ok, rev, updatedAt, prompts }
*   PUT    /api/dsh-qianxun-tab/prompts  ← { prompts } → { ok, rev, updatedAt, count }
*
* 浏览器半区（`exports["./client"]`）仍负责 tab 注册与 UI。
*
* 关于 `inject`：`betterSidebar` 是浏览器端服务，绝不能出现在这里；`webServer` 则
* **必须**声明为宿主依赖。原因是 cordis 的服务读取默认走 strict：
*   `ctx.get(name)` → `reflect._getImpl(name, true)` →
*   `if (strict && impl.fiber.state !== FiberState.ACTIVE) return undefined`
* 服务提供方（host-webserver）的 `[Service.init]` 是异步的（要 listen），启动期各
* 插件按顺序 apply；不声明 inject 时本插件会先跑、`ctx.get('webServer')` 拿到
* undefined，路由就被静默跳过了（2026-09-12 实测踩到：桌面版端点一直 401）。
* 声明 `inject: ['webServer']` 后 cordis 会把本插件推迟到该服务可用之后再 apply。
* 非 web profile 没有 webServer 时本插件保持 pending，不会报错。
*/
/** cordis.yml 插件行使用的插件名。 */
const name = "dsh-qianxun-tab";
/**
* Node 半区需要注入的服务。
*
* `webServer` 必须在这里声明：cordis 的 `ctx.get()` 默认是 strict 读取，服务提供方
* 的 fiber 未 ACTIVE 时返回 undefined（host-webserver 的 init 是异步 listen），
* 声明后由 cordis 负责推迟 apply，避免启动期竞态导致路由静默丢失。
* 宿主侧没有 `betterSidebar`（那是浏览器端服务），不能出现在这里。
*/
const inject = ["webServer"];
/** 浏览器半区调用的提示词端点。 */
const ROUTE_PATH = "/api/dsh-qianxun-tab/prompts";
/** 落盘格式版本（未来结构变更时可据此迁移）。 */
const STORE_VERSION = 1;
/** 单条提示词内容上限（字符），与浏览器半区一致。 */
const MAX_CONTENT = 2e4;
/** JSON 请求体上限：提示词是纯文本，2 MiB 远高于实际上限。 */
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
/** DSH 主目录：宿主进程注入的 `DSH_HOME`，否则 `~/.dsh`。 */
function resolveDshHome() {
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
	return join(homedir(), ".dsh");
}
/** 提示词落盘文件。 */
function storePath() {
	return join(resolveDshHome(), "qianxun", "prompts.json");
}
/** 单条归一：结构不合法返回 undefined（整条丢弃）。 */
function normalizePrompt(raw) {
	if (raw === null || typeof raw !== "object") return void 0;
	const source = raw;
	const id = source["id"];
	const name = source["name"];
	const content = source["content"];
	if (typeof id !== "string" || id === "") return void 0;
	if (typeof name !== "string" || typeof content !== "string") return void 0;
	const now = Date.now();
	const createdAt = typeof source["created_at"] === "number" && Number.isFinite(source["created_at"]) ? source["created_at"] : now;
	const updatedAt = typeof source["updated_at"] === "number" && Number.isFinite(source["updated_at"]) ? source["updated_at"] : createdAt;
	return {
		id,
		name: name.trim() === "" ? "未命名提示词" : name.trim(),
		content: content.slice(0, MAX_CONTENT),
		created_at: createdAt,
		updated_at: updatedAt
	};
}
/** 列表归一：过滤非法条目、按 id 去重（后者胜）、截断到条数上限。 */
function normalizeList(raw) {
	if (!Array.isArray(raw)) return [];
	const byId = /* @__PURE__ */ new Map();
	for (const item of raw) {
		const prompt = normalizePrompt(item);
		if (prompt !== void 0) byId.set(prompt.id, prompt);
	}
	return [...byId.values()].slice(-200);
}
/** 空存储（文件缺失或损坏时的兜底）。 */
function emptyStore() {
	return {
		version: STORE_VERSION,
		rev: 0,
		updatedAt: 0,
		prompts: []
	};
}
/** 读取存储；文件不存在或解析失败一律按空存储处理，绝不因数据损坏让插件报错。 */
async function readStore() {
	let raw;
	try {
		raw = await readFile(storePath(), "utf8");
	} catch {
		return emptyStore();
	}
	try {
		const parsed = JSON.parse(raw);
		return {
			version: STORE_VERSION,
			rev: typeof parsed["rev"] === "number" && Number.isFinite(parsed["rev"]) ? parsed["rev"] : 0,
			updatedAt: typeof parsed["updatedAt"] === "number" && Number.isFinite(parsed["updatedAt"]) ? parsed["updatedAt"] : 0,
			prompts: normalizeList(parsed["prompts"])
		};
	} catch {
		return emptyStore();
	}
}
/** 原子写：先写同目录临时文件再 rename，避免读到半截 JSON。 */
async function writeStore(prompts) {
	const store = {
		version: STORE_VERSION,
		rev: (await readStore()).rev + 1,
		updatedAt: Date.now(),
		prompts
	};
	const target = storePath();
	await mkdir(dirname(target), { recursive: true });
	const tmp = `${target}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
	try {
		await rename(tmp, target);
	} catch (error) {
		await unlink(tmp).catch(() => void 0);
		throw error;
	}
	return store;
}
/**
* 串行化写入：浏览器半区会防抖推送，但仍可能并发到达；链式排队保证
* 「读旧 rev → 写新 rev」不交叉，最后写入者胜。
*/
let writeChain = Promise.resolve();
/** 排队一次全量替换写入。 */
function enqueueWrite(prompts) {
	const next = writeChain.then(() => writeStore(prompts), () => writeStore(prompts));
	writeChain = next.catch(() => void 0);
	return next;
}
/**
* 与 dsh-config-manager 一致的 loopback + 同源围栏：只接受来自本机回环、
* Host 为回环字面量、且不带跨站标记的请求。绑到 0.0.0.0 的部署不会提供该端点，
* 此时浏览器半区自动回落到 localStorage（每浏览器独立，但功能不中断）。
*/
function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/** 统一的 JSON 响应（无缓存、不泄漏来源）。 */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}
/** 读 JSON 请求体；超限、空体或不是合法 JSON 对象时返回 undefined。 */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > MAX_JSON_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	if (size === 0) return void 0;
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return void 0;
		return parsed;
	} catch {
		return;
	}
}
/** 提示词端点的唯一处理器：GET 读全量，PUT/POST 全量替换。 */
async function handlePrompts(req, res) {
	if (!isLoopbackRequest(req)) {
		writeJson(res, 403, {
			ok: false,
			error: "forbidden"
		});
		return;
	}
	if (req.method === "GET") {
		const store = await readStore();
		writeJson(res, 200, {
			ok: true,
			rev: store.rev,
			updatedAt: store.updatedAt,
			prompts: store.prompts
		});
		return;
	}
	if (req.method === "PUT" || req.method === "POST") {
		if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
			writeJson(res, 415, {
				ok: false,
				error: "expected application/json"
			});
			return;
		}
		const body = await readJsonBody(req);
		if (body === void 0) {
			writeJson(res, 400, {
				ok: false,
				error: "invalid JSON body"
			});
			return;
		}
		const store = await enqueueWrite(normalizeList(body["prompts"]));
		writeJson(res, 200, {
			ok: true,
			rev: store.rev,
			updatedAt: store.updatedAt,
			count: store.prompts.length
		});
		return;
	}
	writeJson(res, 405, {
		ok: false,
		error: "method not allowed"
	});
}
/**
* Node 半区挂载：把提示词端点注册到宿主的 webServer。
*
* `inject: ['webServer']` 已保证 apply 时该服务可用；这里的兜底分支只作防御，
* 且**必须留日志**——2026-09-12 的故障就是这条路径曾经静默 return，导致路由没注册
* 却在日志里查不到任何痕迹（浏览器半区只会安静地回落到 localStorage）。
*/
function apply(ctx) {
	const webServer = ctx.get("webServer");
	if (webServer === void 0 || webServer === null) {
		ctx.logger.warn("dsh-qianxun-tab: webServer 服务不可用，提示词端点未注册（浏览器半区将回落 localStorage：换浏览器/换端口会看不到提示词）");
		return;
	}
	const route = {
		kind: "exact",
		path: ROUTE_PATH,
		handler: handlePrompts
	};
	ctx.effect(() => {
		try {
			const dispose = webServer.register(route);
			ctx.logger.info(`dsh-qianxun-tab: 已注册提示词端点 ${ROUTE_PATH}（存储 $DSH_HOME/qianxun/prompts.json）`);
			return () => {
				dispose();
			};
		} catch (error) {
			ctx.logger.warn(`dsh-qianxun-tab: 提示词路由注册失败: ${String(error)}`);
			return () => void 0;
		}
	}, "dsh-qianxun-tab: /api/dsh-qianxun-tab/prompts route");
}
//#endregion
export { apply, inject, name };
