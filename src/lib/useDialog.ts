import { useEffect, useRef } from "react";

const activeDialogs: HTMLElement[] = [];
const inertSnapshots = new Map<HTMLElement, boolean>();
let bodySnapshot: {
  style: string | null;
  scrollY: number;
  pinned: boolean;
} | null = null;

function updateDialogBackground() {
  for (const [element, inert] of inertSnapshots) element.inert = inert;
  inertSnapshots.clear();
  let branch: HTMLElement | undefined = activeDialogs.at(-1);
  while (branch && branch !== document.body) {
    const parent = branch.parentElement;
    if (!parent) break;
    for (const sibling of parent.children) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      if (["SCRIPT", "STYLE", "LINK"].includes(sibling.tagName)) continue;
      inertSnapshots.set(sibling, sibling.inert);
      sibling.inert = true;
    }
    branch = parent;
  }
}

function lockDialogScroll() {
  if (bodySnapshot) return;
  const pinned =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 768px)").matches &&
    document.body.style.position !== "fixed";
  bodySnapshot = {
    style: document.body.getAttribute("style"),
    scrollY: window.scrollY,
    pinned,
  };
  document.body.style.overflow = "hidden";
  // Safari needs a pinned body; preserve the offset rather than jumping to top.
  if (pinned) {
    document.body.style.position = "fixed";
    document.body.style.top = `-${bodySnapshot.scrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
  }
}

function unlockDialogScroll() {
  if (activeDialogs.length || !bodySnapshot) return;
  const snapshot = bodySnapshot;
  bodySnapshot = null;
  if (snapshot.style === null) document.body.removeAttribute("style");
  else document.body.setAttribute("style", snapshot.style);
  if (snapshot.pinned) window.scrollTo(0, snapshot.scrollY);
}

export function useDialog<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose: () => void,
  busy = false,
) {
  const panelRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousTabIndex = panel.getAttribute("tabindex");
    if (previousTabIndex === null) panel.tabIndex = -1;
    lockDialogScroll();
    activeDialogs.push(panel);
    updateDialogBackground();
    const focusable = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
        ) ?? [],
      ).filter(
        (element) =>
          !element.matches(":disabled") && element.getClientRects().length > 0,
      );
    (
      panel.querySelector<HTMLElement>("[data-dialog-initial-focus]") ??
      focusable()[0] ??
      panel
    ).focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (activeDialogs.at(-1) !== panel) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0],
          last = items[items.length - 1];
        if (!items.length) {
          event.preventDefault();
          panel?.focus();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            !panel?.contains(document.activeElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !panel?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      const index = activeDialogs.indexOf(panel);
      if (index >= 0) activeDialogs.splice(index, 1);
      updateDialogBackground();
      unlockDialogScroll();
      if (previousTabIndex === null) panel.removeAttribute("tabindex");
      if (previous?.isConnected && !previous.closest("[inert]"))
        previous.focus({ preventScroll: true });
    };
  }, [open]);
  return panelRef;
}
