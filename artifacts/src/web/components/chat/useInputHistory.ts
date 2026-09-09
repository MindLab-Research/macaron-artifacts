"use client";
import { useCallback, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

const STORAGE_KEY = "macaron-artifacts:input-history";
/** 够翻回几十条就足够了；再多既没人翻，也白占 localStorage。 */
const LIMIT = 50;
/**
 * 单条上限。条数有上限还不够 —— 粘一篇长文进输入框，50 条就能把 localStorage 的 5MB 顶满，
 * 而顶满之后受害的是别的写入方（`setItem` 直接抛）。翻历史只要认得出是哪条，不需要全文。
 */
const MAX_CHARS = 2000;

const read = (): string[] => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === "string").slice(-LIMIT) : [];
  } catch {
    return [];
  }
};

/**
 * ↑ / ↓ 翻输入历史，语义对齐 shell。
 *
 * 只在**光标在末尾且没有选区**时接管方向键 —— 否则多行输入里想把光标移到上一行都做不到。
 * 第一次按 ↑ 之前会把当前草稿存下来，一路 ↓ 回到底时再还回去，不会把你正在写的东西吃掉。
 */
export function useInputHistory(value: string, setValue: (next: string) => void, element: React.RefObject<HTMLTextAreaElement | null>) {
  const [history, setHistory] = useState<string[]>(read);
  const index = useRef<number | null>(null);
  const draft = useRef("");

  const caretToEnd = () =>
    requestAnimationFrame(() => {
      const node = element.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
    });

  const exit = useCallback(() => {
    index.current = null;
    draft.current = "";
  }, []);

  const remember = useCallback(
    (text: string) => {
      exit();
      setHistory((current) => {
        // 同一句话重复发时只留最新的那条，翻历史才不会连按好几次都是同一句
        const entry = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
        const next = [...current.filter((kept) => kept !== entry), entry].slice(-LIMIT);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Input remains usable when browser storage is full or disabled. */ }
        return next;
      });
    },
    [exit],
  );

  /** 返回 true 表示这次按键被历史导航吃掉了，调用方不要再当成普通输入处理。 */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const node = event.currentTarget;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    // 输入法组字期间方向键是在选候选词，绝不能抢
    if (!plain || event.nativeEvent.isComposing || node.selectionStart !== node.selectionEnd) return false;
    const atEnd = node.selectionStart === node.value.length;

    if (event.key === "ArrowUp" && (index.current !== null ? atEnd : node.value.length === 0) && history.length) {
      event.preventDefault();
      if (index.current === null) draft.current = value;
      index.current = index.current === null ? history.length - 1 : Math.max(0, index.current - 1);
      setValue(history[index.current]);
      caretToEnd();
      return true;
    }
    if (event.key === "ArrowDown" && index.current !== null && atEnd) {
      event.preventDefault();
      if (index.current === history.length - 1) {
        setValue(draft.current);
        exit();
      } else {
        index.current += 1;
        setValue(history[index.current]);
      }
      caretToEnd();
      return true;
    }
    return false;
  };

  return { remember, onKeyDown, onEdit: exit };
}
