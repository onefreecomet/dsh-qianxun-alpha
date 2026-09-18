/**
 * AlphaPoolCard.tsx — 「Alpha 自选池 + 提交闸」卡（千寻结果页里存 alpha_id 的地方）。
 *
 * 干什么：
 *   · 输入框存 alpha_id（支持一次粘一坨：逗号 / 换行 / 空格分隔）
 *   · 表格：状态 / region / alpha_id（可一键复制）/ sharpe / fitness / ret% / to% /
 *     margin（万分之一）/ selfcorr / prodcorr / 备注（可直接在格子里写）
 *   · 「同步」按钮一次性刷新整池的状态与指标
 *   · 顶部显示「账号当日新增 active」（每天本地 12:00 重置）
 *   · 提交栏：粘 alpha_id → 先拉 check 列出 FAIL → 确认后**真的提交到平台**
 *
 * 数据从哪来：全部走引擎（`/api/alpha-pool*`）。池子落在引擎侧（跨浏览器/跨端口都在），
 * 打 BRAIN 的活也由引擎代劳——浏览器既没有凭据，也会撞 CORS。
 *
 * 降级：引擎如果还是老版本（没有这几个接口），GET 会 404。这里不报红，而是明确
 * 告诉用户「引擎需要重启才生效」，UI 其余部分不受影响。
 *
 * ⚠️ 提交红线：提交不可逆。本组件只做「人类点按钮 → 引擎执行」这一条路，
 * 引擎侧还会硬校验 confirm token。agent / 脚本不得代提。
 */
export interface AlphaPoolCardProps {
    /** 侧边栏 tab 是否可见（不可见时不打 BRAIN，避免后台无意义请求）。 */
    visible?: boolean;
    /** 点某一行的 alpha_id 时回调（详情页用它打开已有的 BRAIN check 面板）。 */
    onInspect?: (alphaId: string) => void;
}
export declare function AlphaPoolCard(props: AlphaPoolCardProps): JSX.Element;
//# sourceMappingURL=AlphaPoolCard.d.ts.map