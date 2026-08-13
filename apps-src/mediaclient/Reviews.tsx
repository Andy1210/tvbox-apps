import { useState } from "react";
import { FocusButton, useI18n } from "@sdk";
import type { Review } from "./backends/types";

const FIRST = 3;

/**
 * What critics said.
 *
 * Three to begin with, because this sits below the cast and the trailers and
 * nobody scrolls past twenty quotations to reach the end of a page. The rest
 * open on request.
 *
 * The fresh/rotten mark is kept because it is not decoration: a quotation can
 * read as faint praise and be filed as positive, or the reverse.
 */
export function Reviews({ reviews, title }: { reviews: Review[]; title: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const [all, setAll] = useState(false);

  if (reviews.length === 0) return null;
  const shown = all ? reviews : reviews.slice(0, FIRST);

  return (
    <section className="flex flex-col gap-[1.2vh] px-[4vw]">
      <h2 className="text-[2vh] font-semibold tracking-tight">{title}</h2>

      <ul className="flex flex-col gap-[1.4vh]">
        {shown.map((r) => (
          <li key={r.id} className="flex max-w-[70vw] gap-[0.8vw]">
            <Sentiment sentiment={r.sentiment} />
            <div className="flex flex-col gap-[0.3vh]">
              <p className="text-[1.9vh] leading-relaxed">{r.text}</p>
              <p className="text-[1.7vh] text-fg-dim">
                {r.author}
                {r.source ? ` · ${r.source}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {reviews.length > FIRST && !all && (
        <FocusButton
          focusKey="reviews-more"
          onEnter={() => setAll(true)}
          className="self-start rounded-[0.8vh] bg-white/10 px-[1.6vw] py-[0.8vh] text-[1.8vh]"
        >
          {t("detail.moreReviews", { n: String(reviews.length - FIRST) })}
        </FocusButton>
      )}
    </section>
  );
}

function Sentiment({ sentiment }: { sentiment?: "fresh" | "rotten" }): React.JSX.Element {
  // Inline SVG, never an emoji: this browser has no colour-emoji font and draws
  // a hollow box in its place.
  const colour = sentiment === "rotten" ? "#4a9b3f" : sentiment === "fresh" ? "#e2372a" : "#8a96a6";
  return (
    <svg viewBox="0 0 24 24" className="mt-[0.4vh] h-[1.8vh] w-[1.8vh] shrink-0" aria-hidden="true">
      <circle cx="12" cy="12" r="7" fill={colour} />
    </svg>
  );
}
