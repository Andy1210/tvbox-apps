import { useEffect, useState } from "react";
import { useI18n } from "@sdk";
import { Row } from "./Row";
import { Message } from "./Message";
import { artworkScale } from "./posters";
import { useInitialFocus } from "./focus";
import { classify, useApp } from "./state";
import type { Library, MediaItem } from "./backends/types";
import { log } from "./redact";

interface Loaded {
  libraries: Library[];
  onDeck: MediaItem[];
  recent: { library: Library; items: MediaItem[] }[];
}

/**
 * What the TV opens on.
 *
 * Continue-watching first, because that is what the box is used for most
 * evenings; then what each library gained recently. A library with nothing new
 * contributes no row rather than an empty one - a row that is always there and
 * always empty teaches people to skip past that part of the screen.
 */
export function Home(): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const go = useApp((s) => s.go);
  const fail = useApp((s) => s.fail);
  const failure = useApp((s) => s.failure);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!backend) return;
    let live = true;

    (async () => {
      try {
        const libraries = await backend.libraries();
        if (!live) return;

        // On-deck first and on its own: it is the row people came for, and
        // waiting for every library's recents before showing anything makes the
        // TV look broken on a slow server.
        const onDeck = await backend.onDeck();
        if (!live) return;
        setData({ libraries, onDeck, recent: [] });

        const recent: Loaded["recent"] = [];
        for (const library of libraries) {
          const items = await backend.recentlyAdded(library.id);
          if (!live) return;
          if (items.length) recent.push({ library, items });
          setData({ libraries, onDeck, recent: [...recent] });
        }
      } catch (e) {
        if (!live) return;
        log.warn("home failed to load", e);
        fail(classify(e));
      }
    })();

    return () => {
      live = false;
    };
  }, [backend, fail, reload]);

  // The first thing worth pressing: what you were watching, or a library when
  // there is nothing to carry on with.
  const firstKey = data?.onDeck.length
    ? `ondeck-${data.onDeck[0].id}`
    : data?.libraries.length
      ? `libraries-lib:${data.libraries[0].id}`
      : undefined;
  useInitialFocus(firstKey, Boolean(data));

  const poster = (item: MediaItem): string | undefined => backend?.posterUrl(item, 300 * artworkScale(), 450 * artworkScale());
  const open = (item: MediaItem): void => go({ name: "item", itemId: item.id });

  if (failure) return <Message failure={failure} onRetry={() => setReload((n) => n + 1)} />;
  if (!data) return <Message loading />;

  const nothing = data.onDeck.length === 0 && data.recent.length === 0;

  return (
    <div className="flex h-full flex-col gap-[3vh] overflow-y-auto py-[4vh]">
      {nothing && <Message text={t("home.empty")} />}

      <Row
        id="ondeck"
        title={t("home.continue")}
        items={data.onDeck}
        posterUrl={poster}
        onSelect={open}
        heightVh={24}
      />

      {data.recent.map(({ library, items }) => (
        <Row
          key={library.id}
          id={`recent-${library.id}`}
          title={t("home.recentIn", { library: library.title })}
          items={items}
          posterUrl={poster}
          onSelect={open}
        />
      ))}

      {data.libraries.length > 0 && (
        <Row
          id="libraries"
          title={t("home.libraries")}
          items={data.libraries.map((l) => ({ id: `lib:${l.id}`, kind: "show" as const, title: l.title }))}
          posterUrl={() => undefined}
          onSelect={(item) => {
            const id = item.id.slice("lib:".length);
            const library = data.libraries.find((l) => l.id === id);
            if (library) go({ name: "library", libraryId: library.id, title: library.title });
          }}
          heightVh={14}
        />
      )}
    </div>
  );
}
