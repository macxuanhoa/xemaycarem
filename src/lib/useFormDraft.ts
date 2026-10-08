import { useEffect, useRef, useState } from "react";
import type { FieldValues, UseFormReturn } from "react-hook-form";
import { clearFormDraft, readFormDraft, saveFormDraft } from "./formDrafts";
import { confirmAction } from "@/components/ui/ConfirmDialog";

export function useFormDraft<T extends FieldValues>(
  kind: string,
  userId: string | undefined,
  form: UseFormReturn<T>,
) {
  const [draft, setDraft] = useState(() => readFormDraft(kind, userId));
  const [saved, setSaved] = useState(false);
  const dirtyRef = useRef(false);
  const completed = useRef(false);
  dirtyRef.current = form.formState.isDirty;
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
      // Every business field now persists to the local draft; only warn when
      // storage itself is unavailable, because then the edits would be lost.
      if (!saveFormDraft(kind, userId, form.getValues())) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    let allowNavigation: string | null = null;
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
      // A confirmed dialog re-triggers this click; let that one through untouched.
      if (allowNavigation === destination.href) {
        allowNavigation = null;
        return;
      }
      const persisted = saveFormDraft(kind, userId, form.getValues());
      if (!persisted) {
        event.preventDefault();
        event.stopPropagation();
        void confirmAction({
          title: "Bạn có thay đổi chưa lưu",
          description:
            "Trình duyệt không lưu được bản nháp trên thiết bị này. Rời trang sẽ mất các thông tin đã nhập. Rời trang?",
          confirmLabel: "Bỏ thay đổi và rời trang",
          cancelLabel: "Ở lại trang",
          tone: "danger",
        }).then((confirmed) => {
          if (confirmed) {
            allowNavigation = destination.href;
            anchor.click();
          }
        });
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
