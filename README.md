# BANNERFALL

*Hold the vale. Break the horde.*

A medieval tower-defense game built with Three.js — procedural art, deterministic simulation,
four campaigns, free tower placement, elemental warfare, per-run War Omens, hero powers,
road traps, choreographed waves, a persistent War Council, 28 Deeds, endless / daily / horde
modes. English and French.

**Installable PWA**: works offline after first load, installs to the home screen on phones
(fullscreen, landscape). Three.js 0.170.0 is vendored — no CDN, no build step, no dependencies.

## Play

Serve the folder with any static server and open it in a browser (desktop or phone):

```bash
python -m http.server 8321
```

Then visit `http://localhost:8321/`.

## Features

- **4 campaigns**, each unlocked by holding the one before it: The Vale (easy) · Frostfell Pass
  (hard, twin spawn gates) · Ember Wastes (expert, forked road, double-boss finale) ·
  **The Barrowmoor** (legend, 16 waves — *"the moor keeps its dead poorly, bring fire"*)
- **The Risen** — the Barrowmoor's rule. On the cursed waves (5, 9, 13) every non-elite killed
  stands back up 2.5 s later at its own corpse: a spectral copy at 45% health. From wave 7 a
  seeded slice of every ordinary wave carries the curse individually, marked by a wisp.
  **A fire killing blow burns the corpse** — nothing rises from ash, and necromancers are
  denied it too. Finale: **the Barrow King**, who raises every unburned body within 12 u every
  nine seconds while he walks
- **7 towers** across four elemental schools (pierce / crush / fire / storm + support), three
  upgrade tiers each, per-tower targeting modes
- **20 enemy types + 5 boss finales** with elemental resistances — no mono-build wins. Six of
  them answer a solved strategy: **wyverns** fly over knights, traps and fire; **gravemolds**
  split in two when they die; **necromancers** raise the wave's own dead as skeletons; **the
  warded** shrug off the first six hits whatever they weigh; **cutpurses** steal gold when they
  leak; and **the Hexbinder** — a horde sorcerer whose pulse *silences every tower within 9 u
  for three and a half seconds*, so a battery camped on a junction goes dark all at once while a
  spread line loses only a slice. Knights, militia, road traps and hero powers all keep working
  through a hex: the answer is the rest of your army
- **Wave choreography** — waves *arrive* as formations (swarms, three-abreast phalanxes,
  stampede pulses, vanguards), one marked wave per road is a **Long Night** that goes quiet and
  then surges a second time, multi-gate roads beat **war drums** at the mouth the horde is
  actually coming out of, and from wave 7 one unit is promoted to a named **Champion**
- **Muster limit**: tower cap, expandable with gold
- **War Omens**: from wave 5, choose one of three seeded wave mutators
- **Hero powers**: Rally of the Vale (summon militia) and Fire of Heaven (telegraphed smite),
  cooldown-gated, free to cast
- **Road traps**: caltrops, tar pits and powder kegs, laid *on* the road where towers cannot go
- **The War Council** — a persistent parchment talent tree off the map chooser, paid for in
  **laurels** won by stars, first victories, endless records, daily wars and Deeds. Three
  branches of three tiers: Quartermaster (a fuller opening purse), Drillmaster (tougher knights
  and militia), Engineer (a better dismantle refund, cheaper traps). Respec is free
- **28 Deeds** (FR «Hauts faits») in four registers — Campaign, Doctrine, Feats, Collection —
  each worth one laurel, with a chronicle screen and an unlock toast
- **Three modes per road**: Campaign · **Endless** (hold past the finale for generated waves,
  best run recorded) · **Horde** (eight waves, every one a flood, up to ~1,000 bodies alive on
  desktop, compressed economy, no finale boss — the last wave *is* the boss). Plus the
  **Daily War**: one shared map and seed for everyone, rotating by weekday
- **Per-run seeds** with elite wave variations and seeded champions for replayability
- **English and French**, auto-detected and switchable in settings
- Full mouse/keyboard + touch controls; ×1/×2/×3 speed, optional auto wave-call; scales from
  phones to desktop

## Controls

Build with the bottom bar (hotkeys 1–7), click/tap to place — the range ring previews before you
spend. Traps go on the road (Z X C), powers are cast from the bottom-left discs (Q W). Drag to
pan, wheel/pinch to zoom. Space pauses, Esc cancels, T cycles targeting, 8–0 picks an omen.

The **first wave never musters on its own**: the horn reads "Begin the Battle" and waits until
you have built in peace. From wave 2 the countdown behaves as it always did — unless you switch
auto-call on, in which case wave 1 musters like every other wave.
