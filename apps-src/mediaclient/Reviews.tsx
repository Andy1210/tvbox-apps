import { useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useFocusableItem } from "@sdk";
import type { Review } from "./backends/types";

/**
 * What critics said, as a rail.
 *
 * A vertical list of quotations cannot be reached with a remote: there is
 * nothing focusable in it, so the page will not scroll down to it and the D-pad
 * stops at whatever is above. A row of cards is navigable by the same Left and
 * Right as everything else on the screen, and it does not push the rest of the
 * page down out of reach either.
 *
 * The fresh/rotten mark stays because it is not decoration: a quotation can read
 * as faint praise and be filed as positive, or the reverse.
 */
export function Reviews({ reviews, title }: { reviews: Review[]; title: string }): React.JSX.Element | null {
  const { ref, focusKey } = useFocusable({ focusKey: "reviews", trackChildren: true, saveLastFocusedChild: true });
  const scroller = useRef<HTMLDivElement>(null);

  if (reviews.length === 0) return null;

  const scrollTo = (el: HTMLElement): void => {
    const box = scroller.current;
    if (!box) return;
    const pad = el.offsetWidth * 0.3;
    const left = el.offsetLeft - pad;
    const right = el.offsetLeft + el.offsetWidth + pad;
    if (left < box.scrollLeft) box.scrollTo({ left, behavior: "smooth" });
    else if (right > box.scrollLeft + box.clientWidth) box.scrollTo({ left: right - box.clientWidth, behavior: "smooth" });
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <section ref={ref} className="flex flex-col gap-[1vh]">
        <h2 className="px-[4vw] text-[2vh] font-semibold tracking-tight">{title}</h2>
        <div
          ref={scroller}
          className="no-scrollbar flex gap-[1.2vw] overflow-x-auto scroll-smooth px-[4vw] py-[4vh] -my-[2vh]"
        >
          {reviews.map((r) => (
            <Card key={r.id} review={r} onFocusedEl={scrollTo} />
          ))}
        </div>
      </section>
    </FocusContext.Provider>
  );
}

function Card({ review, onFocusedEl }: { review: Review; onFocusedEl: (el: HTMLElement) => void }): React.JSX.Element {
  // Focusable but does nothing on OK: what makes it focusable is that the row
  // has to be reachable at all, not that a quotation leads anywhere.
  const { ref, focused } = useFocusableItem({ focusKey: `review-${review.id}` }, { block: "nearest" });
  const el = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (focused && el.current) onFocusedEl(el.current);
  }, [focused, onFocusedEl]);

  // A long quotation is clamped on the card and opens out when focused, so the
  // row stays a row and nothing is unreadable.
  useEffect(() => {
    setExpanded(focused);
  }, [focused]);

  return (
    <div
      ref={(node) => {
        el.current = node;
        ref(node);
      }}
      className={[
        "flex w-[26vw] shrink-0 flex-col gap-[0.8vh] rounded-[1vh] p-[1.6vh] transition-transform duration-150",
        focused ? "scale-[1.03] bg-white/15 ring-[0.3vh] ring-white" : "bg-white/6",
      ].join(" ")}
    >
      <div className="flex items-center gap-[0.6vw]">
        <Sentiment sentiment={review.sentiment} />
        <span className="truncate text-[1.7vh] opacity-70">
          {review.author}
          {review.source ? ` · ${review.source}` : ""}
        </span>
      </div>
      <p className={`text-[1.9vh] leading-relaxed ${expanded ? "" : "line-clamp-4"}`}>{review.text}</p>
    </div>
  );
}

function Sentiment({ sentiment }: { sentiment?: "fresh" | "rotten" }): React.JSX.Element {
  // Inline SVG, never an emoji: this browser has no colour-emoji font and draws
  // a hollow box in its place.
  const colour = sentiment === "rotten" ? "#4a9b3f" : sentiment === "fresh" ? "#e2372a" : "#8a96a6";
  return (
    <svg viewBox="0 0 24 24" className="h-[1.8vh] w-[1.8vh] shrink-0" aria-hidden="true">
      <circle cx="12" cy="12" r="7" fill={colour} />
    </svg>
  );
}
