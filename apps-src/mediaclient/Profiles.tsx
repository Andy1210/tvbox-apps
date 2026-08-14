import { useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { PinPad, useFocusableItem, useI18n } from "@sdk";
import { Message } from "./Message";
import { loadImage } from "./posters";
import { useInitialFocus } from "./focus";
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

  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [picked, setPicked] = useState<Profile | null>(null);
  const [pinError, setPinError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

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
  }, [backend, fail]);

  const { ref, focusKey } = useFocusable({ focusKey: "profiles", saveLastFocusedChild: true });
  useInitialFocus(profiles?.length ? `profile-${profiles[0].id}` : undefined, Boolean(profiles));

  const submit = async (pin?: string): Promise<void> => {
    if (!picked || busy) return;
    setBusy(true);
    setPinError(undefined);
    try {
      await chooseProfile(picked.id, pin);
    } catch (e) {
      log.warn("profile switch failed", e);
      // A wrong PIN is the ordinary case, not a failure of the app - it stays on
      // the pad rather than throwing the person back to the list.
      setPinError(t("profiles.wrongPin"));
      setBusy(false);
    }
  };

  if (failure) return <Message failure={failure} />;
  if (!profiles) return <Message loading />;

  if (picked) {
    return (
      <PinPad
        title={t("profiles.enterPin", { name: picked.name })}
        error={pinError}
        onSubmit={(pin) => void submit(pin)}
        onCancel={() => {
          setPicked(null);
          setPinError(undefined);
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
                if (p.pinRequired) setPicked(p);
                else void chooseProfile(p.id).catch(() => setPicked(p));
              }}
            />
          ))}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

function Face({ profile, onEnter }: { profile: Profile; onEnter: () => void }): React.JSX.Element {
  const { ref, focused } = useFocusableItem({ focusKey: `profile-${profile.id}`, onEnterPress: onEnter });
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
    void loadImage(profile.thumb, backend.imageHeaders()).then((url) => url && setSrc(url));
  }, [profile.thumb, absolute, backend]);

  const initials = profile.name.slice(0, 2).toUpperCase();
  const image = absolute ? profile.thumb : src;

  return (
    <div
      ref={ref}
      onClick={onEnter}
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
          <img src={image} alt="" decoding="async" onError={() => setBroken(true)} className="h-full w-full object-cover" />
        ) : (
          <span className="text-[4vh] text-fg-dim">{initials}</span>
        )}
      </div>
      <span className="w-full truncate text-center text-[2vh]">{profile.name}</span>
    </div>
  );
}
