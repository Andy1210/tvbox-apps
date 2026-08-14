import { useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useFocusableItem } from "@sdk";
import type { Role } from "./backends/types";
import { loadImage } from "./posters";
import { useApp } from "./state";

/**
 * The cast, as faces.
 *
 * Every face is focusable and opens that person's page, which is the whole
 * reason this row exists rather than a line of names in the metadata block. A
 * name is something to read; a face is something to press.
 */
export function CastRow({
  roles,
  title,
  onSelect,
}: {
  roles: Role[];
  title: string;
  onSelect: (role: Role) => void;
}): React.JSX.Element {
  const { ref, focusKey } = useFocusable({ focusKey: "cast", trackChildren: true, saveLastFocusedChild: true });
  const scroller = useRef<HTMLDivElement>(null);

  const scrollTo = (el: HTMLElement): void => {
    const box = scroller.current;
    if (!box) return;
    const pad = el.offsetWidth * 0.6;
    const left = el.offsetLeft - pad;
    const right = el.offsetLeft + el.offsetWidth + pad;
    if (left < box.scrollLeft) box.scrollTo({ left, behavior: "smooth" });
    else if (right > box.scrollLeft + box.clientWidth)
      box.scrollTo({ left: right - box.clientWidth, behavior: "smooth" });
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <section ref={ref} className="flex shrink-0 flex-col gap-[1vh]">
        <h2 className="shrink-0 px-[4vw] text-[2vh] font-semibold tracking-tight">{title}</h2>
        <div ref={scroller} className="no-scrollbar flex gap-[1.2vw] overflow-x-auto px-[4vw] py-[9vh] -my-[5vh]">
          {roles.map((role) => (
            <Face key={role.id} role={role} onEnter={() => onSelect(role)} onFocusedEl={scrollTo} />
          ))}
        </div>
      </section>
    </FocusContext.Provider>
  );
}

function Face({
  role,
  onEnter,
  onFocusedEl,
}: {
  role: Role;
  onEnter: () => void;
  onFocusedEl: (el: HTMLElement) => void;
}): React.JSX.Element {
  const { ref, focused } = useFocusableItem(
    { focusKey: `cast-${role.id}`, onEnterPress: onEnter },
    { block: "nearest" },
  );
  const backend = useApp((s) => s.backend);
  const el = useRef<HTMLDivElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (focused && el.current) onFocusedEl(el.current);
  }, [focused, onFocusedEl]);

  // Portraits come from the metadata provider, not the media server, and that
  // host refuses a credentialed cross-origin request outright - it answers the
  // preflight with 403 and sends no allow-origin header on the plain request
  // either. Fetching them the way posters are fetched leaves every face blank,
  // which is the whole point of this row. An <img> is not CORS-gated, so an
  // absolute URL is simply linked; only a path on the server itself needs the
  // token, and that goes through the loader.
  const absolute = Boolean(role.thumb && /^https?:\/\//.test(role.thumb));

  useEffect(() => {
    if (!role.thumb || absolute || !backend) return;
    let live = true;
    void loadImage(role.thumb, backend.imageHeaders()).then((url) => live && url && setSrc(url));
    return () => {
      live = false;
    };
  }, [role.thumb, absolute, backend]);

  const initials = role.name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0] ?? "")
    .join("");

  return (
    <div
      ref={(node) => {
        el.current = node;
        ref(node);
      }}
      onClick={onEnter}
      // Wider than the portrait it holds, so a full name has somewhere to go.
      className="flex w-[16vh] shrink-0 flex-col items-center gap-[0.6vh]"
      style={{ transform: focused ? "scale(1.06)" : undefined }}
    >
      <div
        className={[
          "flex h-[11vh] w-[11vh] items-center justify-center overflow-hidden rounded-full bg-white/8",
          focused ? "ring-[0.35vh] ring-white" : "",
        ].join(" ")}
      >
        {!broken && (absolute || src) ? (
          <img
            src={absolute ? role.thumb : (src as string)}
            alt=""
            decoding="async"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-[2.6vh] text-fg-dim">{initials}</span>
        )}
      </div>
      {/* The BLOCK has the fixed height, not the lines inside it. Fixing each
          line meant a one-line name reserved space for a second one, and the
          character name sat an empty line below it. Fixed somewhere, though:
          letting the block grow would leave the faces on a ragged baseline and
          move the row under the D-pad's own measurements. */}
      <div className="flex h-[10.2vh] w-full flex-col items-center gap-[0.2vh] overflow-hidden">
        <div className="line-clamp-2 w-full text-center text-[1.8vh] leading-[1.4]">{role.name}</div>
        {role.character && (
          <div className="line-clamp-2 w-full text-center text-[1.7vh] leading-[1.4] text-fg-dim">{role.character}</div>
        )}
      </div>
    </div>
  );
}
