# Kings Langley snapshot

These files were imported with the living-town implementation from
`RupertLinacre.github.io`, branch `codex/living-town-2`, commit `1b005d7`.
That implementation originally took the network and traffic engine from the
user's local `kings_langley_traffic` project.

`network.json` preserves the OpenStreetMap IDs, points, road directions, levels,
and turn restrictions. Its metadata records:

- OpenStreetMap timestamp: **2026-09-08T05:48:03Z**
- Snapshot fetched at: **2026-09-08T05:51:14.568539+00:00**
- Source: **OpenStreetMap contributors**
- License: **ODbL 1.0**

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
Keep this attribution when redistributing the snapshot or the app.

`demand.json` retains the source project's prepared synthetic journeys and
baseline weights. The miniature uses deliberately enlarged vehicles and
user-controlled demand. Its traffic, bus journeys, houses, and trees are
illustrative, rather than a forecast or a depiction of actual services or
individual buildings.

The imported traffic engine is in `src/kings-langley/engine/` relative to the
repository root. It preserves multi-segment vehicle occupancy, one-way routing,
roundabout priority, signal control, and alternating parking bottlenecks.
`src/real-town.mjs` supplies the miniature's vehicle sizes and controls.

Both JSON files are bundled with the app and served locally. No map API or
runtime data refresh is required. This repository does not include a data
refresh/import pipeline; replacing these snapshots requires compatible network
and demand data from the source project.

## Village boundary

The bundled snapshot is cropped to the village, with **416 road ways, 1,377
 directed edges and 706 graph nodes**. This removes about 54% of the original
road geometry, rather than just hiding it beyond the camera.

- Belswains Lane, Bunkers Lane and the Pipit Walk / West Valley Road / Harrier
  Close neighbourhood are removed. Red Lion Lane and **all of Lower Road**
  remain, including its short northern arm to the former Bunkers Lane junction.
- Abbots Langley and Hunton Bridge's streets are removed. The southern boundary
  follows the M25, retaining junction 20 and its slip roads. Watford Road alone
  continues south to the **Langleybury Lane junction**, including that junction's
  connecting carriageway pieces. The motorway itself ends just beyond its
  southern slip-road merges.
- The village-side half of the main alignment remains for Hyde Lane (**1,241.81
  m**), Harthall Lane (**1,235.18 m**) and Toms Lane (**1,052.67 m**). Small parallel
  access loops are excluded when measuring the main alignment.
- Rail and waterway context is clipped to the village boundary. Apsley station
  is removed; Kings Langley station, the village and both schools remain.

The original graph exporter omitted three connected surveyed spans at the
Toms Lane railway underpass because its nodes have height restrictors. Those
spans are restored from their existing OSM nodes and road shapes, preserving
its **10 ft 9 in maximum height**. This keeps the retained part of Toms Lane
connected to Station Road. Two illustrative car journeys connect it to High
Street; this is not a change to the surveyed street layout.

Original OSM node and way IDs remain wherever possible. Artificial boundary
nodes and any additional fragments of a split way use negative IDs; split
ways retain `sourceWay`, and edges retain `sourceEdge`. Edge IDs are regenerated
as a dense array. Every retained demand path is split into contiguous sections
and remapped to those IDs, so traffic enters and leaves at the cropped edges.
The resulting 4,902 illustrative journey specifications retain their original
weights. Original source metadata and pre-crop counts are preserved.

The crop is reproducible from the **uncropped** source snapshot:

```sh
node scripts/trim-map.mjs /path/to/original-snapshot data/kings-langley
```

The input directory must contain the original `network.json` and `demand.json`.
Source and output must be different directories. Named boundary settings and
measured lane chains live in `scripts/trim-map.mjs`; the output metadata records
the full polygon and exact half-lane endpoints. The script preserves road
layers and directions, clips crossing segments, and removes disconnected
suburban fragments. `tests/map-region.test.mjs` verifies the named exclusions,
half-lane lengths, boundary geometry, graph connectivity and every demand turn.
