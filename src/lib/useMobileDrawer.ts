import { useEffect, useRef, useState } from "react";

const mobileQuery = "(max-width: 760px)";

export function useMobileDrawer() {
  const [mobile, setMobile] = useState(() => window.matchMedia(mobileQuery).matches);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const active = mobile && open;

  useEffect(() => {
    const media = window.matchMedia(mobileQuery);
    const update = () => {
      setMobile(media.matches);
      if (!media.matches) setOpen(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!active || !panelRef.current) return;
    const panel = panelRef.current;
    const previousOverflow = document.body.style.overflow;
    const trigger = triggerRef.current;
    const controls = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex="0"]',
        ),
      ).filter((element) => element.getClientRects().length > 0);
    document.body.style.overflow = "hidden";
    panel.querySelector<HTMLButtonElement>(".mobile-menu-close")?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus();
    };
  }, [active]);

  return {
    active,
    mobile,
    panelRef,
    close: () => setOpen(false),
    show: (trigger: HTMLButtonElement) => {
      triggerRef.current = trigger;
      setOpen(true);
    },
  };
}
