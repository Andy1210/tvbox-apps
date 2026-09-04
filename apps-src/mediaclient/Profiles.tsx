import { useEffect, useRef, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { PinPad, useFocusableItem, useI18n } from "@sdk";
import { Message } from "./Message";
import { loadImage } from "./posters";
import { useFocusFallback, useInitialFocus } from "./focus";
import { classify, useApp } from "./state";
import type { Profile } from "./backends/types";
import { log } from "./redact";

/**
 * Who is watching.
 *
 * A household account carries several people, and which one is signed in decides
 * what the continue-watching row holds and what gets marked watched. Picking on
 * the way in is the only moment it is cheap to ask; asking afterwards means
 * someone has already put their evening into the wrong account.
 *
 * Every profile here is PIN-protected in practice, so the pad is the normal path
 * rather than an exception.
 */
export function Profiles(): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const chooseProfile = useApp((s) => s.chooseProfile);
  const fail = useApp((s) => s.fail);
  const failure = useApp((s) => s.failure);
  const go = useApp((s) => s.go);

  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [picked, setPicked] = useState<Profile | null>(null);
  const [pinError, setPinError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!backend) return;
    let live = true;
    backend
      .listProfiles()
      .then((p) => live && setProfiles(p))
      .catch((e) => {
        if (!live) return;
        log.warn("could not list profiles", e);
        fail(classify(e));
      });
    return () => {
      live = false;
    };
  }, [backend, fail, reload]);

  const { ref, focusKey } = useFocusable({ focusKey: "profiles", saveLastFocusedChild: true });
  useInitialFocus(profiles?.length ? `profile-${profiles[0].id}` : undefined, Boolean(profiles));
  // The PIN pad is what this guards against. Leaving it unmounts the key that
  // held focus, and norigin's own recovery walks up to the root and stops there
  // - so without this the list comes back with focus on a key that no longer
  // exists and every press is discarded. Disabled while the pad is open, or it
  // would pull focus out of the pad on the first digit.
  useFocusFallback(
    profiles?.length ? `profile-${profiles[0].id}` : undefined,
    (key) => key.startsWith("profile-"),
    !picked,
  );

  // Which attempt is allowed to write back. Cancelling is possible mid-check -
  // Back is not gated on busy, and gating it would trap someone behind a
  // request that has no timeout - so a reply can arrive after its own pad has
  // gone. Without an owner the late reply either leaves busy set (and the next
  // pad ignores every digit) or writes a wrong-PIN error onto a pad that has
  // not been typed into yet.
  const attempt = useRef(0);

  const start = (p: Profile): void => {
    attempt.current += 1;
    setBusy(false);
    setPinError(undefined);
    setPicked(p);
  };

  const submit = async (pin?: string): Promise<void> => {
    if (!picked || busy) return;
    const mine = attempt.current;
    setBusy(true);
    setPinError(undefined);
    try {
      await chooseProfile(picked.id, pin, picked.name);
    } catch (e) {
      log.warn("profile switch failed", e);
      if (mine !== attempt.current) return;
      // A wrong PIN is the ordinary case, not a failure of the app - it stays on
      // the pad rather than throwing the person back to the list.
      setPinError(t("profiles.wrongPin"));
      setBusy(false);
    }
  };

  if (failure)
    return (
      <Message
        failure={failure}
        onRetry={() => setReload((n) => n + 1)}
        // The household list comes from plex.tv while everything else is asked
        // of the server on the LAN. So a box that is online locally but cannot
        // reach the internet must not be stuck here: carrying on with the saved
        // session leaves the whole library usable, and Settings is where
        // autologin can be turned back on.
        actions={[{ key: "msg-continue", label: t("profiles.continue"), onEnter: () => go({ name: "home" }) }]}
      />
    );
  if (!profiles) return <Message loading />;
  if (profiles.length === 0)
    return (
      <Message
        text={t("profiles.none")}
        actions={[{ key: "msg-continue", label: t("profiles.continue"), onEnter: () => go({ name: "home" }) }]}
      />
    );

  if (picked) {
    return (
      <PinPad
        title={t("profiles.enterPin", { name: picked.name })}
        error={pinError}
        busy={busy}
        onSubmit={(pin) => void submit(pin)}
        onCancel={() => {
          // Back to the face that was opened, not to the first one.
          const was = picked.id;
          attempt.current += 1;
          setBusy(false);
          setPicked(null);
          setPinError(undefined);
          setTimeout(() => setFocus(`profile-${was}`), 0);
        }}
      />
    );
  }

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="flex h-full flex-col items-center justify-center gap-[4vh]">
        <h1 className="text-[3vh] font-semibold tracking-tight">{t("profiles.title")}</h1>
        <div className="flex flex-wrap items-start justify-center gap-[2.5vw]">
          {profiles.map((p) => (
            <Face
              key={p.id}
              profile={p}
              onEnter={() => {
                if (p.pinRequired) {
                  start(p);
                  return;
                }
                // Guarded the same way as the pad: a remote gets pressed twice,
                // and each press was starting its own switch.
                if (busy) return;
                setBusy(true);
                const mine = ++attempt.current;
                void chooseProfile(p.id, undefined, p.name).catch(() => {
                  if (mine !== attempt.current) return;
                  setBusy(false);
                  start(p);
                });
              }}
            />
          ))}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

function Face({ profile, onEnter }: { profile: Profile; onEnter: () => void }): React.JSX.Element {
  const focusKey = `profile-${profile.id}`;
  const { ref, focused } = useFocusableItem({ focusKey, onEnterPress: onEnter });
  const backend = useApp((s) => s.backend);
  const [src, setSrc] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const absolute = Boolean(profile.thumb && /^https?:\/\//.test(profile.thumb));
  const tried = useRef(false);

  useEffect(() => {
    // Avatars are hosted by the account service, not the media server, and that
    // host refuses a credentialed cross-origin fetch - so an absolute URL is
    // linked rather than loaded.
    if (!profile.thumb || absolute || !backend || tried.current) return;
    tried.current = true;
    // Through artUrl, so a relative path resolves against the SERVER. Handed to
    // fetch as it stands, it resolved against the box's own shell origin - which
    // answers with its web page, and takes the token with it.
    const src = backend.artUrl(profile.thumb);
    if (!src) return;
    void loadImage(src, backend.imageHeaders()).then((url) => url && setSrc(url));
  }, [profile.thumb, absolute, backend]);

  const initials = profile.name.slice(0, 2).toUpperCase();
  const image = absolute ? profile.thumb : src;

  return (
    <div
      ref={ref}
      onClick={onEnter}
      // The focus key, in the DOM, the way the SDK's own button carries it:
      // without a marker a navigation test cannot put a rectangle on this
      // element, and a navigation assertion with no rectangles is decided by
      // nothing at all.
      data-sfocus={focusKey}
      className="flex w-[16vh] flex-col items-center gap-[1vh] transition-transform duration-150"
      style={{ transform: focused ? "scale(1.08)" : undefined }}
    >
      <div
        className={[
          "flex h-[16vh] w-[16vh] items-center justify-center overflow-hidden rounded-full bg-white/10",
          focused ? "ring-[0.4vh] ring-white" : "",
        ].join(" ")}
      >
        {image && !broken ? (
          <img
            src={image}
            alt=""
            decoding="async"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-[4vh] text-fg-dim">{initials}</span>
        )}
      </div>
      <span className="w-full truncate text-center text-[2vh]">{profile.name}</span>
    </div>
  );
}
