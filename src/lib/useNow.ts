import { useEffect, useState } from "react";

/**
 * A `Date` that advances on a timer.
 *
 * Relative labels ("Vừa xong", "2 giờ trước") are computed against `now`, so a
 * surface that renders once and then sits open keeps showing yesterday's math:
 * a row can go on reading "Vừa xong" for an hour after it arrived simply
 * because nothing re-rendered it. Both the bell panel and the notification page
 * tick on this so their time buckets re-group while the user is looking at them.
 *
 * One minute is the right granularity — the finest label the UI shows is
 * "Vừa xong" vs "N phút trước". It is deliberately slower than a second-tick
 * clock so an open panel costs one re-render a minute rather than a constant
 * animation.
 *
 * `enabled` lets a surface that is only sometimes on screen (the bell panel)
 * stop the timer while it is hidden: the bell lives in the topbar all day, and
 * ticking it every minute for a panel nobody is looking at is exactly the kind
 * of background churn this app avoids. Re-enabling re-stamps `now` immediately,
 * so a panel reopened hours later is correct on its very first paint rather than
 * waiting up to a minute for the first tick.
 */
export function useNow(intervalMs = 60_000, enabled = true): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!enabled) return;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}
