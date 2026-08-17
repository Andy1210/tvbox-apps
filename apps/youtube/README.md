# YouTube (tvbox app)

YouTube's own TV page (`youtube.com/tv`) in a hardened window, plus a **DIAL cast
receiver** so a phone can send a video to the box.

## What casting actually is here

DIAL is what a phone's YouTube app uses to reach a television that is not a
Chromecast. The phone sweeps the LAN over SSDP, reads a device description, and POSTs
a launch request carrying a **pairing code**. The receiver puts that code in the url
of the TV page, and **YouTube's own app joins the phone's session from there**.

Nothing in this package talks to YouTube, holds a token, or plays anything. The whole
protocol is `lib/dial.js` (about 200 lines of SSDP + four HTTP routes) and
`plugin.js`, which starts it and turns a launch into `host.navTo("youtube", {query})`.

Measured (2026-08-17): `https://www.youtube.com/tv?pairingCode=…&theme=cl` answers 200
and redirects to `#?reversePairingCode=…`, which is the page taking the session.

## Turning it on

`switches` in the manifest puts **Cast from phone** in Settings → Apps → Extra app
settings. It is **off until somebody turns it on**: an app update can land unattended
overnight, and a release must not open a listening socket on the LAN by arriving.

While it is off the box advertises nothing and binds nothing. A flip takes effect
without a restart, and switching off releases both sockets.

## What it exposes, and to whom

A receiver has to be reachable by an unauthenticated phone, so the bounds are the
design:

|                 |                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Sockets         | `udp/1900` (SSDP) + one TCP port (17954 if free, else any) on `0.0.0.0`                                                                  |
| Browser senders | only YouTube's own origins; any other `Origin` gets 403, and no response carries `Access-Control-Allow-Origin: *`                        |
| Native senders  | send no `Origin` and are unaffected                                                                                                      |
| Launches        | 12 per source per minute on a sliding window, 30 per minute for the box, 2 KB body (counted in bytes), oversized bodies close the socket |
| SSDP replies    | 4 per source per second, 60 overall - per source first, so ordinary noise cannot make the box vanish from everyone's cast list           |
| Sockets held    | 64, with header and request timeouts CHECKED every 2 s (Node's default 30 s let a held socket live half a minute)                        |
| Stop            | advertised as unavailable (`allowStop="false"`, `DELETE` → 501): a sender cannot take the television back to HOME                        |

**Be honest about the rest**, because a switch is a decision the owner makes:

- **Anyone on the same wifi can send to the TV.** There is no confirmation on screen -
  that is how casting works everywhere - so a cast replaces what is playing. The box
  shows a short note when one arrives.
- **A paired sender gets the box's YouTube session.** It chooses what plays, and what
  it plays lands in the history and recommendations of whatever account is signed in
  on the TV.
- **A cast can turn the television on** (the box wakes the panel over CEC, because it
  may have slept it itself). It cannot change the TV's input, so a cast to a set showing
  a console opens YouTube where nobody is looking. The one exception: it will not wake a
  television somebody put on standby in the last 30 seconds.
- **The first ordinary launch after a cast reloads the page clean** (the shell does
  this), so somebody opening YouTube from HOME does not land in the caster's session.
  What that ends is the live session, not the LINK: the page keeps YouTube's own screen
  id in its storage, exactly as a television does, so a phone that has been paired to
  this box before can offer it again.
- **A determined attacker on the LAN can deny discovery.** SSDP is UDP, so its source
  address is free to forge; the budgets keep the box behaving under ordinary noise, not
  under a flood. Somebody who can do that can also flood the group the phone searches
  on, so there is nothing to win here.
- **A local app's own page can turn this switch on.** Local packages are served from the
  shell's own origin, so they pass its same-origin gate; the registry review is what
  stands between an app and that. The switch is a control, not a boundary.
- **On an untrusted network** (hotel wifi, a guest VLAN with no client isolation) this
  is an unauthenticated screen-takeover endpoint exposed to that network. Leave the
  switch off there.

## Known limit

A cast **while YouTube is already on screen** is the one case not verified with a real
phone. A sender that believes the app is running expects to drive it through a lounge
session this receiver cannot publish (the page holds its own screen id, so
`additionalData` is empty), so the receiver reports the app as running only while it is
in the foreground and re-points the page on every launch it does get. If a phone turns
out to skip the launch in that state, casting will need YouTube to be closed first.

## Tests

`node --test apps/youtube/lib/dial.test.js` - the protocol against fake requests, the
origin gate, both budgets, the address chosen for a two-interface box, which SSDP
searches are answered, and one case that binds real sockets. No box needed.
