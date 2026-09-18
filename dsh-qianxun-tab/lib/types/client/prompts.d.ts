/**
 * prompts.ts — 千寻侧边栏「提示词」模块的存储层。
 *
 * 权威数据在**宿主的服务端存储**（`$DSH_HOME/qianxun/prompts.json`，由本插件的
 * Node 半区在 `/api/dsh-qianxun-tab/prompts` 上提供 GET/PUT）。localStorage
 * （key: `qianxun_prompts`）只作为镜像/离线兜底：
 *
 *   - 服务端可用：读服务端、写服务端（300ms 防抖全量 PUT），localStorage 同步镜像；
 *   - 服务端不可用（非 web profile，或绑到 0.0.0.0 后从别的机器访问）：自动回落到
 *     localStorage，功能不中断，只是又回到「同浏览器同源」的可见范围；
 *   - 一次性上迁：本浏览器从未同步过（无 `qianxun_prompts_synced` 标记）而
 *     localStorage 有数据时，把旧数据**按 id 合并**进服务端。标记用于区分
 *     「迁移前的历史数据」与「已在别处同步过的镜像」，避免已删除的条目被复活。
 *
 * 为什么不再只存 localStorage：localStorage 按「浏览器 profile × 源（协议+主机+
 * 端口）」隔离。Safari 存的提示词 Chrome 看不到；DSH Desktop 每次启动都用随机端口，
 * origin 每次都不一样，localStorage 每次都是空桶。
 */
export interface QianxunPrompt {
    id: string;
    name: string;
    content: string;
    created_at: number;
    updated_at: number;
}
/** 提示词模块的数据来源，供 UI 提示用。 */
export type QianxunPromptSource = 'loading' | 'server' | 'local';
/** 订阅列表变化（服务端加载完成、增删改）。返回取消订阅函数。 */
export declare function subscribePrompts(listener: () => void): () => void;
/** 当前数据来源：'loading' 尚未确定，'server' 服务端可用，'local' 已回落本地。 */
export declare function promptsSource(): QianxunPromptSource;
/** 确保已尝试从服务端加载（幂等）。UI 挂载时调用，勿 await 阻塞渲染。 */
export declare function ensurePromptsLoaded(): Promise<void>;
/**
 * 重新拉取服务端（用于 tab 重新可见时对齐别的浏览器/窗口写入）。
 * 服务端不可用时不做任何事，本地模式下也不会覆盖内存态；
 * 有未落盘的本地改动（防抖窗口内）时跳过，避免用旧数据盖掉正在编辑的内容。
 */
export declare function refreshPrompts(): Promise<void>;
/** 读全部提示词（按 updated_at 倒序）。 */
export declare function listPrompts(): QianxunPrompt[];
/** 按 id 读单条。 */
export declare function getPrompt(id: string): QianxunPrompt | undefined;
/** 新增一条，返回新对象。 */
export declare function createPrompt(name: string, content?: string): QianxunPrompt;
/** 更新内容/名字，返回更新后对象；不存在返回 undefined。 */
export declare function updatePrompt(id: string, patch: {
    name?: string;
    content?: string;
}): QianxunPrompt | undefined;
/** 删除一条。 */
export declare function deletePrompt(id: string): boolean;
/** 复制提示词到剪贴板。返回是否成功。 */
export declare function copyPrompt(id: string): Promise<boolean>;
//# sourceMappingURL=prompts.d.ts.map