# Airport locations

In flight mode, enter an ICAO or IATA code in Location search (for example, `KMSP` or `MSP`). Select the airport, choose Departure or Arrival and a runway direction, then press Go. `KMSP arrival` also selects the initial mode. Ordinary coordinate and place searches remain available.

The browser requests one airport and nearby runway centerlines from Overpass. The lookup module is loaded on demand; no airport database or new package is bundled. Successful answers are cached on the device across reloads. Missing airport elevation is requested from FreeAirportDB and cached too. If usable runway geometry or elevation is unavailable, airport Go is disabled; manual coordinates remain available.

Location remembers its search text, results list, loaded nearby-airport groups and their expanded state, selected airport with its runway data, Departure/Arrival choice, runway direction, and coordinate entries in browser storage. Switching tabs, closing the panel, or reloading restores the form and results without searching or moving the aircraft. For example, choosing MSP, Departure, runway 35 leaves that selection ready for Go next time. Editing or repeating a search keeps the current airport selection until another result is selected or Enter coordinates instead is used. Applying coordinate entries keeps them available for reuse. Flight and ordinary globe drafts are separate. The displayed results and selected airport are saved form preferences; they stay available independently of response-cache expiry. Submitting Search again refreshes expired lookup data.

Loaded result groups reopen from their saved children. A group whose load was interrupted offers a Load button after restoration; it does not retry automatically. Selecting a result whose details were already resolved uses the saved detail. For unresolved custom-provider results, only an explicit selection or group load reconstructs its callback from the original submitted query and result IDs; built-in lookups use the response cache as usual. Old form records that saved only text keep that text; submitting Search once fills the new saved results list.

Runway true headings come from geometry, rather than assuming runway numbers are true bearings. Both directions are selectable, with the longest runway listed first. Departure starts 50 m along the selected runway (less for short runways), with C172 ground clearance, zero ground speed, idle throttle and brakes applied. The simulator pauses; resuming releases the brakes unless B is held. Arrival starts 5 NM before the threshold on a nominal 3-degree descent, with a 50-foot threshold crossing height, at 75 knots. This is a basic straight-in preset, not a published arrival procedure or a terrain-clearance calculation. Existing pause state is preserved for arrival.

## API check, 2026-09-07

Requests were made with an Origin header to check CORS responses. These are individual measurements, not service guarantees.

| Endpoint | Airport | Time | Result |
| --- | --- | ---: | --- |
| FreeAirportDB | KMSP | 1.55 s | 200, CORS enabled; coordinates/elevation, no runways |
| overpass-api.de | KMSP | 3.34 s | 200, CORS enabled; 4 runways / 8 directions |
| overpass-api.de | EGLL | 2.11 s | 200; 2 runways / 4 directions |
| overpass-api.de | NZQN | 11.57 s | 200; 2 runways / 4 directions |
| overpass.kumi.systems | KMSP | 25 s | Timeout |

The main Overpass endpoint was selected. An earlier run interrupted by laptop sleep was excluded. Requests time out and can be cancelled by editing the search or closing the panel. No API keys or backend are used.

Validation includes airport parsing, runway direction and threshold handling, spawn geometry, request cancellation/cache behavior, React selection/Go flow, flight reset tests, both projects' CI, and a local run against the actual JSBSim WebAssembly engine for departure and arrival.

Sources: [Overpass browser support](https://dev.overpass-api.de/command_line.html), [OSM airports](https://wiki.openstreetmap.org/wiki/Tag:aeroway%3Daerodrome), [OSM runways](https://wiki.openstreetmap.org/wiki/Tag:aeroway%3Drunway), [FreeAirportDB](https://freeairportdb.com/api), [JSBSim initial conditions](https://jsbsim-team.github.io/jsbsim/classJSBSim_1_1FGInitialCondition.html).

## City search and reusable results

`nyc`, `msp`, `new york`, and `dallas` are sent unchanged to Nominatim. No alias or city database is packaged. Cities receive an expandable Airports nearby group; the first group loads automatically while other groups load on expansion. The city button remains usable during airport loading and errors. If the top geocoder match is an airport, its returned city/state/country address is used for a second structured geocoder request, retaining the direct airport result.

Nearby summaries come from FreeAirportDB within an 80 km radius, up to 50 records. Active airport types are filtered and ranked large, medium, then small, with distance breaking ties; the first 12 are shown. Helicopters and seaplane bases are omitted. Full Overpass runway geometry is fetched only when an airport is selected in flight mode. Nearby does not imply administrative containment.

The shared provider is exported as `searchLocations` from `foss-earth/shell`; `nearbyAirports` is also exported. `LocationSearchResult` supports optional `kind`, `childrenLabel`, `loadChildren(signal)`, and `resolve(signal)` fields, so importing applications can supply their own grouped providers without changing the panel. Existing flat providers still work. All new grouping, geocoding, nearby lookup, cache and cancellation logic lives in foss-earth; the existing flight host still owns aircraft actions.

Search runs on submission, not keystrokes. Geocoder calls are serialized at least 1.1 seconds apart, with 20-second network timeouts. Place, nearby-airport, runway and elevation responses use a persistent browser cache, including successful empty results. The Interface tab's Search settings control response retention (24 hours by default), total answers kept (64 by default), and request timeout. Repeated cached lookups do not contact the services; simultaneous identical lookups share their request. Failed and cancelled responses are not cached. Editing the query or closing a result aborts pending work. Invalid stored data is ignored, and lookup/editing still work if browser storage is unavailable or full; persistence is then limited by what the browser permits. Clearing this site's browser data also clears the remembered form and caches.

Live end-to-end checks on 2026-09-07 returned NYC with LGA/EWR/JFK, MSP with a Minneapolis city group and a direct MSP match, New York with its city group, and Dallas with DAL/DFW. These checks used the implemented provider and its lazy child loader, not a prebuilt list.
