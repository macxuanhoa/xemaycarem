import { useEffect, useRef, useState } from "react";

const mobileQuery = "(max-width: 768px)";

export function useMobileDrawer() {
  const [mobile, setMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(mobileQuery).matches,
  );
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const active = mobile && open;

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function")
      return;
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
    const previousBodyStyle = document.body.getAttribute("style");
    const trigger = triggerRef.current;
    const controls = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex="0"]',
        ),
      ).filter((element) => element.getClientRects().length > 0);
    // iOS Safari ignores body overflow alone; pin the body at the current
    // offset so the page cannot scroll (or shift) behind the drawer.
    const scrollY = window.scrollY;
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
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
      if (previousBodyStyle === null) document.body.removeAttribute("style");
      else document.body.setAttribute("style", previousBodyStyle);
      window.scrollTo(0, scrollY);
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
