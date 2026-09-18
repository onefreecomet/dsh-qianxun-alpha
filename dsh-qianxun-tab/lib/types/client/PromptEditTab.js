import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * PromptEditTab — 提示词编辑 tab。
 * 由列表 tab（QianxunTab）点提示词名字 → openTab({type:'qianxun-prompt', meta:{promptId}})
 * 打开。内容存服务端（见 prompts.ts），text 实时可改，离开自动保存。
 *
 * 数据是异步到达的（页面刷新后恢复的 prompt tab 可能先于服务端加载完成），
 * 因此这里先同步取一次，取不到再等一次加载；一旦载入过就不再回填，
 * 以免覆盖正在编辑的内容。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { deletePrompt, ensurePromptsLoaded, getPrompt, subscribePrompts, updatePrompt, } from "./prompts.js";
import css from './QianxunTab.module.css';
/** 从 tab meta 读提示词 id。 */
function promptIdFromTab(props) {
    const meta = props.tab?.meta;
    const raw = meta?.promptId;
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
}
export function PromptEditTab(props) {
    const promptId = promptIdFromTab(props);
    const [prompt, setPrompt] = useState(null);
    const [name, setName] = useState('');
    const [content, setContent] = useState('');
    const [saved, setSaved] = useState(false);
    const [delBusy, setDelBusy] = useState(false);
    /** 已从存储载入过（载入后不再回填，避免覆盖编辑中的内容）。 */
    const loadedRef = useRef(false);
    // 加载（同步命中 → 立即填充；未命中 → 等 ensurePromptsLoaded 完成后再填充）
    useEffect(() => {
        if (promptId === undefined)
            return;
        loadedRef.current = false;
        setPrompt(null);
        const fill = () => {
            if (loadedRef.current)
                return;
            const p = getPrompt(promptId);
            if (!p)
                return;
            loadedRef.current = true;
            setPrompt(p);
            setName(p.name);
            setContent(p.content);
        };
        fill();
        const unsubscribe = subscribePrompts(fill);
        void ensurePromptsLoaded().then(fill);
        return unsubscribe;
    }, [promptId]);
    // 自动保存（防抖 500ms）
    useEffect(() => {
        if (prompt === null || promptId === undefined)
            return;
        if (name === prompt.name && content === prompt.content)
            return;
        const t = setTimeout(() => {
            const updated = updatePrompt(promptId, { name, content });
            if (updated) {
                setPrompt(updated);
                setSaved(true);
                setTimeout(() => setSaved(false), 1500);
            }
        }, 500);
        return () => clearTimeout(t);
    }, [name, content, prompt, promptId]);
    const onDelete = useCallback(() => {
        if (promptId === undefined || delBusy)
            return;
        if (!window.confirm(`删除提示词「${name}」？此操作不可恢复。`))
            return;
        setDelBusy(true);
        deletePrompt(promptId);
        // 关闭当前 tab：better-sidebar 无直接 close API，用 openTab 切到 qianxun 列表
        props.ctx?.betterSidebar?.openTab({ type: 'qianxun', id: 'qianxun', title: '千寻回测' });
        setDelBusy(false);
    }, [promptId, name, delBusy, props.ctx]);
    if (promptId === undefined) {
        return (_jsxs("div", { className: css.root, children: [_jsxs("header", { className: css.header, children: [_jsx("span", { className: css.titleIcon, children: "\uD83D\uDCCB" }), _jsx("span", { className: css.title, children: "\u63D0\u793A\u8BCD" })] }), _jsx("div", { className: css.body, children: _jsxs("div", { className: css.empty, children: [_jsx("span", { className: css.emptyIcon, children: "\uD83D\uDDC2\uFE0F" }), _jsx("span", { children: "\u672A\u6307\u5B9A\u63D0\u793A\u8BCD\uFF1A\u8BF7\u4ECE\u300C\u5343\u5BFB\u56DE\u6D4B\u300D\u5217\u8868\u70B9\u51FB\u67D0\u6761\u63D0\u793A\u8BCD\u6253\u5F00\u3002" })] }) })] }));
    }
    return (_jsxs("div", { className: css.root, children: [_jsxs("header", { className: css.header, children: [_jsx("span", { className: css.titleIcon, children: "\uD83D\uDCCB" }), _jsx("span", { className: css.title, style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: prompt?.name ?? '提示词' }), _jsx("span", { className: css.spacer }), saved && _jsx("span", { className: css.promptSavedTag, children: "\u5DF2\u4FDD\u5B58" }), _jsx("button", { type: "button", className: css.iconBtn, onClick: () => {
                            const p = getPrompt(promptId);
                            if (p)
                                void navigator.clipboard.writeText(p.content);
                        }, title: "\u590D\u5236\u5230\u526A\u8D34\u677F", children: "\u29C9" }), _jsx("button", { type: "button", className: `${css.iconBtn} ${css.promptDelBtn}`, onClick: onDelete, disabled: delBusy, title: "\u5220\u9664\u6B64\u63D0\u793A\u8BCD", children: "\uD83D\uDDD1" })] }), _jsx("div", { className: css.body, children: _jsxs("div", { className: css.card, children: [_jsxs("div", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: "\u540D\u79F0" }), _jsx("input", { className: css.input, value: name, placeholder: "\u63D0\u793A\u8BCD\u540D\u5B57", onChange: e => setName(e.target.value) })] }), _jsxs("div", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: "\u5185\u5BB9\uFF08\u81EA\u52A8\u4FDD\u5B58 \u00B7 \u6700\u591A 20000 \u5B57\uFF09" }), _jsx("textarea", { className: `${css.textarea} ${css.promptTextarea}`, value: content, placeholder: "\u5728\u8FD9\u91CC\u7C98\u8D34/\u7F16\u8F91\u63D0\u793A\u8BCD\u5185\u5BB9\u2026", onChange: e => setContent(e.target.value) })] }), _jsxs("div", { className: css.metaLine, children: ["\u66F4\u65B0\u4E8E ", prompt ? new Date(prompt.updated_at).toLocaleString() : '—', " \u00B7 \u4FEE\u6539\u540E\u81EA\u52A8\u4FDD\u5B58"] })] }) })] }));
}
//# sourceMappingURL=PromptEditTab.js.map