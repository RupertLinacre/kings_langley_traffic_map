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
user-controlled demand. General traffic, houses and trees are illustrative,
rather than a forecast or a depiction of individual buildings. Bus service
routes and stop coordinates now come from the separate Intalink snapshot below.

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

## Bus routes and boarding points

`src/bus-service-data.mjs` is a static snapshot reviewed on **2026-10-02**. It
uses Intalink's published service timetables, route-shape GeoJSON and stop
GeoJSON. Stops retain their ATCO identifiers, geographic coordinates and source
bearing; approach direction is reconciled with the published route trace and
the directed OSM graph. The retained village has **55 published boarding-point
records** served by the verified public services 322, 501, H19, R9 and KL80.

Sources:

- [322: Hemel Hempstead–Rickmansworth](https://www.intalink.org.uk/services/d47eb11a-c3a1-4885-99bf-c27dcfbec504)
- [501: Aylesbury–Watford, within the combined 500/501/X500 timetable](https://www.intalink.org.uk/services/ff60737f-005e-40e3-935a-046e6fa21e83)
- [H19: Kings Langley–Hemel Hempstead](https://www.intalink.org.uk/services/bb104f50-c51d-45a0-9edc-6223464d7ecd)
- [R9: Chipperfield–North Watford](https://www.intalink.org.uk/services/64c02153-40d3-4c9c-b1cf-0b1e64490bb1)
- [KL80: Kings Langley School service](https://www.intalink.org.uk/services/2769ffb2-e9ff-4747-8ea2-3023d3ac5a14)
- [Red Eagle operator service information](https://redeagle.org.uk/bus-services/)

Each service URL exposes `/stops` and `/shapes` endpoints. The source URLs,
operating days and import notes are also retained in the bundled data module.
Only 501's Sunday/public-holiday pattern reaches Kings Langley: 500 and X500
terminate at Hemel Hempstead. H19 runs Tuesdays/Thursdays, R9 runs
Mondays/Wednesdays/Fridays, and KL80 runs on schooldays. The miniature combines
these services for viewing, compresses regular headways sixfold, and gives the
limited/school services an illustrative repeat interval. Stops are served with
illustrative 12–30 second dwells. It does not query live bus data at runtime.

Official journeys that leave the cropped road graph are represented by their
separate retained sections. The import never invents a shortcut through removed
Abbots Langley streets. Toms Lane service sections use an explicitly low,
illustrative minibus profile that fits its mapped 10 ft 9 in underpass;
operator fleet heights have not been verified.

H19's published shape turns into Coniston Road before reaching the published
southbound “opp Coniston Road” stop, about 28 m beyond the junction. Its marker
and the 322/501 calls retain their correct position; the incompatible H19 call
is omitted. Duplicate H19 trace sections are normalized, and its Round Wood
turnaround is represented as separate arrival/departure sections because the
graph cannot perform that bus reversal. The school grounds are not drivable in
the snapshot, so KL80 uses the nearby mapped road for its school boarding point.

`scripts/import-bus-services.mjs` compiles a reviewed geographic snapshot onto
the bundled graph. Run it with the snapshot's explicit JSON path; fetching and
reviewing the source data is a separate step. Importing new data requires checking
source discrepancies and legal graph turns before replacing the bundled module.
