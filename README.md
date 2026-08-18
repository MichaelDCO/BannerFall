# BANNERFALL

*Hold the vale. Break the horde.*

A medieval tower-defense game built with Three.js — procedural art, deterministic simulation,
four campaigns, free tower placement, elemental warfare, per-run War Omens, hero powers,
road traps, choreographed waves, a persistent War Council, 28 Deeds, endless / daily / horde
modes. English and French.

**Installable PWA**: works offline after first load, installs to the home screen on phones
(fullscreen, landscape). Three.js 0.170.0 is vendored — no CDN, no build step, no dependencies.

The title screen paints in a fraction of a second; the vale is forged behind it against a real
progress bar that names what it is doing, and the tab stays responsive the whole way down.

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
spend. Traps go on the road (Z X C), powers are cast from the bottom-left discs (Q W). Space
pauses, Esc cancels, T cycles targeting, 8–0 picks an omen. The full sheet is in-game: press
**H**, or click the key disc.

### Camera

| | |
|---|---|
| **Pan** | `↑ ↓ ← →` or the **WASD** cluster, held — smoothed, and it coasts to a stop |
| | Drag with the left button, or one finger |
| **Turn** | `,` and `.`, or **drag with the right button** (a right *click* still just cancels) |
| **Zoom** | Wheel, or pinch |

Pan keys are read by physical position, so a French AZERTY keyboard gets **ZQSD** with no
setting to change — the in-game sheet prints whichever cluster your layout actually has. The
power hotkeys keep priority over the camera, so on QWERTY `W` casts Fire of Heaven rather than
panning; the arrows always pan.

The **first wave never musters on its own**: the horn reads "Begin the Battle" and waits until
you have built in peace. From wave 2 the countdown behaves as it always did — unless you switch
auto-call on, in which case wave 1 musters like every other wave.

## Settings

The gear in the top bar opens Settings: sound, **Detail**, **Frame cap**, auto-call, language,
and Restart Campaign.

### Detail

Three tiers and an Auto, each row printing exactly what it changes rather than making you guess:

| tier | shadow map | bloom | prop scatter | pixel ratio |
|---|---|---|---|---|
| **Low** | 1024 | off | 55% | ×1.5 |
| **High** | 2048 | on | 100% | ×2 |
| **Ultra** | 4096 | on | 100% | ×2 |

**Auto** is the fourth row and the default. On its first load it spends a second and a half of the
title screen timing real frames, picks the tier this machine can actually hold, and remembers it —
the row then tells you what it decided. An explicit choice is never overridden by it. Changing the detail rebuilds the vale, so **the page reloads** — and
your run is saved and restored across it, so the switch costs nothing (same for the language
toggle).

### Frame cap

**60** or **30** drawn frames a second. Thirty spares the battery and the heat on a phone. It
caps *drawing* only — the battle keeps its own clock, so the simulation, the balance and the ×1/
×2/×3 speeds are identical at either setting.

## Saving and resuming

There is nothing to save by hand. At every wave boundary — when a wave breaks, and when you
sound the horn — the run is written to your device: the purse, the garrison with each tower's
tier and orders, the traps on the road, the lives, the omen, the War Council's grades. The title
screen then offers **"Resume the battle"** with the road, the wave and the purse named on it, and
Play becomes **"New campaign"** so it is clear which of the two throws the run away.

A resumed run restarts at that wave's muster, so the wave you were in the middle of is fought
again. Suspending the app, losing the tab, switching detail or language, or having the phone take
the GPU away mid-battle are all the same thing to it. That last case is handled live rather than
by reloading: if the graphics context is lost, the vale is veiled, the forge is relit behind it,
and the battle resumes where it stood — camera heading included.
