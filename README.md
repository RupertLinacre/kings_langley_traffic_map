# Kings Langley · Living Town

A standalone, interactive miniature of Kings Langley. Real streets from
OpenStreetMap provide the layout; little vehicles, houses, and trees bring it to
life. Explore the village, adjust the simulation, and plan a journey through its
road network.

## Run locally

Use **Node.js 22 or newer**. There are no npm dependencies to install.

```sh
npm run dev
```

Open <http://localhost:4173>. The server reads the source files directly; refresh
the page after editing them.

```sh
npm run dev -- --host 0.0.0.0 --port 8080
```

The optional host flag makes the app accessible to other devices on your local
network, which is useful for checking touch controls.

## Explore

- Drag to pan; use the wheel or zoom buttons to zoom. On a touch screen, drag with
  one finger and pinch with two.
- Pause and resume the miniature, change its speed, and adjust traffic demand.
- Set cyclists (0–150) and people walking (0–400) independently of motor traffic.
  Riders follow the street network and obey signals; walkers follow connected
  pavements and use simulated zebra crossings where vehicles give way.
- Adjust road width to change how the miniature is drawn.
- Jump between landmarks, or return to the town overview.
- Tap a vehicle to inspect it, or follow the nearest village bus. Dragging the
  map stops following; Escape closes the vehicle details.
- Try Quiet morning, Village life, or Rush hour to change all three populations.
- Choose a start and destination in the route planner. The camera frames the
  whole journey, and you can swap direction to explore one-way streets.
- Save a postcard of the current map as a PNG using the postcard button.
- Copy a view link from “About this little world”. It preserves the map view,
  scenery seed, populations, road width, speed and pause setting. Opening a link
  starts fresh traffic; it does not replay the exact moment it was copied.
- Open Little village explorer to watch drivers take turns on narrow streets,
  follow a walker checking for gaps, go for a bicycle ride, or spot a train.
  You can tap pedestrians as well as vehicles to read what they are doing.
  “Taking turns” also queues a small pair of neighbours from nearby streets,
  giving you a parking encounter to watch when the approaches are clear.
  “Three-point turn” stages a clearly labelled demonstration on a suitable clear
  road: one car briefly stops while another turns and takes a different route.

## Village behaviour

Drivers favour main roads for through journeys. Persistent queues can make a
quieter route worthwhile; drivers keep their destinations and only change route
when the saving is substantial. Some drivers can perform a three-point turn on
a suitable local road when there is room to reserve both directions. Their
forward, reverse and forward movement is shown on the map.
These turns are deliberately rare in ordinary traffic; the explorer demonstration
makes one easy to find, while still checking traffic and pavement clearance.

Based on local observations, parked cars occupy the northwest side of Coniston
Road and the north side of Vicarage Lane between Five Acres and Marwood Close.
These residential rows sit half on the pavement, straddling the kerb.
Drivers take turns using the remaining space. These are parking bottlenecks,
not changes to the mapped legal direction of either road. Parking numbers and
bay spacing are illustrative; the parked rows remain when moving traffic is zero.

Walkers use zebras and suitable unmarked crossing points. Away from zebras, they
wait for a gap in the first direction, avoid the bodies of stopped cars, and
check the second direction independently. They may wait partway through inside
the stopped lane while the other direction clears. Crossing locations and
behaviour are miniature rules.

Two miniature trains follow connected pieces of the surveyed West Coast Main
Line, retaining its bridge layers. The local train pauses near Kings Langley
station. Their colours, frequencies and stopping pattern are illustrative.

The street geometry, one-way roads, and turn restrictions come from the bundled
map snapshot. Traffic demand, vehicle scale, houses, and trees are illustrative;
this is not live traffic or a forecast. The route planner demonstrates the
snapshot's network and is not a navigation service.

The map focuses on Kings Langley: north to Red Lion Lane and Lower Road,
south to the M25 with Watford Road continuing to Langleybury Lane, and the
village-side halves of Hyde Lane, Harthall Lane and Toms Lane. The Belswains
Lane/Bunkers Lane area, Pipit Walk/West Valley Road/Harrier Close, Abbots
Langley and Hunton Bridge have been removed. The extra zebra crossings are
part of the miniature scene; their placement is illustrative.

## Build and deploy

### GitHub Pages

The repository includes `.github/workflows/pages.yml`. It runs the regression
tests, builds `dist/`, and publishes that directory to GitHub Pages whenever
`main` changes. Pull requests run the checks without publishing. No dependencies,
API keys or repository secrets need to be configured.

A repository admin or maintainer must enable Pages once:

1. Open [Settings → Pages](https://github.com/RupertLinacre/kings_langley_traffic_map/settings/pages).
2. Set **Build and deployment → Source** to **GitHub Actions**.
3. Open **Actions → Test, build and deploy to GitHub Pages → Run workflow**,
   select `main`, and run it.

Until Pages is enabled, the workflow still tests, builds and uploads the site,
and records these setup instructions instead of attempting deployment.
After a successful deployment, the site will be at
<https://rupertlinacre.github.io/kings_langley_traffic_map/>.
Later pushes to `main` deploy automatically. Assets use relative paths so the
repository subpath works without a custom domain or build configuration.

### Other static hosts

```sh
npm run build
npm run preview
```

The preview runs at <http://localhost:4174>. It accepts the same `--host` and
`--port` flags as the development server.

Upload the contents of `dist/` to any static web host. Asset paths are relative,
so the app can live at a domain root or under a subpath such as `/living-town/`.
No backend, environment variables, API keys, or external map service are needed.
Serve the files over HTTP; opening `index.html` as a `file://` URL will prevent
the browser from loading the ES modules and JSON normally.

The build copies only the app entry point, favicon, browser source assets, and
Kings Langley data and attribution. It replaces only the fixed `dist/` output
directory and does not modify the source files.

## Architecture

This app uses native JavaScript ES modules and a Canvas 2D renderer. It keeps the
original simulation and miniature drawing code, with a standalone application
shell for navigation and controls. No framework or bundler is required.

- `index.html` and the application files under `src/` provide the standalone UI.
- `src/real-town.mjs` adapts the road network and simulation to miniature scale.
- `src/real-map-renderer.mjs`, `src/real-scenery.mjs`, `src/street-geometry.mjs`,
  and `src/miniature-art.mjs` draw the town.
- `src/kings-langley/engine/` contains routing, demand, vehicle movement,
  junctions, parking, and related traffic rules.
- `src/real-cyclists.mjs` adds riders to the shared vehicle simulation;
  `src/real-pedestrians.mjs` provides the pavement graph, walks and crossings.
- `data/kings-langley/` contains the static road network and synthetic journeys.
- `scripts/` contains the small development server and static build tools.

Run the regression suite with:

```sh
npm test
```

## Provenance

The town was extracted from `RupertLinacre.github.io`, branch
`codex/living-town-2`, commit `1b005d7` ("Render Kings Langley streets as a living
miniature town"). The original website's generative traffic background became
this version's real Kings Langley map, with its miniature visual style retained.

The road snapshot has an OpenStreetMap timestamp of **2026-09-08T05:48:03Z**.
Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
available under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
See [the data provenance notes](data/kings-langley/README.md) for details.
