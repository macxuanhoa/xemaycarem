import { useEffect, useRef, useState } from "react";
import type { FieldValues, UseFormReturn } from "react-hook-form";
import { clearFormDraft, readFormDraft, saveFormDraft } from "./formDrafts";

export function useFormDraft<T extends FieldValues>(
  kind: string,
  userId: string | undefined,
  form: UseFormReturn<T>,
) {
  const [draft, setDraft] = useState(() => readFormDraft(kind, userId));
  const [saved, setSaved] = useState(false);
  const dirtyRef = useRef(false);
  const financialRef = useRef(false);
  const completed = useRef(false);
  dirtyRef.current = form.formState.isDirty;
  financialRef.current = [
    "purchase_price",
    "sale_price",
    "initial_payment",
    "asking_price",
  ].some(
    (field) => (form.formState.dirtyFields as Record<string, unknown>)[field],
  );
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const persist = () => {
      if (!completed.current && dirtyRef.current) {
        setSaved(saveFormDraft(kind, userId, form.getValues()));
      }
    };
    const subscription = form.watch(() => {
      clearTimeout(timer);
      timer = setTimeout(persist, 350);
    });
    const unload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current || completed.current) return;
      const values = form.getValues();
      // Amounts are intentionally excluded from reusable local defaults and drafts.
      const persisted = saveFormDraft(kind, userId, values);
      if (financialRef.current || !persisted) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const leaving = (event: MouseEvent) => {
      if (
        !dirtyRef.current ||
        completed.current ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as Element | null)?.closest(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (
        !anchor ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      )
        return;
      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search
      )
        return;
      const persisted = saveFormDraft(kind, userId, form.getValues());
      if (
        (financialRef.current || !persisted) &&
        !window.confirm(
          "Bạn có thay đổi chưa lưu. Thông tin bản nháp được giữ nếu có thể, nhưng giá tiền sẽ cần nhập lại. Bỏ thay đổi và rời trang?",
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", leaving, true);
    return () => {
      subscription.unsubscribe();
      clearTimeout(timer);
      if (!completed.current && dirtyRef.current)
        saveFormDraft(kind, userId, form.getValues());
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", leaving, true);
    };
  }, [form, kind, userId]);
  return {
    draft,
    saved,
    resume: () => {
      if (draft) form.reset({ ...form.getValues(), ...draft } as T);
      setDraft(null);
    },
    discard: () => {
      clearFormDraft(kind, userId);
      setDraft(null);
    },
    complete: () => {
      completed.current = true;
      clearFormDraft(kind, userId);
      setSaved(false);
      setDraft(null);
    },
    restart: () => {
      completed.current = false;
      setSaved(false);
    },
  };
}
