# TorqueForge

A car builder in the style of BuildCores/PCPartPicker, with a physics test track.

## Download

Get the latest version from **[Releases](https://github.com/croatianshrimp/torqueforge/releases/latest)**:

| System | File |
|---|---|
| **Windows 10 / 11** | `TorqueForge-…-Windows-Setup.exe` (installer) or `…-Windows-portable.exe` (no install, just run it) |
| **Debian / Ubuntu / Mint / Pop!_OS** | `TorqueForge-…-linux-amd64.deb` → `sudo apt install ./TorqueForge-*.deb` |
| **Fedora / Nobara / RHEL / openSUSE** | `TorqueForge-…-linux-x86_64.rpm` → `sudo dnf install ./TorqueForge-*.rpm` |
| **Any Linux** | `TorqueForge-…-linux-x86_64.AppImage` → `chmod +x` it and run |
| **Mac (Apple Silicon M1–M4)** | `TorqueForge-…-mac-arm64.zip` |
| **Mac (Intel)** | `TorqueForge-…-mac-x64.zip` |

- **Windows:** SmartScreen may say "Windows protected your PC" because the app isn't code-signed. Click **More info → Run anyway**.
- **Mac:** the app isn't signed either. Unzip it, move it to Applications, then **right-click → Open** the first time. If macOS says it's damaged, run `xattr -cr /Applications/TorqueForge.app` in Terminal.

**From source:** `npm install` once, then `npm start` (desktop) or `./run.sh` (browser at http://127.0.0.1:8765).
Build the downloads with `npm run dist:linux`, `npm run dist:win`, `npm run dist:mac`.

## What's in it
- **80 cars**, with several generations of the same model lines (Miata NA→ND, Supra A70→A90, Skyline R32→R35, Civic EG→FL5, Mustang Fox→S650, Corvette C5→C8, M3 E30→G80 …). The garage shows a generation switcher under the car name; the car picker can sort by model line. JDM, Euro, US muscle, supercars, a truck and an EV. Each has real-world specs (mass, wheelbase, weight distribution, engine, gear ratios, Cd/frontal area, bolt pattern, wheel and tire fitment).
- **5,900+ parts** in 21 categories: 89 engine swaps (proven kits bolt in; others are custom jobs with a fabrication cost if the engine fits), 33 forced-induction kits (turbos, twin-turbos, roots / twin-screw / centrifugal superchargers incl. ProCharger, Vortech, Whipple, Kenne Bell — each with its own boost curve), engine internals (forged pistons/rods, billet crank, stroker, ported heads, cams, valve springs, valves, head studs, blueprinting, dry sump — they raise power, redline and how much boost the bottom end survives), tunes, intake, exhaust, fuel, cooling, clutch/gearbox, driveline, diffs, final drive, wheels (generated per size), tires (generated per size and compound), suspension, bracing, brakes, front aero, wings, body kits and weight reduction.
- **Prices**: these are estimated average market prices (Nov 2026) built into `js/data.js`. Each part has **eBay sold** and **Shop** links that open live searches. Each car has listing and Bring-a-Trailer links.
- **Upgrade shop**: click a category to open the shop next to the car. Hover a part to preview it on the car; the camera moves to that part. Cards show the stat changes (hp, weight, grip, downforce, drag, braking, PI) and a Street/Sport/Race/Pro tier. Every build gets a performance index and class (D, C, B, A, S1, S2, X).
- **Compatibility checks**: bolt pattern, wheel diameter range, brake-kit clearance, tire/rim width, fender clearance (widebody adds room), tire diameter vs stock, swap kits per chassis, FI kit vs engine layout/aspiration, fuel system capacity, intercooler need, clutch/gearbox torque rating, EV-only and ICE-only parts, and truck-specific parts.
- **Paint shop**: 16 swatches + custom colour, finishes (gloss, metallic, pearl, candy, satin, matte, chrome), racing / side stripes in any colour (follow the real body), wheel colours.
- **Dyno run**: animated chassis-dyno pull with live hp/torque curves vs stock, crank and wheel hp, engine note.
- **Wind tunnel**: smoke streamlines over the actual built car (wings, splitters and widebody included), coloured by flow speed, with drag/downforce arrows and Cd, CdA, drag hp and front/rear downforce readouts.
- **Interiors follow the build**: bucket seats and stripped interiors cut out the stock seats and fit carbon buckets with harnesses, a bare floor, extinguisher; cages show in cockpit view.
- **3D models**: real car models from Sketchfab (see `assets/cars/CREDITS.md`), auto-processed: scaled to the real car's length, wheels cut out and replaced by the wheels/tires/brakes you pick, paint recolourable, brake lights wired up, Low/High detail levels. Cars without a model fall back to a generated body. Visual mods are fitted to each model's measured body (`js/bodymods.js`): the widebody kit pushes the real fenders and sills out and adds riveted overfenders; splitters, lips and diffusers follow the bumper outline at the bumper's real height; canards sit on the bumper corners; wings mount on the measured trunk or hatch (and tilt with the wing-angle slider); louvres follow the hood; carbon hood/roof/trunk/doors re-skin just that panel; roll cages fit the cabin. Wheel design, colour, size, tire width, caliper colour and ride height change too.

## Physics (`js/physics.js`)
- Four-wheel model with combined-slip tire curves, load sensitivity, and longitudinal + lateral weight transfer (CG height, track, roll balance)
- Engine torque curves shaped by aspiration (NA / turbo spool / supercharger / EV), with a gearbox, shift times and clutch slip at launch
- Rotational inertia of the engine and flywheel (through the gear ratio) and of the wheels and tires, so lightweight wheels matter
- Driven wheels: FWD / RWD / AWD split; open diff, LSD or spool behaviour
- Aerodynamics: drag from Cd·A with wind (head, tail and cross, with gusts), downforce split front/rear, and induced drag
- **Dirty air**: follow the pace car and you lose up to 48% of your downforce in its wake, but you also gain a slipstream
- Brakes with heat build-up and fade, plus ABS, traction control and stability control (all toggleable)

Tests: 0–60 (1-ft rollout), 0–100 km/h, ¼ mile + trap, top speed, 100–0 braking, 61 m skidpad, and a quasi-steady-state lap sim of the 2.48 km test circuit.

## Test track controls
Automatic: W/↑ throttle · S/↓ brake/reverse. **Manual** (default for manual-gearbox cars): ↑ throttle · ↓ brake · **W shift up · S shift down**.
A D/← → steer · Space handbrake · C camera · R restart (respawn in online races). A gamepad works too.
Cameras: chase, chase far, cockpit (shows the build's interior), hood, bumper, TV trackside, helicopter.

## Sound (`js/sound.js`, `js/engine-worklet.js`)
Engines are synthesised live (AudioWorklet): every cylinder fires at its real crank angle into its own exhaust bank, so a cross-plane V8 burbles, a flat-plane V8 / V10 / V12 screams, unequal-length Subaru EJ headers rumble, rotaries brap, inline-6s are smooth, Hondas hit VTEC, the Cummins clatters. The build changes it: exhaust (cat-back, titanium, straight pipe), intakes / ITBs, cams (lumpy idle), tunes (overrun pops and bangs), rev limiter, turbo whistle + blow-off valve, roots / twin-screw / centrifugal supercharger whine, EV motor whine. Also: shift cuts (sequential / DCT cracks), wind, road, gravel, kerb rumble, tire squeal, crashes, AI and online cars' engines (positional), race countdown, lap / medal / finish chimes, impact wrench / ratchet / spray-can sounds in the garage, dyno roller and wind-tunnel fan. One Sound switch (test-track sidebar) mutes everything.

## Game modes
Single player: free drive, **time attack** (gold/silver/bronze targets from the build's simulated lap), **race vs AI** (1–7 opponents with their own builds, matched to your PI and the rules; easy → alien), pace-car chase, drag strip.
**Rules** (price limit $20k–$300k, class limit D–S2) apply to races, time attack and online lobbies; illegal builds can't start.
**Online with friends** (`js/net.js`): one player hosts and gets a 5-letter room code, friends join with it (peer-to-peer WebRTC via the free PeerJS signalling server — no server of ours). The host picks track, race (laps) or time attack (minutes) and the rules; everyone else's build is checked against them. Cars are interpolated, solid, and show each player's build and paint.

## Collisions (`js/collide.js`)
Rigid-body impulses with restitution and friction at the contact corner: armco, tire walls (softer), concrete walls, the pit wall and grandstand wall, and car-to-car contact (AI and other players). Hits scrub speed, yaw the car, shake the camera and invalidate the lap.

## Tracks (`js/track.js`, `js/trackscene.js`)
TorqueForge Park (2.5 km club circuit), Northwind GP (3.7 km), Harbour Street Circuit (1.7 km, walls on the track edge, city blocks), Speedway Oval (1.9 km). All share the pit lane, grandstand and drag strip.
All procedural: rubbered-in racing line and braking zones on the asphalt, raised curbs, gravel traps outside the fast corners (low grip, heavy drag), armco and tire walls, pit lane + garages + control tower, a grandstand with a crowd, catch fences, start gantry with lights, sponsor boards, braking boards, marshal posts, pine and broadleaf forests, distant hills.

## Graphics presets
| Preset | Meant for | Measured (1600×940, 8-car AI race on Northwind GP, full scenery) |
|---|---|---|
| Low | Integrated GPUs, Apple M1 (target 60 fps) | 99 fps on a Ryzen 7800X3D's integrated Radeon (much slower than an M1) |
| Medium | Midrange | 70 fps on that same integrated GPU |
| High | Modern discrete GPU (target 144 fps) | 199 fps on an RX 9070 XT (≈770 fps in free drive) |
| Ultra | High end | 174 fps on an RX 9070 XT |

Dynamic resolution (on by default) lowers render scale briefly to hold the target frame rate.

## Car model pipeline
1. `assets/cars/picks.json` — which Sketchfab model to use per car (chosen by `tools/find_models.py` + manual review).
2. `node tools/fetch_models.mjs [carId…]` — downloads (token in `~/.config/torqueforge/sketchfab_token`) and runs
   `tools/process_model.mjs`, then `tools/build_index.mjs`. Flags per car in picks.json: `--flip` (front/back wrong), `--rot90`, `--keep-wheels`.
3. `node tools/preview.mjs <dir> [ids]` renders a contact sheet for checking (needs `./run.sh` running).

## Dev
`node tools/selftest.mjs` runs every car through every sim and every part through the compatibility checks.
`tools/cdp.mjs` is a small headless-Chrome driver used for screenshot smoke tests.
