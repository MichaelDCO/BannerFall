# BANNERFALL

*Hold the vale. Break the horde.*

A medieval tower-defense game built with Three.js — procedural art, deterministic simulation,
three campaigns, free tower placement, elemental warfare, per-run War Omens, hero powers,
road traps, choreographed waves, an endless mode and a daily war. English and French.

**Installable PWA**: works offline after first load, installs to the home screen on phones
(fullscreen, landscape). Three.js 0.170.0 is vendored — no CDN, no build step, no dependencies.

## Play

Serve the folder with any static server and open it in a browser (desktop or phone):

```bash
python -m http.server 8321
```

Then visit `http://localhost:8321/`.

## Features

- **3 campaigns**: The Vale (easy) · Frostfell Pass (hard, twin spawn gates) · Ember Wastes
  (expert, forked road, double-boss finale)
- **7 towers** across four elemental schools (pierce / crush / fire / storm + support), three
  upgrade tiers each, per-tower targeting modes
- **18 enemy types + boss finales** with elemental resistances — no mono-build wins. Five of
  them answer a solved strategy: **wyverns** fly over knights, traps and fire and can only be
  shot by archers, ballistae and storm spires; **gravemolds** split in two when they die;
  **necromancers** raise the wave's own dead as skeletons; **the warded** shrug off the first
  six hits whatever they weigh; **cutpurses** steal gold when they leak
- **Wave choreography** — waves *arrive* as formations (swarms, three-abreast phalanxes,
  stampede pulses, vanguards), one marked wave per road is a **Long Night** that goes quiet and
  then surges a second time, multi-gate roads beat **war drums** at the mouth the horde is
  actually coming out of, and from wave 7 one unit is promoted to a named **Champion**
- **Muster limit**: tower cap, expandable with gold
- **War Omens**: from wave 5, choose one of three seeded wave mutators
- **Hero powers**: Rally of the Vale (summon militia) and Fire of Heaven (telegraphed smite),
  cooldown-gated, free to cast
- **Road traps**: caltrops, tar pits and powder kegs, laid *on* the road where towers cannot go
- **Endless mode**: hold the line past a map's finale for generated waves with scout parties
  probing the gaps between them, best run recorded per road; **Daily War** — one shared map and
  seed for everyone, rotating by weekday
- **Per-run seeds** with elite wave variations and seeded champions for replayability
- **English and French**, auto-detected and switchable in settings
- Full mouse/keyboard + touch controls; ×1/×2/×3 speed, optional auto wave-call; scales from
  phones to desktop

## Controls

Build with the bottom bar (hotkeys 1–7), click/tap to place — the range ring previews before you
spend. Traps go on the road (Z X C), powers are cast from the bottom-left discs (Q W). Drag to
pan, wheel/pinch to zoom. Space pauses, Esc cancels, T cycles targeting, 8–0 picks an omen.
