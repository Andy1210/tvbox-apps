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
    else if (right > box.scrollLeft + box.clientWidth)
      box.scrollTo({ left: right - box.clientWidth, behavior: "smooth" });
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <section ref={ref} className="flex shrink-0 flex-col gap-[1vh]">
        <h2 className="px-[4vw] text-[2vh] font-semibold tracking-tight">{title}</h2>
        <div
          ref={scroller}
          // items-start, or the cards stretch to the tallest one: opening the
          // focused quotation would then leave every neighbour with a tall empty
          // box under its four clamped lines.
          className="no-scrollbar flex items-start gap-[1.2vw] overflow-x-auto scroll-smooth px-[4vw] py-[4vh] -my-[2vh]"
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
  const [expanded, setExpanded] = useState(false);
  // OK opens the quotation out and closes it again. Tying it to focus instead
  // changed the row's height on every Left/Right press - the row breathed under
  // whatever was being read - and left OK doing nothing on the one card someone
  // is standing on.
  const { ref, focused } = useFocusableItem(
    { focusKey: `review-${review.id}`, onEnterPress: () => setExpanded((v) => !v) },
    { block: "nearest" },
  );
  const el = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focused && el.current) onFocusedEl(el.current);
  }, [focused, onFocusedEl]);

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
        <span className="truncate text-[1.9vh] opacity-80">
          {review.author}
          {review.source ? ` · ${review.source}` : ""}
        </span>
      </div>
      <p className={`text-[2.1vh] leading-relaxed ${expanded ? "" : "line-clamp-4"}`}>{review.text}</p>
    </div>
  );
}

function Sentiment({ sentiment }: { sentiment?: "fresh" | "rotten" }): React.JSX.Element {
  // Inline SVG, never an emoji: this browser has no colour-emoji font and draws
  // a hollow box in its place.
  // Two SHAPES, not one shape in two colours. Rotten Tomatoes paints its
  // positive verdict red and its negative one green, which is backwards against
  // every other use of those colours - so the silhouette has to carry the
  // meaning on its own, exactly as it does on the score badges.
  if (!sentiment) return <svg viewBox="0 0 24 24" className="h-[1.8vh] w-[1.8vh] shrink-0" aria-hidden="true" />;
  const rotten = sentiment === "rotten";
  return (
    <svg viewBox="0 0 24 24" className="h-[1.8vh] w-[1.8vh] shrink-0" aria-hidden="true">
      {rotten ? (
        <path d="M12 3l2 4 4-2-1 4 4 1-3 3 3 3-4 1 1 4-4-2-2 4-2-4-4 2 1-4-4-1 3-3-3-3 4-1-1-4 4 2z" fill="#4a9b3f" />
      ) : (
        <>
          <circle cx="12" cy="13" r="8" fill="#e2372a" />
          <path d="M12 5c1-2 3-2 4-1-1 1-2 2-4 1z" fill="#3f8f34" />
        </>
      )}
    </svg>
  );
}
