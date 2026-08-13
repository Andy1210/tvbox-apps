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
  const { ref, focusKey } = useFocusable({ focusKey: "cast", saveLastFocusedChild: true });
  const scroller = useRef<HTMLDivElement>(null);

  const scrollTo = (el: HTMLElement): void => {
    const box = scroller.current;
    if (!box) return;
    const pad = el.offsetWidth * 0.6;
    const left = el.offsetLeft - pad;
    const right = el.offsetLeft + el.offsetWidth + pad;
    if (left < box.scrollLeft) box.scrollTo({ left, behavior: "smooth" });
    else if (right > box.scrollLeft + box.clientWidth) box.scrollTo({ left: right - box.clientWidth, behavior: "smooth" });
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <section ref={ref} className="flex flex-col gap-[1vh]">
        <h2 className="px-[4vw] text-[2vh] font-semibold tracking-tight">{title}</h2>
        <div ref={scroller} className="no-scrollbar flex gap-[1.2vw] overflow-x-auto scroll-smooth px-[4vw] py-[9vh] -my-[5vh]">
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
  const { ref, focused } = useFocusableItem({ focusKey: `cast-${role.id}`, onEnterPress: onEnter }, { block: "nearest" });
  const backend = useApp((s) => s.backend);
  const el = useRef<HTMLDivElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (focused && el.current) onFocusedEl(el.current);
  }, [focused, onFocusedEl]);

  useEffect(() => {
    if (!role.thumb || !backend) return;
    let live = true;
    // Cast portraits are served by the metadata provider rather than the media
    // server, but they go through the same loader so the token is never in
    // markup for the cases where the server does host them.
    void loadImage(role.thumb, backend.imageHeaders()).then((url) => live && url && setSrc(url));
    return () => {
      live = false;
    };
  }, [role.thumb, backend]);

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
      className="flex w-[11vh] shrink-0 flex-col items-center gap-[0.6vh] transition-transform duration-150"
      style={{ transform: focused ? "scale(1.06)" : undefined }}
    >
      <div
        className={[
          "flex h-[11vh] w-[11vh] items-center justify-center overflow-hidden rounded-full bg-white/8",
          focused ? "ring-[0.35vh] ring-white" : "",
        ].join(" ")}
      >
        {src ? (
          <img src={src} alt="" decoding="async" className="h-full w-full object-cover" />
        ) : (
          <span className="text-[2.6vh] text-fg-dim">{initials}</span>
        )}
      </div>
      <div className="w-full truncate text-center text-[1.7vh]">{role.name}</div>
      {role.character && <div className="w-full truncate text-center text-[1.7vh] text-fg-dim">{role.character}</div>}
    </div>
  );
}
